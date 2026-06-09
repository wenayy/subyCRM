import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}

// ── Reusable skeleton layouts ─────────────────────────────────────────────────

export function ContactCardSkeleton() {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card">
      <Skeleton className="size-10 rounded-full shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-48" />
      </div>
      <Skeleton className="h-5 w-14 rounded-full" />
    </div>
  );
}

export function ContactsPageSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <ContactCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ContactDetailSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6 max-w-5xl mx-auto animate-pulse">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
          <div className="flex gap-2 mt-2">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-14 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-24 rounded-lg" />)}
        </div>
      </div>
      {/* 2-col grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-4">
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function CompanyCardSkeleton() {
  return (
    <div className="p-4 rounded-xl border border-border bg-card space-y-2">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg shrink-0" />
        <div className="space-y-1.5 flex-1">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

export function CompaniesPageSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {Array.from({ length: 9 }).map((_, i) => (
        <CompanyCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function PipelineSkeleton() {
  return (
    <div className="flex gap-4 p-4 overflow-x-auto">
      {Array.from({ length: 5 }).map((_, col) => (
        <div key={col} className="flex flex-col gap-2 min-w-[220px]">
          <Skeleton className="h-6 w-24 rounded-md mb-1" />
          {Array.from({ length: 3 - (col % 2) }).map((_, i) => (
            <div key={i} className="p-3 rounded-xl border border-border bg-card space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function RemindersSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
          <Skeleton className="size-4 rounded-full shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-56" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-14 rounded-md" />
        </div>
      ))}
    </div>
  );
}

export function NetworkSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
          <Skeleton className="size-9 rounded-full shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
      ))}
    </div>
  );
}
