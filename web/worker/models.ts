/**
 * The two models in the arena.
 *
 * Each is a separate Flash endpoint on a different GPU tier. They are called
 * concurrently for every prompt and the user picks a winner without being told
 * which is which.
 */

export type ModelKey = "sdxl-turbo" | "flux-schnell";

export const MODEL_KEYS: readonly ModelKey[] = ["sdxl-turbo", "flux-schnell"];

export const MODELS: Record<
  ModelKey,
  { label: string; blurb: string; width: number; height: number; steps: number }
> = {
  "sdxl-turbo": {
    label: "SDXL-Turbo",
    blurb: "Distilled for speed · 2 steps · 24GB GPU",
    // Each model runs at the resolution it was trained for. Forcing Turbo to 1024
    // would misrepresent it worse than the resolution gap does; both render at the
    // same size in the UI.
    width: 512,
    height: 512,
    steps: 2,
  },
  "flux-schnell": {
    label: "FLUX.1-schnell",
    blurb: "12B params · 4 steps · 48GB GPU",
    width: 1024,
    height: 1024,
    steps: 4,
  },
};

export function isModelKey(value: unknown): value is ModelKey {
  return typeof value === "string" && (MODEL_KEYS as readonly string[]).includes(value);
}

/** Which deployed Runpod endpoint serves this model. */
export function endpointIdFor(env: Env, model: ModelKey): string {
  const id =
    model === "flux-schnell" ? env.RUNPOD_FLUX_ENDPOINT_ID : env.RUNPOD_ENDPOINT_ID;
  if (!id) throw new Error(`no endpoint id configured for model ${model}`);
  return id;
}

/** Randomized left/right assignment -- the blind. */
export function randomPairing(): { leftModel: ModelKey; rightModel: ModelKey } {
  return Math.random() < 0.5
    ? { leftModel: "sdxl-turbo", rightModel: "flux-schnell" }
    : { leftModel: "flux-schnell", rightModel: "sdxl-turbo" };
}
