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

export const auth = betterAuth({
  // AUTH_BASE_URL must be the FRONTEND (Vercel) URL in production.
  // Auth is proxied through Next.js rewrites so cookies are set on the frontend domain.
  baseURL: process.env.AUTH_BASE_URL || "http://localhost:4002",
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS || "http://localhost:3005")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
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
