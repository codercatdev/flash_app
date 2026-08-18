import { useEffect, useRef, useState } from "react";

import { ApiError, type Battle, type Slot, api } from "../api";

const POLL_MS = 1500;

/**
 * One side of the comparison.
 *
 * The image slot holds its shape from the moment the prompt is submitted, so the
 * layout never jumps when the two models finish at different times (Turbo is ~10x
 * faster than FLUX, so they always do).
 */
function Side({
  slot,
  side,
  battle,
  onVote,
  voting,
}: {
  slot: Slot;
  side: "left" | "right";
  battle: Battle;
  onVote: (choice: "left" | "right") => void;
  voting: boolean;
}) {
  const revealed = battle.status === "VOTED";
  const isWinner = revealed && battle.winner === side;
  const letter = side === "left" ? "A" : "B";

  return (
    <figure className={`card side ${isWinner ? "winner" : ""}`}>
      <div className="side-head">
        <span className="letter">{letter}</span>
        {revealed && slot.label ? (
          <span className={`badge model ${slot.model}`}>{slot.label}</span>
        ) : (
          <span className="muted">hidden until you pick</span>
        )}
        {isWinner && <span className="badge warm">your pick</span>}
      </div>

      <div className="slot">
        {slot.status === "COMPLETED" && slot.url ? (
          <img src={slot.url} alt={`Option ${letter}`} />
        ) : slot.status === "FAILED" ? (
          <div className="slot-msg error">{slot.error ?? "generation failed"}</div>
        ) : (
          <div className="slot-msg spinner-wrap">
            <span className="spinner" aria-hidden="true" />
            <span className="muted">generating…</span>
          </div>
        )}
      </div>

      <figcaption>
        {slot.status === "COMPLETED" && (
          <div className="badges">
            <span className="badge gpu">{slot.generateMs}ms GPU</span>
            <span className={`badge ${slot.cold ? "cold" : "warm"}`}>
              {slot.cold ? "cold start" : "warm"}
            </span>
          </div>
        )}
        {battle.status === "READY" && (
          <button
            className="vote"
            onClick={() => onVote(side)}
            disabled={voting}
          >
            Pick {letter}
          </button>
        )}
      </figcaption>
    </figure>
  );
}

export function Arena({
  onBalanceChange,
  onPaywall,
  onVoted,
}: {
  onBalanceChange: () => void;
  onPaywall: () => void;
  onVoted: () => void;
}) {
  const [prompt, setPrompt] = useState(
    "a cat astronaut floating over neon Tokyo, cinematic",
  );
  const [battle, setBattle] = useState<Battle | null>(null);
  const [busy, setBusy] = useState(false);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  // Poll until both sides settle.
  useEffect(() => {
    if (!battle || (battle.status !== "PENDING" && battle.status !== "READY")) return;
    if (battle.status === "READY") return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await api<Battle>(`/api/battle/${battle.id}`);
        if (cancelled) return;
        setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
        setBattle(next);
        if (next.status !== "PENDING") {
          setBusy(false);
          onBalanceChange();
        }
      } catch {
        /* transient; next tick retries */
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [battle, onBalanceChange]);

  async function start() {
    setBusy(true);
    setError(null);
    setBattle(null);
    setElapsed(0);
    startedAt.current = Date.now();

    try {
      const { battleId } = await api<{ battleId: string }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setBattle(await api<Battle>(`/api/battle/${battleId}`));
      onBalanceChange();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 402) onPaywall();
      else setError(err instanceof Error ? err.message : "something went wrong");
    }
  }

  async function vote(choice: "left" | "right") {
    if (!battle) return;
    setVoting(true);
    try {
      await api(`/api/battle/${battle.id}/vote`, {
        method: "POST",
        body: JSON.stringify({ choice }),
      });
      setBattle(await api<Battle>(`/api/battle/${battle.id}`));
      onVoted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "vote failed");
    }
    setVoting(false);
  }

  return (
    <>
      <div className="card">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          maxLength={800}
          placeholder="Describe an image…"
        />
        <div className="controls">
          <span className="muted">
            Two models, same prompt. Pick the one you like — you won't be told which
            is which until after.
          </span>
          <button onClick={start} disabled={busy || !prompt.trim()}>
            {busy ? "Generating…" : "Compare · 1 token"}
          </button>
        </div>
        {busy && battle?.status === "PENDING" && (
          <p className="status">
            {elapsed > 30
              ? `Cold start — provisioning GPUs and downloading weights (${elapsed}s)`
              : `Generating on two GPUs… (${elapsed}s)`}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      {battle && (
        <>
          {battle.status === "READY" && (
            <h2 className="ask">Which do you prefer?</h2>
          )}
          {battle.status === "FAILED" && (
            <p className="error">
              A model failed on this one — your token was refunded.
            </p>
          )}
          <div className="arena">
            <Side slot={battle.left} side="left" battle={battle} onVote={vote} voting={voting} />
            <Side slot={battle.right} side="right" battle={battle} onVote={vote} voting={voting} />
          </div>
        </>
      )}
    </>
  );
}
