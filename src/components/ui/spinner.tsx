import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-full border-2 border-current border-t-transparent",
        "size-3.5",
        className,
      )}
      style={{ animation: "spin 0.65s cubic-bezier(0.5,0,0.5,1) infinite" }}
      aria-hidden
    />
  );
}
