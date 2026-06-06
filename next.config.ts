import type { NextConfig } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4002";
const validApiUrl = API_URL.startsWith("http://") || API_URL.startsWith("https://") ? API_URL : "http://localhost:4002";

const nextConfig: NextConfig = {
  // Proxy /api/auth/* through Next.js so auth cookies are set on the same
  // domain as the frontend — eliminates cross-domain state_mismatch entirely.
  rewrites: async () => [
    {
      source: "/api/:path*",
      destination: `${validApiUrl}/api/:path*`,
    },
    {
      source: "/media/:path*",
      destination: `${validApiUrl}/media/:path*`,
    },
  ],
  headers: async () => {
    return [{ source: "/(.*)", headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ]}];
  },
};

export default nextConfig;
