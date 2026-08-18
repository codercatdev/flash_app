import type { Auth } from "./auth";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export type AppContext = {
  Bindings: Env;
  Variables: {
    auth: Auth;
    user: SessionUser | null;
  };
};
