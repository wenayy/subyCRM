"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { clearAllCache } from "@/lib/page-cache";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isPending && !session) {
      router.replace(`/sign-in?callbackURL=${encodeURIComponent(pathname)}`);
    }
  }, [isPending, pathname, router, session]);

  // Clear stale cache when the logged-in user changes so no user ever sees another's data
  useEffect(() => {
    const currentId = session?.user?.id ?? null;
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== currentId) {
      clearAllCache();
    }
    prevUserIdRef.current = currentId;
  }, [session?.user?.id]);

  if (isPending || !session) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", color: "var(--t2)", fontSize: 13 }}>
        Checking session...
      </div>
    );
  }

  return <>{children}</>;
}
