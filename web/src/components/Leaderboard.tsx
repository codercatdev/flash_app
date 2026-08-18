import type { Leaderboard as LeaderboardData } from "../api";

export function Leaderboard({ data }: { data: LeaderboardData | null }) {
  if (!data) return null;

  if (data.votes === 0) {
    return (
      <div className="card leaderboard empty">
        <span className="muted">No votes yet — the first comparison starts the scoreboard.</span>
      </div>
    );
  }

  return (
    <div className="card leaderboard">
      <div className="leaderboard-head">
        <strong>Model scores</strong>
        <span className="muted">{data.votes} vote{data.votes === 1 ? "" : "s"}</span>
      </div>
      {data.models.map((m) => (
        <div key={m.model} className="score-row">
          <div className="score-label">
            <span>{m.label}</span>
            <span className="muted">{m.blurb}</span>
          </div>
          <div className="meter" role="img" aria-label={`${Math.round(m.winRate * 100)}% win rate`}>
            <div className={`meter-fill ${m.model}`} style={{ width: `${m.winRate * 100}%` }} />
          </div>
          <span className="score-num">
            {Math.round(m.winRate * 100)}% · {m.wins}
          </span>
        </div>
      ))}
    </div>
  );
}
