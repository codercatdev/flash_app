import { type Context, Hono } from "hono";

import {
  MODELS,
  type ModelKey,
  endpointIdFor,
  randomPairing,
} from "../models";
import { fetchJobState, submitJob } from "../runpod";
import { getBalance, refundToken, spendToken } from "../tokens";
import type { AppContext, SessionUser } from "../types";

const arena = new Hono<AppContext>();

/** One prompt runs two models but costs one token. */
const TOKEN_COST = 1;

function requireUser(c: Context<AppContext>): SessionUser | null {
  return c.get("user");
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type BattleRow = {
  id: string;
  userId: string;
  prompt: string;
  status: string;
  leftModel: ModelKey;
  rightModel: ModelKey;
  winnerModel: ModelKey | null;
  createdAt: number;
};

type GenRow = {
  id: string;
  model: ModelKey;
  runpodJobId: string | null;
  status: string;
  imageKey: string | null;
  generateMs: number | null;
  queueMs: number | null;
  coldStart: number | null;
  gpu: string | null;
  error: string | null;
  createdAt: number;
};

/**
 * Start a comparison.
 *
 * Both models are dispatched concurrently, so total wall time is the slower model,
 * not the sum. The token is spent before dispatch for the same reason as before: a
 * burst of concurrent requests must not all pass one balance check.
 */
arena.post("/api/generate", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as { prompt?: string } | null;
  const prompt = body?.prompt?.trim();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);
  if (prompt.length > 800) {
    return c.json({ error: "prompt must be 800 characters or fewer" }, 400);
  }

  const paid = await spendToken(c.env.DB, user.id, TOKEN_COST);
  if (!paid) {
    return c.json(
      { error: "out_of_tokens", balance: await getBalance(c.env.DB, user.id), plan: "pro" },
      402,
    );
  }

  const battleId = crypto.randomUUID();
  const now = Date.now();
  const { leftModel, rightModel } = randomPairing();

  try {
    // Fan out. Promise.all so the two cold starts overlap instead of stacking.
    const dispatched = await Promise.all(
      ([leftModel, rightModel] as ModelKey[]).map(async (model) => {
        const cfg = MODELS[model];
        const jobId = await submitJob(c.env, endpointIdFor(c.env, model), {
          prompt,
          width: cfg.width,
          height: cfg.height,
          steps: cfg.steps,
        });
        return { model, jobId, generationId: crypto.randomUUID() };
      }),
    );

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO battle
           (id, userId, prompt, status, leftModel, rightModel, createdAt)
         VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
      ).bind(battleId, user.id, prompt, leftModel, rightModel, now),
      ...dispatched.map((d) =>
        c.env.DB.prepare(
          `INSERT INTO generation
             (id, userId, runpodJobId, prompt, status, model, battleId,
              width, height, steps, createdAt)
           VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          d.generationId,
          user.id,
          d.jobId,
          prompt,
          d.model,
          battleId,
          MODELS[d.model].width,
          MODELS[d.model].height,
          MODELS[d.model].steps,
          now,
        ),
      ),
    ]);

    return c.json({ battleId, status: "PENDING" });
  } catch (err) {
    await refundToken(c.env.DB, user.id, battleId);
    return c.json({ error: `dispatch failed: ${String(err)}` }, 502);
  }
});

/** Settle one generation against Runpod, persisting to R2 on completion. */
async function settle(c: Context<AppContext>, userId: string, gen: GenRow): Promise<GenRow> {
  if (gen.status !== "QUEUED" || !gen.runpodJobId) return gen;

  const state = await fetchJobState(
    c.env,
    endpointIdFor(c.env, gen.model),
    gen.runpodJobId,
  );

  if (state.status === "IN_QUEUE" || state.status === "IN_PROGRESS") return gen;

  if (state.status !== "COMPLETED" || !state.output) {
    const message = state.error ?? `job ${state.status.toLowerCase()}`;
    await c.env.DB.prepare(
      "UPDATE generation SET status = 'FAILED', error = ?, completedAt = ? WHERE id = ?",
    )
      .bind(message, Date.now(), gen.id)
      .run();
    return { ...gen, status: "FAILED", error: message };
  }

  const out = state.output;
  const imageKey = `${gen.id}.png`;
  await c.env.IMAGES.put(imageKey, decodeBase64(out.image), {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { userId, model: gen.model },
  });

  const completedAt = Date.now();
  const queueMs = completedAt - gen.createdAt;

  await c.env.DB.prepare(
    `UPDATE generation
        SET status='COMPLETED', imageKey=?, generateMs=?, queueMs=?,
            coldStart=?, gpu=?, completedAt=?
      WHERE id = ?`,
  )
    .bind(imageKey, out.generate_ms, queueMs, out.cold ? 1 : 0, out.gpu, completedAt, gen.id)
    .run();

  return {
    ...gen,
    status: "COMPLETED",
    imageKey,
    generateMs: out.generate_ms,
    queueMs,
    coldStart: out.cold ? 1 : 0,
    gpu: out.gpu,
  };
}

/**
 * Poll a battle.
 *
 * Model identity is withheld until the vote is recorded. That is enforced here, not
 * in the UI -- hiding labels client-side would still ship them in the JSON, and the
 * whole point of a blind test is data you can trust.
 */
arena.get("/api/battle/:id", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const battle = await c.env.DB.prepare(
    "SELECT * FROM battle WHERE id = ? AND userId = ?",
  )
    .bind(c.req.param("id"), user.id)
    .first<BattleRow>();
  if (!battle) return c.json({ error: "not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM generation WHERE battleId = ?",
  )
    .bind(battle.id)
    .all<GenRow>();

  const settled = await Promise.all(results.map((g) => settle(c, user.id, g)));
  const byModel = new Map(settled.map((g) => [g.model, g]));

  const done = settled.every((g) => g.status !== "QUEUED");
  const anyFailed = settled.some((g) => g.status === "FAILED");
  const revealed = battle.status === "VOTED";

  let status = battle.status;
  if (battle.status === "PENDING" && done) {
    status = anyFailed ? "FAILED" : "READY";
    await c.env.DB.prepare("UPDATE battle SET status = ? WHERE id = ?")
      .bind(status, battle.id)
      .run();
    // A comparison you cannot vote on is not what the token bought.
    if (anyFailed) await refundToken(c.env.DB, user.id, battle.id);
  }

  const slot = (model: ModelKey) => {
    const g = byModel.get(model);
    if (!g) return { status: "QUEUED" as const };
    return {
      status: g.status,
      url: g.imageKey ? `/i/${g.imageKey}` : null,
      generateMs: g.generateMs,
      queueMs: g.queueMs,
      cold: Boolean(g.coldStart),
      gpu: g.gpu,
      error: g.error,
      // Only after voting.
      ...(revealed ? { model, label: MODELS[model].label, blurb: MODELS[model].blurb } : {}),
    };
  };

  return c.json({
    id: battle.id,
    prompt: battle.prompt,
    status,
    left: slot(battle.leftModel),
    right: slot(battle.rightModel),
    ...(revealed
      ? {
          winner: battle.winnerModel === battle.leftModel ? "left" : "right",
          winnerModel: battle.winnerModel,
        }
      : {}),
  });
});

/** Record a pick. */
arena.post("/api/battle/:id/vote", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as { choice?: string } | null;
  if (body?.choice !== "left" && body?.choice !== "right") {
    return c.json({ error: "choice must be 'left' or 'right'" }, 400);
  }

  const battle = await c.env.DB.prepare(
    "SELECT * FROM battle WHERE id = ? AND userId = ?",
  )
    .bind(c.req.param("id"), user.id)
    .first<BattleRow>();
  if (!battle) return c.json({ error: "not found" }, 404);
  if (battle.status === "VOTED") return c.json({ error: "already voted" }, 409);
  if (battle.status !== "READY") {
    return c.json({ error: "both images must finish before voting" }, 409);
  }

  const winnerModel = body.choice === "left" ? battle.leftModel : battle.rightModel;

  // Guard on status inside the statement so a double-submit cannot count twice.
  const res = await c.env.DB.prepare(
    `UPDATE battle SET status='VOTED', winnerModel=?, votedAt=?
      WHERE id=? AND status='READY'`,
  )
    .bind(winnerModel, Date.now(), battle.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "already voted" }, 409);

  return c.json({
    winner: body.choice,
    winnerModel,
    leftModel: battle.leftModel,
    rightModel: battle.rightModel,
    labels: {
      left: MODELS[battle.leftModel].label,
      right: MODELS[battle.rightModel].label,
    },
  });
});

/**
 * Scoreboard, derived rather than stored.
 *
 * Both models appear in every battle, so votes is the denominator for both and a
 * counter can never drift away from the votes that produced it.
 */
arena.get("/api/leaderboard", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT winnerModel AS model, COUNT(*) AS wins
       FROM battle WHERE status='VOTED' AND winnerModel IS NOT NULL
      GROUP BY winnerModel`,
  ).all<{ model: ModelKey; wins: number }>();

  const total = results.reduce((sum, r) => sum + r.wins, 0);
  const wins = new Map(results.map((r) => [r.model, r.wins]));

  return c.json({
    votes: total,
    models: (Object.keys(MODELS) as ModelKey[]).map((model) => ({
      model,
      label: MODELS[model].label,
      blurb: MODELS[model].blurb,
      wins: wins.get(model) ?? 0,
      winRate: total ? (wins.get(model) ?? 0) / total : 0,
    })),
  });
});

/** Images this user picked as the winner. */
arena.get("/api/picks", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.prompt, g.imageKey, g.model, g.generateMs, g.gpu, b.createdAt
       FROM generation g
       JOIN battle b ON b.id = g.battleId
      WHERE b.userId = ? AND b.status='VOTED' AND g.model = b.winnerModel
        AND g.status='COMPLETED'
      ORDER BY b.votedAt DESC LIMIT 60`,
  )
    .bind(user.id)
    .all<{
      id: string; prompt: string; imageKey: string; model: ModelKey;
      generateMs: number; gpu: string; createdAt: number;
    }>();

  return c.json({
    images: results.map((r) => ({
      id: r.id,
      prompt: r.prompt,
      url: `/i/${r.imageKey}`,
      model: r.model,
      label: MODELS[r.model].label,
      generateMs: r.generateMs,
      gpu: r.gpu,
      createdAt: r.createdAt,
    })),
  });
});

/**
 * Global feed across every user.
 *
 * Restricted to voted battles: an unvoted battle in the feed would show its models
 * labelled, which would break the blind for the person still deciding.
 */
arena.get("/api/feed", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.prompt, g.imageKey, g.model, g.generateMs, g.gpu,
            b.votedAt, b.winnerModel
       FROM generation g
       JOIN battle b ON b.id = g.battleId
      WHERE b.status='VOTED' AND g.status='COMPLETED'
      ORDER BY b.votedAt DESC LIMIT 60`,
  ).all<{
    id: string; prompt: string; imageKey: string; model: ModelKey;
    generateMs: number; gpu: string; votedAt: number; winnerModel: ModelKey;
  }>();

  return c.json({
    images: results.map((r) => ({
      id: r.id,
      prompt: r.prompt,
      url: `/i/${r.imageKey}`,
      model: r.model,
      label: MODELS[r.model].label,
      won: r.model === r.winnerModel,
      generateMs: r.generateMs,
      gpu: r.gpu,
      createdAt: r.votedAt,
    })),
  });
});

export default arena;
