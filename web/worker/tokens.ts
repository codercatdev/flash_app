/**
 * Token ledger.
 *
 * Better Auth's Stripe plugin manages subscriptions but has no concept of
 * credits or one-time balances, so metering is ours to build. The ledger is
 * append-only: balance is SUM(delta), never a mutable counter. That buys two
 * things that matter on Cloudflare:
 *
 *  1. D1 has no interactive transactions (only batch()), so a read-then-write
 *     "check balance, then decrement" is genuinely racy. `spendToken` instead
 *     does the check and the write in one conditional INSERT.
 *  2. Stripe delivers webhooks at least once. Grants carry the Stripe event id
 *     in `externalId`, which is UNIQUE -- a redelivered event hits the
 *     constraint and is ignored instead of double-granting.
 */

export const FREE_SIGNUP_TOKENS = 5;

/** Tokens granted per billing period, keyed by Better Auth plan name. */
export const PLAN_TOKENS: Record<string, number> = {
  pro: 500,
};

export type LedgerReason =
  | "signup_grant"
  | "subscription_grant"
  | "generate"
  | "refund";

export async function getBalance(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE userId = ?",
    )
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

/**
 * Append a ledger entry.
 *
 * Returns false when `externalId` has already been recorded -- i.e. a duplicate
 * Stripe delivery -- so callers can treat replay as a no-op rather than an error.
 */
export async function addLedgerEntry(
  db: D1Database,
  entry: {
    userId: string;
    delta: number;
    reason: LedgerReason;
    externalId?: string | null;
  },
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO credit_ledger (id, userId, delta, reason, externalId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        entry.userId,
        entry.delta,
        entry.reason,
        entry.externalId ?? null,
        Date.now(),
      )
      .run();
    return true;
  } catch (err) {
    if (String(err).includes("UNIQUE")) return false;
    throw err;
  }
}

/**
 * Atomically spend one token.
 *
 * The WHERE clause re-evaluates the balance inside the same statement that
 * writes the debit, so two concurrent generations cannot both pass a check that
 * only one of them should. Returns false when the user cannot afford it.
 */
export async function spendToken(
  db: D1Database,
  userId: string,
  cost = 1,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO credit_ledger (id, userId, delta, reason, externalId, createdAt)
       SELECT ?1, ?2, ?3, 'generate', NULL, ?4
       WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE userId = ?2) >= ?5`,
    )
    .bind(crypto.randomUUID(), userId, -cost, Date.now(), cost)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Give a token back when a generation fails on the GPU side. */
export async function refundToken(
  db: D1Database,
  userId: string,
  generationId: string,
): Promise<boolean> {
  // Keyed on the generation id so a repeated poll of the same failed job
  // cannot refund twice.
  return addLedgerEntry(db, {
    userId,
    delta: 1,
    reason: "refund",
    externalId: `refund:${generationId}`,
  });
}
