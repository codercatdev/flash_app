import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [stripeClient({ subscription: true })],
});

export const { signIn, signUp, signOut, useSession } = authClient;
