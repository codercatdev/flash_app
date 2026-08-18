/**
 * Minimal client for an already-deployed Runpod Serverless endpoint.
 *
 * Lifecycle (build / deploy / scale / teardown) belongs to the `flash` CLI and
 * is never done from here -- see CLAUDE.md. This file only *invokes* an endpoint
 * that `flash deploy` already created, which is the supported way to call Flash
 * from non-Python code.
 *
 * Payload shape is dictated by Flash's generated class handler: it pops a
 * "method" key to choose the target method, but skips that when the class has
 * exactly one public method. `ImageGenerator.generate` is the only public method
 * on the worker, so the body is just the method's kwargs under `input`.
 */

const RUNPOD_BASE = "https://api.runpod.ai/v2";

export interface GenerateInput extends Record<string, unknown> {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}

export interface WorkerOutput {
  image: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number | null;
  generate_ms: number;
  model_load_ms: number;
  cold: boolean;
  gpu: string;
}

export type JobStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export interface JobState {
  status: JobStatus;
  output?: WorkerOutput;
  error?: string;
}

function headers(env: Env) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
  };
}

/**
 * Submit asynchronously via /run rather than /runsync.
 *
 * /runsync gives up after 60s, and a cold start (provision + ~7GB of weights)
 * routinely exceeds that. Submitting and polling also lets the UI show cold-start
 * progress instead of hanging on one request.
 */
export async function submitJob(
  env: Env,
  input: GenerateInput,
): Promise<string> {
  const res = await fetch(`${RUNPOD_BASE}/${env.RUNPOD_ENDPOINT_ID}/run`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    throw new Error(`runpod /run failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { id?: string; error?: string };
  if (!body.id) {
    throw new Error(`runpod /run returned no job id: ${JSON.stringify(body)}`);
  }
  return body.id;
}

export async function fetchJobState(
  env: Env,
  runpodJobId: string,
): Promise<JobState> {
  const res = await fetch(
    `${RUNPOD_BASE}/${env.RUNPOD_ENDPOINT_ID}/status/${runpodJobId}`,
    { headers: headers(env) },
  );

  if (!res.ok) {
    throw new Error(`runpod /status failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    status: JobStatus;
    output?: WorkerOutput | { error?: string };
    error?: string;
  };

  // A handler that raises comes back as FAILED with the traceback in `error`.
  // A handler that *returns* an error dict comes back COMPLETED -- catch that
  // too so a failed generation is never billed as a success.
  const output = body.output as WorkerOutput & { error?: string };
  if (body.status === "COMPLETED" && output?.error) {
    return { status: "FAILED", error: output.error };
  }

  return {
    status: body.status,
    output: body.status === "COMPLETED" ? output : undefined,
    error: body.error,
  };
}
