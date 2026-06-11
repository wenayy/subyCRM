"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { setActiveUser } from "@/lib/page-cache";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  // Scope the cache to the current user on every render — before any child reads it.
  // This ensures a different user never gets a cache hit from a previous user's session.
  setActiveUser(session?.user?.id ?? null);

  useEffect(() => {
    if (!isPending && !session) {
      router.replace(`/sign-in?callbackURL=${encodeURIComponent(pathname)}`);
    }
  }, [isPending, pathname, router, session]);

  if (isPending || !session) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", color: "var(--t2)", fontSize: 13 }}>
        Checking session...
      </div>
    );
  }

  return <>{children}</>;
}
