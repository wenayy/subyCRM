import { createAuthClient } from "better-auth/react";

// Auth is proxied through Next.js (/api/auth/* → Railway backend via next.config.ts rewrite).
// Using a relative baseURL means cookies are set on the same domain as the frontend,
// which eliminates the cross-domain state_mismatch on Google OAuth.
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined"
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  fetchOptions: {
    credentials: "include",
  },
});
