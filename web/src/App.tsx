import { useCallback, useEffect, useState } from "react";

import {
  type GalleryImage,
  type Leaderboard as LeaderboardData,
  type Me,
  api,
} from "./api";
import { authClient, signIn, signOut, signUp } from "./auth-client";
import { Arena } from "./components/Arena";
import { Gallery } from "./components/Gallery";
import { Leaderboard } from "./components/Leaderboard";

type Tab = "arena" | "picks" | "everyone";

function Hero() {
  return (
    <div className="hero">
      <h1>Flash Image Studio</h1>
      <p>
        Two text-to-image models, same prompt, side by side on Runpod Flash
        serverless GPUs. Pick a winner and watch the scoreboard move.
      </p>
    </div>
  );
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result =
      mode === "signup"
        ? await signUp.email({ email, password, name: name || email.split("@")[0] })
        : await signIn.email({ email, password });
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Something went wrong");
    else onDone();
  }

  return (
    <div className="card auth">
      <h2>{mode === "signup" ? "Create an account" : "Welcome back"}</h2>
      <p className="muted">New accounts start with free tokens. One token per comparison.</p>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        )}
        <input
          type="email" placeholder="you@example.com" value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="email" required
        />
        <input
          type="password" placeholder="Password (8+ characters)" value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          minLength={8} required
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signup" ? "Sign up" : "Sign in"}
        </button>
      </form>
      <button className="link" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); }}>
        {mode === "signup" ? "Already have an account? Sign in" : "Need an account? Sign up"}
      </button>
    </div>
  );
}

function Paywall({ tokens, onClose }: { tokens: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  async function upgrade() {
    setBusy(true);
    await authClient.subscription.upgrade({ plan: "pro", successUrl: "/?upgraded=1", cancelUrl: "/" });
    setBusy(false);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>You're out of tokens</h2>
        <p className="muted">
          Upgrade to Pro for {tokens} tokens every month on Runpod Flash serverless
          GPUs. Cancel anytime.
        </p>
        <button onClick={upgrade} disabled={busy}>{busy ? "Redirecting…" : "Upgrade to Pro"}</button>
        <button className="link" onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("arena");
  const [board, setBoard] = useState<LeaderboardData | null>(null);
  const [picks, setPicks] = useState<GalleryImage[]>([]);
  const [feed, setFeed] = useState<GalleryImage[]>([]);
  const [paywall, setPaywall] = useState(false);

  const refreshMe = useCallback(async () => {
    setMe(await api<Me>("/api/me"));
  }, []);

  const refreshBoard = useCallback(async () => {
    setBoard(await api<LeaderboardData>("/api/leaderboard").catch(() => null));
  }, []);

  useEffect(() => {
    void refreshMe();
    void refreshBoard();
  }, [refreshMe, refreshBoard]);

  // Galleries are fetched lazily so the arena tab stays fast.
  useEffect(() => {
    if (tab === "picks") {
      void api<{ images: GalleryImage[] }>("/api/picks")
        .then((r) => setPicks(r.images))
        .catch(() => setPicks([]));
    }
    if (tab === "everyone") {
      void api<{ images: GalleryImage[] }>("/api/feed")
        .then((r) => setFeed(r.images))
        .catch(() => setFeed([]));
    }
  }, [tab]);

  if (!me) return <div className="shell loading">Loading…</div>;

  if (!me.user) {
    return (
      <div className="shell">
        <Hero />
        <Auth onDone={refreshMe} />
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>Flash Image Studio</strong>
          <span className="muted"> · {me.user.email}</span>
        </div>
        <div className="topbar-right">
          <span className={`tokens ${me.balance === 0 ? "empty" : ""}`}>
            {me.balance} tokens
          </span>
          {me.subscription ? (
            <>
              <span className="badge warm">{me.subscription.plan}</span>
              <button
                className="link"
                onClick={() => authClient.subscription.billingPortal({ returnUrl: "/" })}
              >
                Manage billing
              </button>
            </>
          ) : (
            <button className="link" onClick={() => setPaywall(true)}>Upgrade</button>
          )}
          <button className="link" onClick={async () => { await signOut(); await refreshMe(); }}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs">
        {([
          ["arena", "Arena"],
          ["picks", "My picks"],
          ["everyone", "Everyone"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "arena" && (
        <>
          <Leaderboard data={board} />
          <Arena
            onBalanceChange={refreshMe}
            onPaywall={() => setPaywall(true)}
            onVoted={refreshBoard}
          />
        </>
      )}

      {tab === "picks" && (
        <Gallery
          images={picks}
          emptyMessage="Nothing picked yet. Run a comparison in the Arena and choose a favourite."
        />
      )}

      {tab === "everyone" && (
        <>
          <p className="muted notice">
            Every comparison anyone votes on shows up here — prompts included.
          </p>
          <Gallery
            images={feed}
            showWinner
            emptyMessage="No votes yet. Be the first."
          />
        </>
      )}

      {paywall && (
        <Paywall tokens={me.plans?.pro.tokens ?? 500} onClose={() => setPaywall(false)} />
      )}
    </div>
  );
}
