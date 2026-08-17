# Networking

How to reach a running workload over HTTP — Pods via the proxy or TCP, Serverless
via endpoint URLs.

## Pod HTTP proxy

The easiest way to expose a web service (REST API, web app, JupyterLab) from a Pod.
Add the internal port to **Expose HTTP Ports (Max 10)** on the Pod or template, then
reach it at:

```
https://<pod-id>-<internal-port>.proxy.runpod.net
```

Example — Pod `abc123xyz` running a server on port `4000`:

```
https://abc123xyz-4000.proxy.runpod.net
```

The `<internal-port>` is the port your service listens on *inside* the container,
not an external port number. Key behaviors:

- **Bind to `0.0.0.0`**, not `localhost`/`127.0.0.1`, or the proxy can't reach it.
- **HTTPS only** — the proxy terminates TLS even if your service speaks plain HTTP.
- **100-second timeout** — the route runs through Cloudflare, which closes idle/slow
  connections at 100s with a `524`. For long work, return a job ID and poll, or use TCP.
- **Public, unauthenticated** — anyone with the URL can reach the service; the Pod ID
  is obscurity, not access control, and the proxy adds no auth (same as any
  port-forwarded service).
  - **Rule:** when you hand a proxy URL to the user, state that it is public and unauthenticated.
  - **Rule:** if the service handles anything sensitive, implement auth inside the service
    itself (e.g. a login/token) — the platform adds none.
- "Running" (green) in the console does not mean the service is ready; the container
  may still be starting.

## Pod TCP ports (direct public IP)

For non-HTTP protocols, WebSockets, databases, or lower latency, expose a **TCP**
port instead (add to **Expose TCP Ports**). Runpod assigns a public IP and an
external port, shown in the **Connect** menu under Direct TCP Ports:

```
TCP port   213.173.109.39:13007 -> :22
```

- The external port differs from the internal port and **changes whenever the Pod
  resets**. Read it from the Connect menu.
- No automatic TLS — implement your own if sending sensitive data.
- Community Cloud public IPs may change on migrate/restart; Secure Cloud IPs are stable.
- UDP is not supported (TCP/HTTP only).

### Symmetric ports

When the external port must equal the internal port, request a port number **above
70000** in the TCP config (not a real port — a signal to allocate matching
internal/external ports). After creation, the assigned ports are in the Connect menu
and in env vars like `$RUNPOD_TCP_PORT_70000` that your app can read at runtime.

## Pod-to-Pod (global networking)

Pods with global networking share a private network and reach each other by internal
DNS — no public ports needed:

```
<pod-id>.runpod.internal
# e.g. a DB on port 5432:  abc123xyz.runpod.internal:5432
```

NVIDIA GPU Pods only; available in a subset of data centers; ~100 Mbps between Pods.
Prefer this over exposing ports for internal services like databases.

## Serverless queue-based endpoints

Queue-based endpoints have a fixed set of operations under a common base:

```
https://api.runpod.ai/v2/<endpoint-id>/<operation>
```

| Operation | Method | Purpose |
|-----------|--------|---------|
| `/run` | POST | Submit an async job; returns a job ID immediately |
| `/runsync` | POST | Submit and wait for the result inline |
| `/status/<job-id>` | GET | Check status / fetch result of a job |
| `/stream/<job-id>` | GET | Stream incremental results |
| `/cancel/<job-id>` | POST | Cancel a queued or running job |
| `/retry/<job-id>` | POST | Requeue a failed/timed-out job |
| `/purge-queue` | POST | Drop all pending jobs |
| `/health` | GET | Worker + job stats for the endpoint |

The request body is a JSON object with an `input` key holding your handler's
parameters:

```bash
curl -X POST https://api.runpod.ai/v2/<endpoint-id>/runsync \
     -H "Authorization: Bearer <RUNPOD_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"input": {"prompt": "Hello, world!"}}'
```

- **Auth header:** `Authorization: Bearer <RUNPOD_API_KEY>` on every call.
- `/runsync` results are retained ~1 min (up to 5); `/run` results ~30 min via
  `/status`. `/runsync` also has a ~60s client wait — for long/cold-start jobs use
  `/run` + poll `/status`, or `runsync?wait=<ms>`.

## Serverless load-balanced endpoints

Load-balanced endpoints expose *your own* HTTP paths on a per-endpoint subdomain:

```
https://<endpoint-id>.api.runpod.ai/<your-custom-path>
```

Example paths from a FastAPI worker: `https://<endpoint-id>.api.runpod.ai/ping`,
`https://<endpoint-id>.api.runpod.ai/generate`.

- Same auth: `Authorization: Bearer <RUNPOD_API_KEY>`.
- Your worker must serve a `/ping` health check on `PORT_HEALTH` (`200` healthy,
  `204` initializing). Main app port defaults to `80` (`PORT`).
- Limits: request timeout ~2 min if no worker is available, ~5.5 min processing per
  request, 30 MB payload cap. Expect "no workers available" during cold start —
  retry with backoff.

## Quick reference

```
Pod HTTP proxy      https://<pod-id>-<internal-port>.proxy.runpod.net   (HTTPS, 100s cap)
Pod TCP             <public-ip>:<external-port>                          (from Connect menu)
Pod-to-Pod          <pod-id>.runpod.internal                            (global networking)
Serverless (queue)  https://api.runpod.ai/v2/<endpoint-id>/{run|runsync|status/<id>|health}
Serverless (LB)     https://<endpoint-id>.api.runpod.ai/<path>
Auth (serverless)   Authorization: Bearer <RUNPOD_API_KEY>
```
