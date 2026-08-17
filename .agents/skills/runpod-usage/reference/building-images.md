# Building container images for Runpod

How to think about building an image for Runpod: pick the right base, layer for speed,
decide what to **bake in** vs **mount at runtime**, and match the **image contract** to your
target (pod vs serverless queue vs serverless load-balanced). CLI mechanics (login, tag,
push) live in [companion-clis docker](../../companion-clis/reference/docker.md) and
[docker.md](docker.md); this is the strategy layer.

## Start from an official Runpod base image

**For a GPU workload, build `FROM` an official `runpod/pytorch:<tag>` image.** Two reasons:

- **torch/CUDA already match Runpod hosts**, so you don't fight driver/toolkit mismatches.
- **Runpod pre-caches official base images on its hosts.** The base layers are effectively
  already on the machine, so they don't re-download at pull time — you only ship the layers
  you add on top. Starting from a random public base throws that away.

**Exceptions (both shown in the golden paths):** a trivial CPU-only workload may use a slim
base (e.g. `python:3.11-slim`) — see [GP23](../../runpod/golden-paths/23-minimal-queue-image/README.md);
and if you build from a **non-Runpod base you must reproduce SSH yourself** for pods (see the
SSH section below and [GP22](../../runpod/golden-paths/22-minimal-pod-image/README.md)).

Then, whatever the base:

- **Pin an exact tag**, e.g. `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` — for
  reproducible builds.
- **Build for x86_64:** `docker build --platform=linux/amd64 …` — Runpod hosts are x86_64
  (see [docker.md](docker.md)).

## Layer for fast, cacheable pulls

Order layers **least- to most-frequently-changing** so a code edit doesn't invalidate the
heavy dependency layers, and independent layers pull in parallel:

1. base image (`FROM runpod/pytorch:…`)
2. system deps (`apt-get …`)
3. Python deps (`pip install …`)
4. **your code last**

Unchanged layers are reused from cache; only the layers after your edit rebuild/re-pull.

## Dockerfile best practices

- **`.dockerignore`** — exclude `.git`, virtualenvs, datasets, local caches so the build context stays small and pushes fast.
- **Cache the dependency layer** — `COPY requirements.txt` and `pip install` *before* you `COPY` your code, so a code edit doesn't reinstall everything:
  ```dockerfile
  COPY requirements.txt .
  RUN pip install --no-cache-dir -r requirements.txt
  COPY . .
  ```
- **Shrink the image** (smaller = faster pull + cold start) with concrete steps: `apt-get install --no-install-recommends …` then `rm -rf /var/lib/apt/lists/*`; `pip install --no-cache-dir`; use a **multi-stage** build when heavy build tools aren't needed at runtime.
- **BuildKit cache mounts** for fast rebuilds: `RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt`.
- **Never bake secrets** into layers (API keys, tokens) — layers are extractable; pass secrets as runtime env.
- **`ENV PYTHONUNBUFFERED=1`** — so logs stream unbuffered. (Pin the base image tag too — see above.)

## Don't clobber the base image's startup (SSH / web terminal) — **pods**

Official `runpod/pytorch` images ship `CMD ["/start.sh"]`, and **that script is what makes a
pod usable**: it reads `$PUBLIC_KEY` into `~/.ssh/authorized_keys`, runs `ssh-keygen -A`,
starts `sshd`, and brings up the web terminal / Jupyter. It also runs `/pre_start.sh` before
and `/post_start.sh` after, if those exist.

**Rule (pods):** any custom `CMD`/`ENTRYPOINT` **must invoke `/start.sh`** — inherit it, or run
`/start.sh &` before your workload. **Exception:** serverless images are exempt (no SSH).

Why: if a custom `CMD`/`ENTRYPOINT` doesn't chain `/start.sh`, none of that startup runs — you
get **no SSH, no web terminal**, and can be locked out of the pod. For a pod this is the #1
footgun.

Three safe patterns, in order of preference:

1. **Don't override `CMD` at all** (default — use this unless you need your own foreground
   process). Add your layers, leave `CMD ["/start.sh"]`. Do per-pod work via the env-driven
   hooks the base already runs:
   ```dockerfile
   FROM runpod/pytorch:<tag>
   COPY post_start.sh /post_start.sh   # base runs this AFTER sshd is up
   RUN chmod +x /post_start.sh
   # no CMD — inherit the base's /start.sh
   ```
2. **Override only if you need your own foreground process** (a long-running service as PID 1):
   call the base start first, then `exec` your workload:
   ```dockerfile
   COPY run.sh /run.sh
   RUN chmod +x /run.sh
   CMD ["/run.sh"]
   ```
   ```bash
   #!/usr/bin/env bash
   /start.sh &        # SSH + web terminal (base startup), backgrounded
   sleep 2
   exec python -u my_service.py   # your long-running workload in the foreground
   ```
3. **From a non-Runpod base, reproduce SSH yourself** (only if you can't start from
   `runpod/pytorch`). Minimum to not get locked out of a pod:
   ```dockerfile
   RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
       && rm -rf /var/lib/apt/lists/*
   COPY start.sh /start.sh
   RUN chmod +x /start.sh
   CMD ["/start.sh"]
   ```
   ```bash
   #!/usr/bin/env bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   [ -n "$PUBLIC_KEY" ] && echo "$PUBLIC_KEY" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   ssh-keygen -A                       # host keys
   service ssh start                   # or: /usr/sbin/sshd -D
   exec "$@"                            # then your workload (or keep sshd in foreground)
   ```

Reference implementation: `justinwlin/Runpod-GPU-And-Serverless-Base` (a dual pod+serverless
base) and the vendored `start.sh` in
[golden path 09](../../runpod/golden-paths/09-custom-serverless-dev-loop/README.md). Worked
end-to-end in [golden path 22 — minimal pod image](../../runpod/golden-paths/22-minimal-pod-image/README.md).

## Bake in vs mount at runtime (this drives startup speed)

Only the **image** (and whatever is baked into it) lands on the host's **local disk** — fast.
When a **network volume** is attached it takes over the working directory (`/workspace` on a
pod, `/runpod-volume` on serverless); anything written there lives on **networked storage**,
which is slower — **especially for many small files**.

Live proof that this is a real filesystem boundary (baked = `overlay`/local, volume =
`fuse`/MooseFS network mount): [golden path 25 — bake vs mount](../../runpod/golden-paths/25-bake-vs-mount/README.md).

- **Bake into the image:** packages, libraries, and lots of small static files → local, fast.
- **Mount a volume:** large/few files (model weights, datasets), anything that must persist
  across pods, or data you stream/live-load.
- **High-throughput / I/O-bound training:**
  - **temporary / one-off run** → a **pod using local (non-network) storage** is fastest;
  - **persistent, many small files, or I/O-bound** → a **high-performance network volume**.

  See [golden path 21 — storage tiers](../../runpod/golden-paths/21-storage-tiers.md).

## Match the image contract to the target

| Target | Needs a handler? | Entry point |
| --- | --- | --- |
| **Pod** | No | your `CMD`/entrypoint — a long-running service; bind `0.0.0.0`, expose ports |
| **Serverless — queue-based** | **Yes** | `runpod.serverless.start({"handler": handler})` |
| **Serverless — load-balanced** | No (different contract) | your own **HTTP server** exposing routes (no queue handler) |

Minimal runnable image per contract (each built + deployed live): pod →
[golden path 22](../../runpod/golden-paths/22-minimal-pod-image/README.md), queue →
[golden path 23](../../runpod/golden-paths/23-minimal-queue-image/README.md), load-balanced →
[golden path 14](../../runpod/golden-paths/14-load-balancing-endpoint.md).

Queue vs load-balanced request/response shapes and when to pick each are covered in
[endpoint-workflows.md](endpoint-workflows.md) and golden paths
[12 (streaming)](../../runpod/golden-paths/12-serverless-streaming.md),
[14 (load-balancing)](../../runpod/golden-paths/14-load-balancing-endpoint.md), and
[17 (WebSocket)](../../runpod/golden-paths/17-serverless-websocket.md). One image can be
**dual-mode** (pod dev + serverless) — see
[golden path 09](../../runpod/golden-paths/09-custom-serverless-dev-loop/README.md).

## Test locally before deploying

- Build for the right platform: `docker build --platform=linux/amd64 …`.
- **Queue handler:** run the container and invoke `handler.py` locally (the dual-mode
  `python handler.py` loop in [golden path 09](../../runpod/golden-paths/09-custom-serverless-dev-loop/README.md))
  before pushing.
- **Load-balanced:** run the container and hit the HTTP routes locally.
- Then push ([companion-clis docker](../../companion-clis/reference/docker.md)) and deploy
  (runpodctl or runpod-mcp).
