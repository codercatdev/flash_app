import { stripe as stripePlugin } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import Stripe from "stripe";

import { FREE_SIGNUP_TOKENS, PLAN_TOKENS, addLedgerEntry } from "./tokens";

/**
 * How many tokens a renewal invoice is worth.
 *
 * Preference order:
 *  1. The price id on the invoice line -- authoritative, and immune to webhook
 *     ordering or a plan change that hasn't been written locally yet.
 *  2. The local subscription row -- fallback only.
 *
 * The line-item shape has moved across Stripe API versions (`line.price.id` in
 * older ones, `line.pricing.price_details.price` in current), so both are read.
 */
async function resolveRenewalTokens(
  env: Env,
  invoice: Stripe.Invoice,
  customerId: string,
): Promise<number> {
  const line = invoice.lines?.data?.[0] as
    | (Stripe.InvoiceLineItem & {
        price?: { id?: string };
        pricing?: { price_details?: { price?: string } };
      })
    | undefined;

  const priceId = line?.pricing?.price_details?.price ?? line?.price?.id;

  if (priceId && priceId === env.STRIPE_PRO_PRICE_ID) {
    return PLAN_TOKENS.pro;
  }

  const sub = await env.DB.prepare(
    `SELECT plan FROM subscription
      WHERE stripeCustomerId = ? AND status IN ('active', 'trialing')
      ORDER BY periodStart DESC LIMIT 1`,
  )
    .bind(customerId)
    .first<{ plan: string }>();

  return PLAN_TOKENS[sub?.plan ?? ""] ?? 0;
}

/**
 * Build the auth instance for a single request.
 *
 * This MUST be a factory, not a module-level singleton. Cloudflare hands the
 * bindings (`env.DB`, secrets) to each invocation; a singleton captured at
 * module scope would close over the first request's bindings and then be reused
 * across isolates.
 */
export function createAuth(env: Env) {
  // No httpClient config needed: stripe@22 ships a `workerd` export condition,
  // so the bundler picks the fetch + SubtleCrypto build automatically.
  // apiVersion is intentionally omitted -- the SDK pins its own, and the type is
  // a literal that breaks the build on every SDK bump if you hardcode it.
  const stripeClient = new Stripe(env.STRIPE_SECRET_KEY);

  return betterAuth({
    // Native D1: better-auth accepts the binding directly, no Drizzle/Kysely
    // adapter needed.
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    trustedOrigins: [env.APP_URL],

    emailAndPassword: {
      enabled: true,
      // No mail provider wired up for the demo.
      requireEmailVerification: false,
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Free tier. Keyed on the user id so a retried signup cannot
            // double-grant.
            await addLedgerEntry(env.DB, {
              userId: user.id,
              delta: FREE_SIGNUP_TOKENS,
              reason: "signup_grant",
              externalId: `signup:${user.id}`,
            });
          },
        },
      },
    },

    plugins: [
      stripePlugin({
        stripeClient,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        createCustomerOnSignUp: true,
        subscription: {
          enabled: true,
          plans: [
            {
              name: "pro",
              priceId: env.STRIPE_PRO_PRICE_ID,
              limits: { tokens: PLAN_TOKENS.pro },
            },
          ],

          // Initial subscription. `referenceId` is the user id unless you've
          // configured org-level billing.
          //
          // NOTE: this callback lives inside `subscription`, not at the plugin
          // top level -- the Better Auth docs show it one level too high, which
          // type-checks as an unknown excess property and silently never fires.
          onSubscriptionComplete: async ({ event, subscription, plan }) => {
            const amount = PLAN_TOKENS[plan.name] ?? 0;
            if (!amount) return;
            await addLedgerEntry(env.DB, {
              userId: subscription.referenceId,
              delta: amount,
              reason: "subscription_grant",
              externalId: event.id,
            });
          },
        },

        // Renewals. The plugin handles subscription lifecycle but never
        // re-grants anything, so period rollover is on us.
        //
        // `invoice.payment_succeeded` hits the plugin's `default` switch branch:
        // it calls onEvent and does NOT update the local subscription row. Stripe
        // also does not guarantee this event arrives after
        // `customer.subscription.updated`. So the amount is derived from the
        // price on the invoice itself rather than from local state, which is
        // correct regardless of delivery order or a mid-cycle plan change.
        onEvent: async (event) => {
          if (event.type !== "invoice.payment_succeeded") return;

          const invoice = event.data.object as Stripe.Invoice;
          // The first invoice is already covered by onSubscriptionComplete.
          if (invoice.billing_reason !== "subscription_cycle") return;

          const customerId =
            typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id;
          if (!customerId) return;

          const user = await env.DB.prepare(
            "SELECT id FROM user WHERE stripeCustomerId = ?",
          )
            .bind(customerId)
            .first<{ id: string }>();
          if (!user) return;

          const amount = await resolveRenewalTokens(env, invoice, customerId);
          if (!amount) return;

          await addLedgerEntry(env.DB, {
            userId: user.id,
            delta: amount,
            reason: "subscription_grant",
            // Stripe retries webhooks; the UNIQUE constraint on externalId
            // makes a redelivery a no-op instead of a double grant.
            externalId: event.id,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
