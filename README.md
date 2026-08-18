# Flash Image Studio

A real, deployed product built on **Runpod Flash**: sign up, spend tokens, generate
images on a serverless GPU, hit a paywall, subscribe, keep going.

There is **no Dockerfile in this repository**. The GPU worker is a decorated Python
class; Flash packages and provisions it.

```
Browser ──► Cloudflare Worker ──────────────► Runpod Flash endpoint
            (Hono + React SPA)                (SDXL-Turbo, 24GB-tier GPU)
              │                                        │
              ├─ Better Auth ──► D1 (SQLite)           │
              ├─ Stripe ───────► subscription + tokens │
              └─ R2 ◄────────── generated PNGs ◄───────┘
```

**Stack:** Runpod Flash · SDXL-Turbo · Cloudflare Workers · Hono · React · D1 · R2 ·
Better Auth · Stripe

---

## Measured performance

512×512, 2 steps, SDXL-Turbo, no network volume. Deployed endpoint, 6 runs —
raw output in `docs/evidence/benchmark-deployed.txt`, reproduce with `benchmark.py`.

| | wall | GPU only | model load |
|---|---|---|---|
| **Cold** (first request) | 67.8s | 878ms | 15.2s |
| **Warm** (p50) | **1.10s** | **297ms** | 0ms |
| Warm (p95) | 1.56s | 317ms | 0ms |

Three things worth noticing:

- **The deployed worker really does reuse the instance** — `model load` is 0ms on
  every request after the first. `flash dev` does *not* do this (friction log #5),
  so these numbers are only observable after `flash deploy`.
- **Overhead dominates.** At 297ms of GPU work, ~810ms of the 1.1s is queue,
  dispatch, and shipping a ~450KB base64 PNG. Optimizing the model further would be
  pointless; the transport is the bottleneck.
- **The GPU tier is a suggestion.** This run requested
  `[ADA_24, AMPERE_24, AMPERE_48]` and landed on an *RTX PRO 6000 Blackwell MIG
  1g.24gb* slice. Same nominal 24GB tier, but ~1.8× slower per image than the RTX
  4090 the same config produced earlier (297ms vs 168ms). Pin `GpuType` if you need
  reproducible latency.

---

## Repository layout

```
image_worker.py         # the entire GPU service -- one decorated class
benchmark.py            # cold/warm latency measurement
web/                    # Cloudflare Worker: Hono API + React SPA (one deploy)
  worker/               #   API, auth, token ledger, Runpod client
  src/                  #   React SPA
  migrations/           #   D1 schema
docs/friction-log.md    # what broke, with reproductions and suggested fixes
docs/talk-outline.md    # the 20-minute structure
```

---

## The GPU worker

The whole service is one file. A **class** endpoint, not a function, so the pipeline
loads once per worker instead of once per request:

```python
@Endpoint(
    name="flashfun-sdxl",
    gpu=[GpuGroup.ADA_24, GpuGroup.AMPERE_24, GpuGroup.AMPERE_48],
    workers=(0, 5),
    dependencies=["torch", "diffusers", "transformers", "accelerate", "pillow"],
)
class ImageGenerator:
    def __init__(self):                     # once per worker
        self.pipe = AutoPipelineForText2Image.from_pretrained(...).to("cuda")

    async def generate(self, prompt: str, ...) -> dict:   # per request
        ...
```

Two non-obvious rules this file obeys:

1. **Every import is inside the class body.** `flash dev` ships only the function
   body to the worker, so a module-level import raises `NameError` there even though
   `flash deploy` (which imports the whole module) would hide it.
2. **`generate` is the only public method.** Flash's generated handler pops a
   `"method"` key to pick a target — but skips that when exactly one public method
   exists. Keeping it to one is what lets external callers post a plain
   `{"input": {"prompt": "..."}}`. Adding a second public method silently changes
   the wire format for every client.

---

## Run it

### 1. GPU endpoint

```bash
uv venv && source .venv/bin/activate
uv sync
flash login

flash dev                       # iterate: runs on a real remote GPU, hot-reloads
```

```bash
curl -X POST http://localhost:8888/image_worker/runsync \
  -H "Content-Type: application/json" \
  -d '{"input": {"prompt": "a cat astronaut over neon Tokyo", "steps": 2}}'
```

> `flash dev` re-creates the class instance on **every** request, so the model
> reloads each time and every response reports `cold: true`. That is a dev-only
> artifact — deployed workers reuse one instance. Do not benchmark against
> `flash dev`. See friction log #5.

Ship it, and note the endpoint id from the output:

```bash
flash deploy
python benchmark.py --endpoint-id <id> --runs 10
```

Optional: cache model weights on a network volume so cold workers skip the 7GB
download. This pins the endpoint to one datacenter, which can leave you with no GPUs
at all — read friction log #3 and #6 first.

```bash
FLASHFUN_USE_VOLUME=1 flash dev
```

### 2. Cloudflare app

```bash
cd web
npm install
npx wrangler login

npx wrangler d1 create flashfun          # put the id in wrangler.jsonc

npm run db:generate                      # Better Auth schema -> migrations/
npx wrangler d1 migrations apply flashfun --local
```

**Create the R2 bucket in the dashboard**, not the CLI:
`dash.cloudflare.com → R2 → Create bucket → flashfun-images`.

`wrangler r2 bucket create` fails under an OAuth login with
`Authentication error [code: 10000]`, because **wrangler's OAuth flow has no R2
scope** — check `wrangler login --scopes-list` and there is no `r2:*` entry to grant.
Deploying a Worker that *binds* an existing bucket only needs `workers_scripts:write`,
which OAuth does give, so the dashboard is the shortest path. The alternative is a
scoped API token in `CLOUDFLARE_API_TOKEN` with Workers R2 Storage:Edit — but that
replaces OAuth for every wrangler call, so it also needs D1 and Workers permissions.

Secrets — `cp .dev.vars.example .dev.vars` for local, and for production:

```bash
for s in RUNPOD_API_KEY RUNPOD_ENDPOINT_ID STRIPE_SECRET_KEY \
         STRIPE_WEBHOOK_SECRET BETTER_AUTH_SECRET; do
  npx wrangler secret put $s
done
```

### 3. Stripe

Create a **test-mode** product with a recurring price and put its id in
`wrangler.jsonc` as `STRIPE_PRO_PRICE_ID`. Register a webhook endpoint at
`https://<your-domain>/api/auth/stripe/webhook` (the route Better Auth's plugin
owns) subscribed to exactly these events:

| Event | Why |
|---|---|
| `checkout.session.completed` | plugin creates the local subscription row |
| `customer.subscription.created` / `.updated` / `.deleted` | plugin syncs status |
| `invoice.payment_succeeded` | **our** renewal token grant |
| `invoice.payment_failed` | dunning visibility; no grant fires |

Then **activate the Customer Portal** at
`dashboard.stripe.com/test/settings/billing/portal`. A portal configuration is not
created automatically, and the "Manage billing" button 500s without one.

**Set a product tax code.** Managed Payments is on by default for new accounts, and
it rejects Checkout Sessions whose product has no `tax_code`:

```
Invalid line_items[0]: the product tax code is missing.
```

This surfaces only when you first try to check out, not when you create the product.
For an AI image generator sold to consumers the right code is `txcd_10105001`
("AIaaS - Cloud Based - Personal Use"). Set it on the product, or disable Managed
Payments in the Dashboard.

Locally, `stripe listen` mints its own signing secret — put *that* one in
`.dev.vars`, not the endpoint's:

```bash
stripe listen --forward-to http://localhost:5173/api/auth/stripe/webhook
npm run dev
```

Deploy:

```bash
npx wrangler d1 migrations apply flashfun --remote
npm run deploy
```

**Always deploy via `npm run deploy`, never bare `wrangler deploy`.** The Cloudflare
Vite plugin emits its own config to `dist/flashfun/wrangler.json` at build time, and
`wrangler deploy` reads *that*, not `wrangler.jsonc`. Running it without a rebuild
silently deploys the previous build's config — edits to routes and bindings are
dropped with no warning and an apparently successful deploy.

---

## How billing works

Better Auth's Stripe plugin manages **subscriptions** but has no concept of credits,
so the token meter is custom (`web/worker/tokens.ts`). It is an **append-only
ledger** — balance is `SUM(delta)`, never a mutable counter. Two reasons:

- **D1 has no interactive transactions.** A read-then-write "check balance, then
  decrement" is genuinely racy, so `spendToken` does the check and the write in one
  conditional `INSERT ... WHERE (SELECT SUM(delta) ...) >= cost`.
- **Stripe delivers webhooks at least once.** Grants carry the Stripe event id in a
  `UNIQUE` column, so a redelivery is a no-op instead of a double grant.

Flow: 5 free tokens at signup → 1 token per image → `402` with an upgrade URL at zero
→ Stripe Checkout → 500 tokens per period. Failed generations refund automatically.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/generate` | Spend a token, dispatch to Runpod. `402` when broke |
| `GET` | `/api/generate/:id` | Poll; persists to R2 and settles the ledger |
| `GET` | `/api/generations` | Gallery |
| `GET` | `/api/me` | Session, balance, subscription |
| `*` | `/api/auth/*` | Better Auth (incl. Stripe webhook) |
| `GET` | `/i/:key` | Serve a PNG from R2 |

Generation is submit-then-poll rather than one blocking call, because Flash's
`runsync` gives up at 60s and a cold start can take three minutes. It also lets the
UI report cold-start progress instead of freezing.

---

## AI disclosure

Built with Claude Code as a pair programmer: scaffolding the Cloudflare Worker,
drafting the React SPA, and cross-checking SDK behaviour against installed source.
Every claim in `docs/friction-log.md` was reproduced against the live API and cited
to a specific file and line — nothing there is model recall. All measurements are
from real runs on real hardware.
