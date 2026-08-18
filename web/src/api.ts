export type ModelKey = "sdxl-turbo" | "flux-schnell";

export type Me = {
  user: { id: string; email: string; name: string } | null;
  balance: number;
  subscription: { plan: string; status: string } | null;
  plans?: Record<string, { tokens: number }>;
  freeGrant?: number;
};

/** One side of a comparison. `model`/`label` are absent until the vote is cast. */
export type Slot = {
  status: "QUEUED" | "COMPLETED" | "FAILED";
  url?: string | null;
  generateMs?: number | null;
  queueMs?: number | null;
  cold?: boolean;
  gpu?: string | null;
  error?: string | null;
  model?: ModelKey;
  label?: string;
  blurb?: string;
};

export type Battle = {
  id: string;
  prompt: string;
  status: "PENDING" | "READY" | "VOTED" | "FAILED";
  left: Slot;
  right: Slot;
  winner?: "left" | "right";
  winnerModel?: ModelKey;
};

export type Leaderboard = {
  votes: number;
  models: {
    model: ModelKey;
    label: string;
    blurb: string;
    wins: number;
    winRate: number;
  }[];
};

export type GalleryImage = {
  id: string;
  prompt: string;
  url: string;
  model: ModelKey;
  label: string;
  won?: boolean;
  generateMs: number;
  gpu: string;
  createdAt: number;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; balance?: number },
  ) {
    super(body.error ?? `request failed (${status})`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body as { error?: string });
  return body as T;
}
