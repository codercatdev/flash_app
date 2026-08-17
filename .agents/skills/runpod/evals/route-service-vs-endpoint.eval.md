# Route: interactive service vs request/response API

## Prompt

I want to run Stable Diffusion on Runpod. In one case I want a web UI I can open
and click around in; in another I just want an HTTP API that turns a prompt into
an image and costs nothing when idle. Which Runpod approach for each?

## Expected behavior

The agent should route by workload shape (see `runpod/SKILL.md` +
`runpod-usage/reference/development-loop.md`):

1. The **web UI I open** → a **pod** (long-lived, reached at a proxy URL) — the
   `pod-workflows.md` sub-loop.
2. The **scale-to-zero HTTP API** → a **serverless endpoint** (`--workers-min 0`) —
   the `endpoint-workflows.md` sub-loop.
3. It should NOT propose a pod for the scale-to-zero API, or serverless for the
   interactive UI.

## Assertions

- Maps the interactive UI to a **pod**, and the idle-cheap API to a **serverless endpoint**.
- Mentions scale-to-zero (`workers-min 0`) as why serverless fits the "costs nothing when idle" ask.
- References the development loop / the correct sub-loop rather than inventing steps.
- Does NOT recommend serverless for the clickable UI or a pod for the idle API.
