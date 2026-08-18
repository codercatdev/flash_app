/**
 * Secrets are not declared in wrangler.jsonc (that file is committed), so
 * `wrangler types` cannot see them. Declare them here so they merge into the
 * generated global `Env` interface.
 *
 * Set for production with `wrangler secret put <NAME>`; for local dev put them
 * in web/.dev.vars.
 */
declare global {
  interface Env {
    RUNPOD_API_KEY: string;
    RUNPOD_ENDPOINT_ID: string;
    RUNPOD_FLUX_ENDPOINT_ID: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    BETTER_AUTH_SECRET: string;
  }
}

export {};
