/**
 * Schema-generation shim for `@better-auth/cli generate`.
 *
 * The CLI runs in plain Node and has no access to Cloudflare bindings, so it
 * cannot load `createAuth(env)` -- there is no `env`. This file mirrors the real
 * config's *shape* (same plugins, same tables) against an in-memory SQLite
 * database purely so the CLI can emit the DDL.
 *
 * `node:sqlite` is used instead of better-sqlite3 to avoid a native build step;
 * better-auth accepts a `DatabaseSync` instance directly.
 *
 * Keep the plugin list here in sync with worker/auth.ts, or generated migrations
 * will drift from what the Worker actually expects.
 *
 *   npm run db:generate
 */
import { DatabaseSync } from "node:sqlite";

import { stripe as stripePlugin } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import Stripe from "stripe";

export const auth = betterAuth({
  database: new DatabaseSync(":memory:"),
  emailAndPassword: { enabled: true },
  plugins: [
    stripePlugin({
      // Never called -- only the plugin's table definitions are read.
      stripeClient: new Stripe("sk_test_placeholder_for_schema_generation"),
      stripeWebhookSecret: "whsec_placeholder",
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [{ name: "pro", priceId: "price_placeholder" }],
      },
    }),
  ],
});
