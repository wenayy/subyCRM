import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "./prisma";

const allowSignUp =
  process.env.AUTH_ALLOW_SIGN_UP === "true" ||
  process.env.NEXT_PUBLIC_AUTH_ALLOW_SIGN_UP === "true";

const allowedEmails = (process.env.AUTH_ALLOWED_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const socialProviders =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          disableSignUp: !allowSignUp,
        },
      }
    : undefined;

const isProd = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  baseURL: process.env.AUTH_BASE_URL || "http://localhost:4002",
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS || "http://localhost:3005")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  advanced: {
    // Cross-origin OAuth (Vercel frontend → Railway backend → Google → Railway callback)
    // requires SameSite=None so Google's cross-site redirect sends the state cookie back.
    defaultCookieAttributes: isProd
      ? { sameSite: "none" as const, secure: true }
      : {},
  },
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: !allowSignUp,
  },
  socialProviders,
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      requireLocalEmailVerified: false,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (allowedEmails.length === 0) return;
          const email = String(user.email || "").toLowerCase();
          if (!allowedEmails.includes(email)) return false;
        },
      },
    },
  },
});
