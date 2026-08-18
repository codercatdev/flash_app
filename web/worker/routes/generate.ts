import { type Context, Hono } from "hono";

import { fetchJobState, submitJob } from "../runpod";
import { getBalance, refundToken, spendToken } from "../tokens";
import type { AppContext, SessionUser } from "../types";

const generate = new Hono<AppContext>();

const TOKEN_COST = 1;

/** Decode the worker's base64 PNG into bytes for R2. */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function requireUser(c: Context<AppContext>): SessionUser | null {
  return c.get("user");
}

/**
 * Kick off a generation.
 *
 * Order matters: spend the token *before* dispatching to the GPU, so a burst of
 * concurrent requests can't all pass the balance check. If dispatch then fails
 * we refund. The alternative (generate first, bill after) means a user who
 * disconnects mid-job gets free GPU time.
 */
generate.post("/api/generate", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json().catch(() => null) as {
    prompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    seed?: number;
  } | null;

  const prompt = body?.prompt?.trim();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);
  if (prompt.length > 800) {
    return c.json({ error: "prompt must be 800 characters or fewer" }, 400);
  }

  const paid = await spendToken(c.env.DB, user.id, TOKEN_COST);
  if (!paid) {
    // The paywall lives here and only here. The SPA renders its upgrade wall
    // from this response rather than duplicating the balance logic.
    return c.json(
      {
        error: "out_of_tokens",
        balance: await getBalance(c.env.DB, user.id),
        plan: "pro",
      },
      402,
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    const runpodJobId = await submitJob(c.env, {
      prompt,
      width: body?.width ?? 512,
      height: body?.height ?? 512,
      steps: body?.steps ?? 2,
      ...(body?.seed !== undefined ? { seed: body.seed } : {}),
    });

    await c.env.DB.prepare(
      `INSERT INTO generation
         (id, userId, runpodJobId, prompt, status, width, height, steps, seed, createdAt)
       VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        user.id,
        runpodJobId,
        prompt,
        body?.width ?? 512,
        body?.height ?? 512,
        body?.steps ?? 2,
        body?.seed ?? null,
        now,
      )
      .run();

    return c.json({ id, status: "QUEUED" });
  } catch (err) {
    await refundToken(c.env.DB, user.id, id);
    return c.json({ error: `dispatch failed: ${String(err)}` }, 502);
  }
});

/**
 * Poll a generation. On the first COMPLETED poll this is also what persists the
 * image to R2 and settles the ledger.
 */
generate.get("/api/generate/:id", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM generation WHERE id = ? AND userId = ?",
  )
    .bind(id, user.id)
    .first<{
      id: string;
      runpodJobId: string | null;
      status: string;
      imageKey: string | null;
      generateMs: number | null;
      queueMs: number | null;
      coldStart: number | null;
      gpu: string | null;
      error: string | null;
      createdAt: number;
    }>();

  if (!row) return c.json({ error: "not found" }, 404);

  // Terminal states are cached in D1; don't re-poll Runpod for them.
  if (row.status !== "QUEUED") {
    return c.json({
      id: row.id,
      status: row.status,
      url: row.imageKey ? `/i/${row.imageKey}` : null,
      generateMs: row.generateMs,
      queueMs: row.queueMs,
      cold: Boolean(row.coldStart),
      gpu: row.gpu,
      error: row.error,
    });
  }

  if (!row.runpodJobId) return c.json({ error: "job was never dispatched" }, 500);

  const state = await fetchJobState(c.env, row.runpodJobId);

  if (state.status === "IN_QUEUE" || state.status === "IN_PROGRESS") {
    return c.json({ id: row.id, status: "QUEUED", stage: state.status });
  }

  if (state.status !== "COMPLETED" || !state.output) {
    const message = state.error ?? `job ${state.status.toLowerCase()}`;
    await refundToken(c.env.DB, user.id, row.id);
    await c.env.DB.prepare(
      "UPDATE generation SET status = 'FAILED', error = ?, completedAt = ? WHERE id = ?",
    )
      .bind(message, Date.now(), row.id)
      .run();

    return c.json({ id: row.id, status: "FAILED", error: message });
  }

  const output = state.output;
  const imageKey = `${row.id}.png`;

  await c.env.IMAGES.put(imageKey, decodeBase64(output.image), {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { userId: user.id, prompt: output.prompt },
  });

  const completedAt = Date.now();
  const queueMs = completedAt - row.createdAt;

  await c.env.DB.prepare(
    `UPDATE generation
        SET status = 'COMPLETED', imageKey = ?, generateMs = ?, queueMs = ?,
            coldStart = ?, gpu = ?, completedAt = ?
      WHERE id = ?`,
  )
    .bind(
      imageKey,
      output.generate_ms,
      queueMs,
      output.cold ? 1 : 0,
      output.gpu,
      completedAt,
      row.id,
    )
    .run();

  return c.json({
    id: row.id,
    status: "COMPLETED",
    url: `/i/${imageKey}`,
    generateMs: output.generate_ms,
    queueMs,
    cold: output.cold,
    gpu: output.gpu,
  });
});

/** Gallery: this user's finished images, newest first. */
generate.get("/api/generations", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT id, prompt, imageKey, generateMs, queueMs, coldStart, gpu, createdAt
       FROM generation
      WHERE userId = ? AND status = 'COMPLETED'
      ORDER BY createdAt DESC
      LIMIT 50`,
  )
    .bind(user.id)
    .all<{
      id: string;
      prompt: string;
      imageKey: string;
      generateMs: number;
      queueMs: number;
      coldStart: number;
      gpu: string;
      createdAt: number;
    }>();

  return c.json({
    generations: results.map((r) => ({
      id: r.id,
      prompt: r.prompt,
      url: `/i/${r.imageKey}`,
      generateMs: r.generateMs,
      queueMs: r.queueMs,
      cold: Boolean(r.coldStart),
      gpu: r.gpu,
      createdAt: r.createdAt,
    })),
  });
});

export default generate;
