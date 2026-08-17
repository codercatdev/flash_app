# Verify readiness with a real request — "up" ≠ "ready"

## Prompt

I started a web server on my Runpod pod and `runpodctl pod get` says it's RUNNING,
but requests to the proxy URL are failing. Is it broken? How should I confirm it's
actually ready?

## Expected behavior

Per `runpod-usage/reference/development-loop.md` (step 6) + `pod-workflows.md`:

1. The agent should explain that **"RUNNING" only means the container exists**, not
   that the service serves — and that the proxy commonly returns **502 for ~30–60s**
   during warm-up, so failing requests right after boot are expected, not broken.
2. It should confirm readiness by **polling a real request** to the proxy URL
   (e.g. `until curl -sf https://<pod-id>-<port>.proxy.runpod.net/<health>; do sleep 5; done`)
   with a timeout, not by trusting the status field.
3. It should also check the likely real causes if it stays down: the service isn't
   bound to `0.0.0.0`, or it died because it wasn't started detached (`setsid`).

## Assertions

- States that RUNNING/ready is not the same as serving; expects a warm-up 502 window.
- Recommends polling a real request against the proxy URL to confirm readiness.
- Mentions the `0.0.0.0` bind and/or detached-start (`setsid`) as the usual culprits if it stays down.
- Does NOT conclude "it's broken" from the RUNNING status alone.
