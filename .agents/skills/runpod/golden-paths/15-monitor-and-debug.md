# Golden path 15 — monitor & debug serverless (is my endpoint healthy, why is a job failing)

**Goal:** the observability toolkit for a running serverless endpoint — answer "are my
workers healthy?", "why is this job stuck?", and "what did the worker actually do?" using
`/health` worker+job counts, the job `/status` lifecycle, and worker log streaming. This is
the loop you run when a request is slow, stuck `IN_QUEUE`, or `FAILED`.
**Status:** ✅ **COVERED — live-verified 2026-07-13** end to end. Deployed a tiny CPU
scale-to-zero echo endpoint (`python:3.11-slim` + `runpod`), sent one async job, and
live-captured the full signal set: `/health` transitioning **idle → ready → throttled →
ready** while a job moved **`IN_QUEUE` → `IN_PROGRESS` → `COMPLETED`**; the completed
`/status` carrying `delayTime`/`executionTime`/`workerId`; the **v2 REST worker-log SSE
stream** returning both `system` (image pull) and `container` (fitness checks + per-request
`Started`/`Finished`) frames correlated by `requestId`; and config-change toggles
(`workersMax`, data-center set) applied via v1 `PATCH` (HTTP 200 each).
**Lane(s):** REST/HTTP (`/health`, `/status`, v1 `PATCH`) + v2 REST worker logs
(`GET /v2/serverless/{id}/workers/{workerId}/logs`, SSE) + Runpod MCP (`stream-worker-logs`,
`list-endpoint-workers`) + Console (Logs/Workers/Metrics tabs)

## When to use this
Reach for this path whenever a deployed endpoint isn't behaving:
- A request sits `IN_QUEUE` far longer than expected (→ check worker counts for `throttled`
  or zero-`ready`).
- A job returns `FAILED` and you need the handler-side traceback (→ worker container logs).
- You want to confirm an endpoint is warm/scaled before a burst (→ `/health` `ready`/`idle`).
- You changed the config (max workers, region) and want to see it take.

It pairs with any deploy path ([05](05-model-to-endpoint-pipeline.md),
[09](09-custom-serverless-dev-loop/README.md), [10](10-multi-region-ha-serverless.md)) — those get the
endpoint up; this one tells you whether it's healthy and why a job did what it did.

## The four signals (and where each comes from)

| Question | Signal | Source | Cost |
| --- | --- | --- | --- |
| Are workers healthy / how many? | worker state counts | `GET api.runpod.ai/v2/<id>/health` | free, instant |
| Where is *this* job? | job state + timings | `GET api.runpod.ai/v2/<id>/status/<jobId>` | free, instant |
| What did the worker *do*? | container/system logs | v2 REST worker logs · MCP `stream-worker-logs` · Console Workers tab | free |
| Did my config change take? | endpoint config | v1 `PATCH`/`GET rest.runpod.io/v1/endpoints/<id>` | free |

There is **no first-class `runpodctl` command for serverless worker logs** — use the v2 REST
logs path, the Runpod MCP `stream-worker-logs` tool, or the Console **Workers** tab.

## Prerequisites
- `RUNPOD_API_KEY` resolvable (the same key authorizes `api.runpod.ai/v2`, `rest.runpod.io/v1`,
  and `v2-rest.runpod.io/v2`).
- A deployed endpoint id. Below uses a tiny CPU echo endpoint (build any handler; see
  [05](05-model-to-endpoint-pipeline.md) for the two-step template→endpoint pattern).

## 1. `/health` — worker & job counts (start here)

```bash
curl -s https://api.runpod.ai/v2/<endpoint-id>/health -H "Authorization: Bearer $RUNPOD_API_KEY"
```
✅ Live — a scale-to-zero endpoint idle, then holding a queued job, then after completion:
```jsonc
// idle, just created (worker warming)
{"jobs":{"completed":0,"failed":0,"inProgress":0,"inQueue":0,"retried":0},
 "workers":{"idle":0,"initializing":1,"ready":0,"running":0,"throttled":0,"unhealthy":0}}
// a job queued, a worker ready
{"jobs":{"completed":0,"failed":0,"inProgress":0,"inQueue":1,"retried":0},
 "workers":{"idle":1,"initializing":0,"ready":1,"running":0,"throttled":0,"unhealthy":0}}
// after completion
{"jobs":{"completed":1,"failed":0,"inProgress":0,"inQueue":0,"retried":0},
 "workers":{"idle":3,"initializing":0,"ready":3,"running":0,"throttled":0,"unhealthy":0}}
```

**Worker states** (the live `/health` payload carries all six — richer than the two-field
`{idle,running}` shown in some docs):

| State | Meaning | Billed |
| --- | --- | --- |
| `initializing` | pulling image / loading code | yes |
| `idle` / `ready` | up, waiting for work | no (idle) |
| `running` | processing a request | yes |
| `throttled` | host is resource-constrained; can't run right now | no |
| `unhealthy` | crashed; auto-retried for up to 7 days | no |

**`jobs` counters** aggregate the queue: `inQueue`, `inProgress`, `completed`, `failed`,
`retried`. `SDK` equivalents exist (`endpoint.health()` in the Python/JS SDKs) but the raw
`curl` above is the zero-dependency check.

### Reading it: healthy vs. stuck
- **Healthy & scaled:** `ready`/`idle` ≥ 1 and `inQueue` draining. A request will be picked up.
- **Stuck `IN_QUEUE`:** `inQueue` > 0 but `running`/`ready` = 0. Look at *why* no worker is
  free — the two common causes below.
- **`throttled` > 0:** the host pool is momentarily constrained (verified live — see next
  section). Workers usually recover on their own; a **persistently** throttled endpoint on a
  scarce GPU means you pinned too narrow a pool — widen GPU types or data centers.
- **`unhealthy` > 0:** the worker crashed on start or mid-job — go straight to the logs.

## 2. Job `/status` — the request lifecycle

```bash
curl -s https://api.runpod.ai/v2/<endpoint-id>/status/<job-id> -H "Authorization: Bearer $RUNPOD_API_KEY"
```
Job states: `IN_QUEUE` → `IN_PROGRESS` (a.k.a. `RUNNING`) → `COMPLETED`, or `FAILED` /
`CANCELLED` / `TIMED_OUT`. ✅ Live capture of one async job walking the whole path while
`/health` moved in lockstep:
```
[q]  status=IN_QUEUE     workers={ready:1, throttled:0}
[q]  status=IN_QUEUE     workers={throttled:2}          # host briefly constrained
[q]  status=IN_QUEUE     workers={ready:1, throttled:1} # recovering
[r]  status=IN_PROGRESS  workers={idle:2, ready:2}
[c]  status=COMPLETED    workers={idle:2, ready:2}
```
The completed `/status` carries the timing + routing fields you use to explain a slow request:
```jsonc
{"id":"bb2a...-u1","status":"COMPLETED",
 "delayTime":58547,      // ms the job waited in queue (here: inflated by the throttle above)
 "executionTime":8177,   // ms the handler actually ran
 "workerId":"jfnozynhb29r3c",   // which worker served it — feed this to worker logs
 "output":{"echo":{"msg":"hello gp15"},"dc":"EU-RO-1","worker_id":"jfnozynhb29r3c"}}
```
`delayTime` vs. `executionTime` is the key split: a big `delayTime` with a small
`executionTime` = a scheduling/scaling problem (cold start, throttle, `IN_QUEUE`), not a slow
handler. The `workerId` is your handle for the next step.

> **Job-state semantics** live in
> [`../../runpod-usage/reference/endpoint-workflows.md`](../../runpod-usage/reference/endpoint-workflows.md);
> always `/run` + poll `/status` (bound the loop) rather than blocking on `/runsync` for
> anything slow.

## 3. Worker logs — what the worker actually did

Endpoint (aggregate, 90-day retained) logs and per-worker (ephemeral, on-host) logs are both
in the Console (**Logs** and **Workers** tabs). For programmatic/agent access there are two
routes; there is **no `runpodctl` worker-log command**.

### Route A — v2 REST logs (SSE)
```bash
# workerId comes from /status.workerId or the workers list below
curl -sN "https://v2-rest.runpod.io/v2/serverless/<endpoint-id>/workers/<worker-id>/logs?source=container&tail=100" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Accept: text/event-stream'
```
It's a **Server-Sent Events** stream (`data: {"source","line","ts"}` frames); bound it with
`curl -m <sec>`. Query params: `source=container|system` (omit for both), `tail=<N>`
(historical lines to backfill, API default 100, max 5000; `0` = live only), `since=<RFC3339>`
(resume from a timestamp).

✅ Live — `source=container` on the worker that served our job showed the full handler-side
story, correlated to the request by `requestId`:
```
data: {"source":"container","line":"--- Starting Serverless Worker |  Version 1.10.1 ---", ...}
data: {"source":"container","line":"{\"message\":\"Running 7 fitness check(s)...\",\"level\":\"INFO\"}", ...}
data: {"source":"container","line":"{\"message\":\"All fitness checks passed. (813.77ms)\",\"level\":\"INFO\"}", ...}
data: {"source":"container","line":"{\"requestId\":\"bb2a...-u1\",\"message\":\"Started.\",\"level\":\"INFO\"}", ...}
data: {"source":"container","line":"{\"requestId\":\"bb2a...-u1\",\"message\":\"Finished.\",\"level\":\"INFO\"}", ...}
```
`source=system` carries the host/lifecycle view (image pull/extract progress, worker
scheduling). Use `container` for your handler's stdout/stderr and the SDK's per-request
`Started`/`Finished` lines; `system` to diagnose slow cold starts (a long image pull shows up
here frame by frame).

To find worker ids without a job in hand, list the endpoint's workers (also v2 REST):
```bash
curl -s https://v2-rest.runpod.io/v2/serverless/<endpoint-id>/workers -H "Authorization: Bearer $RUNPOD_API_KEY"
```
✅ Live — returns a `summary` plus one object per worker with `id`, `status`
(`RUNNING`/`IDLE`/`THROTTLED`/`INITIALIZING`/`UNHEALTHY`), `gpuTypeId`, `dataCenterId`,
`image`, `startedAt`, `uptimeSeconds`, `isStale`.

### Route B — Runpod MCP `stream-worker-logs`
The hosted Runpod MCP (`https://mcp.getrunpod.io/`) wraps the exact same endpoint as a tool:
`list-endpoint-workers` → pick a `workerId` → `stream-worker-logs` (params `source`, `tail`,
`since`, `maxWaitMs`). It returns a bounded, already-parsed snapshot of the frames — the
easiest route from inside an agent. (This is the same tool golden path
[07](07-network-volume-handoff.md) used to distinguish a healthy worker from a bad payload.)

> Both routes are **v2-only** — they read the v2 serverless service, not `rest.runpod.io/v1`.
> If you can't reach the v2 logs path, use the MCP tool or the Console **Workers** tab
> (click a worker → its logs + request history).

## 4. Config-change events (max-workers / region changes fire alerts)

Endpoint config is edited with a v1 `PATCH`; each applied change is a config-change event
(the same events surface as endpoint alerts/notifications). Verified live 2026-07-13 — both
toggles returned HTTP 200:
```bash
# scale ceiling
curl -s -X PATCH https://rest.runpod.io/v1/endpoints/<endpoint-id> \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"workersMax":3}'
# network region / data-center set
curl -s -X PATCH https://rest.runpod.io/v1/endpoints/<endpoint-id> \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"dataCenterIds":["EU-RO-1","EU-CZ-1"]}'
# confirm
curl -s https://rest.runpod.io/v1/endpoints/<endpoint-id> -H "Authorization: Bearer $RUNPOD_API_KEY"
```
Changing **max workers** (capacity) or the **network region / data-center** set are the two
config changes worth watching — they directly move the `/health` worker counts and where jobs
can schedule. Re-read `/health` right after a change to confirm workers redistribute.

## The debug loop (putting it together)

1. **`/health`** — is any worker `ready`/`running`? If all `throttled`/`unhealthy` or the
   endpoint won't scale, that's the problem, not your handler.
2. **`/status/<jobId>`** — where is the job? Split `delayTime` (queue/scaling) vs.
   `executionTime` (handler). Grab `workerId`.
3. **Worker `container` logs** (v2 REST or MCP) for that `workerId` — read the fitness checks
   and the per-`requestId` lines; a `FAILED` job's traceback is here.
4. **Config** — if capacity/region is the constraint, `PATCH` `workersMax` / `dataCenterIds`
   and re-check `/health`.

## Gotchas
- **No `runpodctl` serverless worker-log command** — worker logs come from the v2 REST logs
  path, the Runpod MCP `stream-worker-logs`, or the Console Workers tab. `runpodctl` covers
  create/list/delete, not log streaming.
- **Worker logs are v2-only and ephemeral** — the per-worker stream lives on the host and is
  gone when the worker terminates. Aggregate **endpoint** logs (Console Logs tab) are retained
  90 days; for permanent logs, write to a network volume or an external sink.
- **Worker logs are SSE, not JSON** — parse `data:` frames and always time-bound the read
  (`curl -m`), or it will hang tailing live output.
- **`throttled` is usually transient** — it means the host pool is momentarily constrained
  (seen live: workers flipped `throttled` then recovered on their own within ~30 s). Only a
  *persistent* throttle on a narrow/scarce GPU pool needs action (widen GPU types / DCs).
- **`delayTime` includes cold-start + throttle**, not just queue position — a large
  `delayTime` on a scale-to-zero endpoint is often just the first worker warming, not a bug.
- **Log throttling** — a worker that floods stdout can have logs dropped; keep handler logging
  structured and modest.

## Cost & cleanup
The endpoint is CPU scale-to-zero (`workersMin 0`) — ~$0 idle. All monitoring calls
(`/health`, `/status`, worker logs, `PATCH`/`GET`) are free.
```bash
runpodctl serverless delete <endpoint-id>
runpodctl template delete <template-id>
runpodctl serverless list && runpodctl pod list && runpodctl network-volume list   # confirm clean
```
The pushed image `<your-registry>/gp15-echo:v1` (a ~150 MB `python:3.11-slim` + `runpod` echo
handler that returns its input plus `RUNPOD_POD_ID`/`RUNPOD_DC_ID`) is left public so this doc
cites a real, pullable tag; it costs nothing.

## Skill facts confirmed / folded back
- **`/health` returns six worker-state fields** (`idle`, `initializing`, `ready`, `running`,
  `throttled`, `unhealthy`) — richer than the `{idle,running}` shape in the operation
  reference. Worth folding the full set into
  [endpoint-workflows.md](../../runpod-usage/reference/endpoint-workflows.md), which today
  only says "diagnose via `/health` worker counts."
- **Worker log streaming is a real, reachable v2 REST endpoint** —
  `GET https://v2-rest.runpod.io/v2/serverless/<id>/workers/<workerId>/logs` (SSE, params
  `source`/`tail`/`since`), and `.../workers` lists workers with status/GPU/DC. The Runpod MCP
  (`list-endpoint-workers` + `stream-worker-logs`) wraps both.
- **`/status` timing split** (`delayTime` vs `executionTime` + `workerId`) is the fastest way
  to classify a slow request as scaling-bound vs. handler-bound.
- **Config edits are v1 `PATCH`** on `rest.runpod.io/v1/endpoints/<id>` (`workersMax`,
  `dataCenterIds`, …) — these are the config-change events; confirm with a follow-up `GET` and
  a fresh `/health`.
