import { useCallback, useEffect, useRef, useState } from "react";

import { authClient, signIn, signOut, signUp } from "./auth-client";

type Me = {
  user: { id: string; email: string; name: string } | null;
  balance: number;
  subscription: { plan: string; status: string } | null;
  plans?: Record<string, { tokens: number }>;
  freeGrant?: number;
};

type Generation = {
  id: string;
  prompt: string;
  url: string;
  generateMs: number;
  queueMs: number;
  cold: boolean;
  gpu: string;
  createdAt: number;
};

const POLL_MS = 1200;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("request failed"), { status: res.status, body });
  return body as T;
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
      <p className="muted">
        New accounts start with free tokens. One token per image.
      </p>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        )}
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          type="password"
          placeholder="Password (8+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          minLength={8}
          required
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signup" ? "Sign up" : "Sign in"}
        </button>
      </form>
      <button
        className="link"
        onClick={() => {
          setMode(mode === "signup" ? "signin" : "signup");
          setError(null);
        }}
      >
        {mode === "signup"
          ? "Already have an account? Sign in"
          : "Need an account? Sign up"}
      </button>
    </div>
  );
}

function Paywall({ tokens, onClose }: { tokens: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  async function upgrade() {
    setBusy(true);
    // Redirects to Stripe Checkout, then back to successUrl.
    await authClient.subscription.upgrade({
      plan: "pro",
      successUrl: "/?upgraded=1",
      cancelUrl: "/",
    });
    setBusy(false);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>You're out of tokens</h2>
        <p className="muted">
          Upgrade to Pro for {tokens} tokens every month on Runpod Flash
          serverless GPUs. Cancel anytime.
        </p>
        <button onClick={upgrade} disabled={busy}>
          {busy ? "Redirecting…" : "Upgrade to Pro"}
        </button>
        <button className="link" onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  );
}

function Badge({ gen }: { gen: Generation }) {
  return (
    <div className="badges">
      <span className="badge gpu">{gen.generateMs}ms GPU</span>
      <span className={`badge ${gen.cold ? "cold" : "warm"}`}>
        {gen.cold ? "cold start" : "warm"} · {(gen.queueMs / 1000).toFixed(1)}s total
      </span>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [prompt, setPrompt] = useState("a cat astronaut floating over neon Tokyo, cinematic");
  const [steps, setSteps] = useState(2);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [busy, setBusy] = useState(false);
  const elapsed = useRef<number>(0);

  const refresh = useCallback(async () => {
    const [meRes, gens] = await Promise.all([
      api<Me>("/api/me"),
      api<{ generations: Generation[] }>("/api/generations").catch(() => ({
        generations: [],
      })),
    ]);
    setMe(meRes);
    setGenerations(gens.generations);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function manageBilling() {
    // Stripe-hosted Customer Portal: cancel, swap card, download invoices.
    // Requires a portal configuration to exist in the Stripe Dashboard --
    // without one this call fails, it is not created automatically.
    await authClient.subscription.billingPortal({ returnUrl: "/" });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus("Submitting…");
    elapsed.current = Date.now();

    try {
      const { id } = await api<{ id: string }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ prompt, steps }),
      });

      // Poll until terminal. Cold starts can take minutes (provision + model
      // download), so the UI reports elapsed time rather than pretending.
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const secs = Math.round((Date.now() - elapsed.current) / 1000);
        const state = await api<{
          status: string;
          url?: string;
          error?: string;
          stage?: string;
        }>(`/api/generate/${id}`);

        if (state.status === "COMPLETED") {
          setStatus(null);
          break;
        }
        if (state.status === "FAILED") {
          setError(state.error ?? "Generation failed — your token was refunded.");
          setStatus(null);
          break;
        }
        setStatus(
          secs > 25
            ? `Cold start — provisioning a GPU and downloading the model (${secs}s)`
            : `Generating… (${secs}s)`,
        );
      }
    } catch (err) {
      const e = err as { status?: number; body?: { error?: string } };
      if (e.status === 402) setPaywall(true);
      else setError(e.body?.error ?? "Something went wrong");
      setStatus(null);
    }

    setBusy(false);
    await refresh();
  }

  if (!me) return <div className="shell loading">Loading…</div>;

  if (!me.user) {
    return (
      <div className="shell">
        <Hero />
        <Auth onDone={refresh} />
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
              <button className="link" onClick={manageBilling}>
                Manage billing
              </button>
            </>
          ) : (
            <button className="link" onClick={() => setPaywall(true)}>
              Upgrade
            </button>
          )}
          <button
            className="link"
            onClick={async () => {
              await signOut();
              await refresh();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="card">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          maxLength={800}
          placeholder="Describe an image…"
        />
        <div className="controls">
          <label>
            Steps
            <input
              type="range"
              min={1}
              max={8}
              value={steps}
              onChange={(e) => setSteps(Number(e.target.value))}
            />
            <span className="muted">{steps}</span>
          </label>
          <button onClick={generate} disabled={busy || !prompt.trim()}>
            {busy ? "Generating…" : "Generate · 1 token"}
          </button>
        </div>
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {generations.length > 0 && (
        <div className="gallery">
          {generations.map((gen) => (
            <figure key={gen.id} className="card tile">
              <img src={gen.url} alt={gen.prompt} loading="lazy" />
              <figcaption>
                <p>{gen.prompt}</p>
                <Badge gen={gen} />
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {paywall && (
        <Paywall
          tokens={me.plans?.pro.tokens ?? 500}
          onClose={() => setPaywall(false)}
        />
      )}
    </div>
  );
}

function Hero() {
  return (
    <div className="hero">
      <h1>Flash Image Studio</h1>
      <p>
        SDXL-Turbo on a Runpod Flash serverless GPU, fronted by Cloudflare
        Workers, D1, and R2. No Dockerfile anywhere in this stack.
      </p>
    </div>
  );
}
