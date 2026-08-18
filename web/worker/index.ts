import { Hono } from "hono";

import { createAuth } from "./auth";
import arena from "./routes/arena";
import images from "./routes/images";
import { FREE_SIGNUP_TOKENS, PLAN_TOKENS, getBalance } from "./tokens";
import type { AppContext } from "./types";

const app = new Hono<AppContext>();

/**
 * Build auth for this request and resolve the session once, so downstream
 * handlers just read `c.get("user")`.
 */
app.use("*", async (c, next) => {
  const auth = createAuth(c.env);
  c.set("auth", auth);

  const session = await auth.api
    .getSession({ headers: c.req.raw.headers })
    .catch(() => null);

  c.set("user", session?.user ? (session.user as never) : null);
  await next();
});

/**
 * Better Auth owns everything under /api/auth -- sign-up, sign-in, session,
 * subscription upgrade, and the Stripe webhook at /api/auth/stripe/webhook.
 *
 * Pass `c.req.raw` rather than a reconstructed Request: the webhook signature is
 * computed over the exact raw body, and re-serializing it breaks verification.
 */
app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));

/** Who am I, what can I spend, and am I subscribed. */
app.get("/api/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null, balance: 0, subscription: null });

  const [balance, subscription] = await Promise.all([
    getBalance(c.env.DB, user.id),
    c.env.DB.prepare(
      `SELECT plan, status, periodEnd, cancelAtPeriodEnd
         FROM subscription
        WHERE referenceId = ? AND status IN ('active', 'trialing')
        ORDER BY periodStart DESC LIMIT 1`,
    )
      .bind(user.id)
      .first<{
        plan: string;
        status: string;
        periodEnd: number | null;
        cancelAtPeriodEnd: number | null;
      }>()
      // The subscription table only exists after the Stripe plugin's migration
      // has been applied; treat "no table" as "no subscription".
      .catch(() => null),
  ]);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    balance,
    subscription,
    plans: { pro: { tokens: PLAN_TOKENS.pro } },
    freeGrant: FREE_SIGNUP_TOKENS,
  });
});

app.route("/", arena);
app.route("/", images);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.notFound((c) =>
  c.req.path.startsWith("/api/")
    ? c.json({ error: "not found" }, 404)
    : // Non-API paths are served by the static assets binding
      // (not_found_handling: single-page-application).
      c.env.ASSETS.fetch(c.req.raw),
);

app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
