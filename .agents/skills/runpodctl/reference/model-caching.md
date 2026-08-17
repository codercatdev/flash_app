# Getting a model to a serverless worker

Four ways to make model weights available to a Runpod serverless worker. Pick by
where the weights come from, how large/private they are, and how often they change.

| Method | How | Best when | Cold start |
|--------|-----|-----------|-----------|
| **Bake into image** | `COPY`/download during `docker build`, push to a registry | small/private weights; fully reproducible image | fast (in image) but bloats pulls |
| **HF model cache** (`--model-reference`) | point the endpoint at a HuggingFace model URL; Runpod caches it host-side | the model is already on HuggingFace (public/gated/private) | fastest — host-cached, no download billing |
| **Network volume** | pre-load weights onto a DC-pinned volume, mount it | large weights reused across workers; you manage the files | fast once populated; volume is pinned to one data center |
| **Model Repository** (`runpodctl model`) | upload your **own** artifacts to Runpod-managed, versioned storage | private/custom models not on HuggingFace, without image bloat or a DC-locked volume | managed + host-distributed |

Rule of thumb: on HuggingFace → **HF cache**; your own artifact → **Model Repository**
(or a network volume if you want to manage the filesystem yourself); need a fully
reproducible image or system libs baked in → **bake**.

## HF model cache — `--model-reference`

Attach a HuggingFace model to an endpoint by full URL with a ref; Runpod caches it on
the host so the worker loads it directly — no bake, no volume.

```bash
runpodctl serverless create --template-id <id> --gpu-id "NVIDIA GeForce RTX 4090" \
  --model-reference https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct:main
```

- The trailing `:main` is the branch/tag/revision.
- Weights land in the standard HF cache dir `/runpod-volume/huggingface-cache/hub/`
  (`models--{org}--{name}/snapshots/{hash}/`), so anything that reads the HF cache
  (Transformers, vLLM, …) picks it up automatically.
- Repeatable — pass it multiple times to attach multiple models.
- Works with `--template-id` **and** `--hub-id`, but **GPU only** (`--compute-type GPU`).
- **Requires runpodctl v2.4.0+.** Check `runpodctl version`; the Homebrew tap can lag —
  prefer the [GitHub releases](https://github.com/runpod/runpodctl/releases) binary.
- Gated/private HF models: provide an `HF_TOKEN` (endpoint env var).

You are **not billed for download time** with the cache, and cold starts drop to
seconds because workers start on hosts that already hold the model.

## Model Repository — `runpodctl model`

Runpod-managed **storage + registry for your own model artifacts**. Upload weights once;
Runpod stores, versions, and distributes them to workers — a first-class model object
with a name, versions, metadata, and a status lifecycle (not just a file on a disk).

```bash
runpodctl model list                                  # list your models
runpodctl model list --all                            # include models you don't own
runpodctl model list --name "llama"                   # filter by name
runpodctl model list --provider "meta"                # filter by provider
runpodctl model add --name "my-model" --model-path ./model   # upload a local model directory
runpodctl model remove --name "my-model" --owner <owner>     # remove a model
```

`model add` runs a **multipart upload session** (built for large weights) — the live
`runpodctl model add --help` exposes `--create-upload`, `--part-size`, `--file-size`,
`--file-name`, `--content-type`, `--metadata key=value`, `--model-status`,
`--version-status`, and `--credential-reference`/`--credential-type` (for pulling from a
private source). Run it before relying on exact syntax — it is authoritative.

**Coming from a baked-in model?** The easiest migration is to stop `COPY`-ing weights
into the image and instead `runpodctl model add --model-path <the same dir you used to
COPY>`, then reference the uploaded model from the endpoint. This shrinks the image and
lets you version the weights independently of the code.

**vs a network volume:** a network volume is a raw filesystem you manage and is **pinned
to one data center** (workers must run there); the Model Repository is managed, versioned,
and host-distributed, so it isn't locked to a single DC. Use a volume when you want direct
filesystem control or are already populating one; use the Model Repository for a
hands-off, versioned artifact.

> **Runtime-load path — don't guess.** The command surface above (`runpodctl model add`)
> is from live `runpodctl --help` and is accurate for *uploading*. But how a worker
> *references an uploaded Model Repository artifact at runtime* is **not publicly
> documented yet** — if asked for exact runtime-load steps for a `runpodctl model add`
> artifact, say it isn't publicly documented and don't invent a path.
>
> This is distinct from the HF **model-caching** feature (the `--model-reference` flag /
> the endpoint "Model" field), whose runtime path **is** documented: the model lands in
> `/runpod-volume/huggingface-cache/hub/` and the handler resolves the local snapshot from
> there (load offline with `HF_HUB_OFFLINE=1`). See golden path 20 and the official
> example `runpod-workers/model-store-cache-example`.
