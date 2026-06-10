"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Building2,
  CalendarDays,
  Clock3,
  Home,
  Inbox,
  ListChecks,
  LogOut,
  Menu,
  Mic,
  Network,
  Settings,
  SquareKanban,
  Users,
  X,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { remindersApi, inboxApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badgeKey?: "overdue" | "unread_inbox";
};

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Today",
    items: [
      { label: "Overview", href: "/dashboard", icon: Home },
      { label: "Inbox", href: "/dashboard/inbox", icon: Inbox, badgeKey: "unread_inbox" },
    ],
  },
  {
    label: "People",
    items: [
      { label: "Contacts", href: "/dashboard/contacts", icon: Users },
      { label: "Companies", href: "/dashboard/companies", icon: Building2 },
      { label: "Network", href: "/dashboard/network", icon: Network },
    ],
  },
  {
    label: "Pipeline",
    items: [
      { label: "Pipeline", href: "/dashboard/pipeline", icon: SquareKanban },
      { label: "Sequences", href: "/dashboard/sequences", icon: ListChecks },
    ],
  },
  {
    label: "Schedule",
    items: [
      { label: "Pre-call", href: "/dashboard/prep", icon: CalendarDays },
      { label: "Reminders", href: "/dashboard/reminders", icon: Clock3, badgeKey: "overdue" },
      { label: "Voice", href: "/dashboard/voice", icon: Mic },
    ],
  },
  {
    label: "System",
    items: [{ label: "Settings", href: "/dashboard/settings", icon: Settings }],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [overdueCount, setOverdueCount] = useState(0);
  const [unreadInbox, setUnreadInbox] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    if (nextTheme === "dark") {
      document.documentElement.classList.add("dark");
      localStorage.theme = "dark";
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.theme = "light";
    }
  };

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    remindersApi
      .getDue()
      .then((reminders) => setOverdueCount(reminders.length))
      .catch(() => {});

    const refreshInbox = () => inboxApi.getStats().then((s) => setUnreadInbox(s.unread)).catch(() => {});
    refreshInbox();
    const interval = setInterval(refreshInbox, 30000);
    window.addEventListener("inbox-read", refreshInbox);
    return () => { clearInterval(interval); window.removeEventListener("inbox-read", refreshInbox); };
  }, []);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  const signOut = async () => {
    await authClient.signOut();
    router.replace("/sign-in");
  };

  return (
    <>
      <Button
        aria-label="Toggle menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="fixed left-3 top-3 z-[60] hidden shadow-sm max-md:inline-flex"
        size="icon"
        type="button"
        variant="outline"
      >
        {open ? <X /> : <Menu />}
      </Button>

      {open && (
        <button
          aria-label="Close menu"
          className="fixed inset-0 z-[49] hidden bg-black/20 max-md:block"
          onClick={() => setOpen(false)}
          type="button"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-card transition-transform duration-200 max-md:shadow-xl",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="grid size-9 place-items-center rounded-lg border border-neutral-200/50 shrink-0" style={{ backgroundColor: "var(--logo-bg)" }}>
            <svg width="28" height="23" viewBox="0 0 28 23" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-[23px] w-[28px]">
              <path d="M26.909 11.6757C27.1422 11.2682 27.7767 11.2924 27.8508 11.756C27.912 12.1386 27.9434 12.5277 27.9434 12.9221L27.9422 13.0523C27.8455 18.5588 21.6278 23.0012 13.9717 23.0012L13.6112 22.9981C6.12137 22.8612 0.0964018 18.4721 0.00120746 13.0523L0 12.9221C0 12.6453 0.0154857 12.3712 0.0458512 12.1001C0.0979141 11.6352 0.724876 11.5804 0.975115 11.9756C3.0944 15.3227 8.06169 17.6717 13.8517 17.6718C19.8132 17.6718 24.9024 15.1815 26.909 11.6757Z" fill="var(--logo-fill)"/>
              <path d="M13.4904 16.071C6.27475 15.961 0.481546 12.4061 0.481534 8.03683L0.482553 7.93295C0.574946 3.54219 6.51771 2.16109e-07 13.835 0L13.835 1.16329C10.5725 1.16329 8.2581 1.48543 5.95295 3.07411C3.74776 4.5939 3.58813 6.17292 3.74007 7.1604C3.83167 7.75575 4.05017 8.34667 4.43788 8.80766C4.70264 9.12246 5.14443 9.51307 5.95295 9.99969C7.79068 11.1057 10.5725 11.9105 13.835 11.9105C17.0976 11.9105 19.8794 11.1057 21.7171 9.99969C21.929 9.87216 22.1184 9.74783 22.2877 9.62763C23.4395 8.80992 24.1691 7.30939 23.9705 5.9109C23.8388 4.98418 23.2914 3.91957 21.7171 3.07411C19.8794 1.96808 17.0976 1.16329 13.835 1.16329L13.835 0L14.1797 0.00264375C21.3953 0.112664 27.1885 3.66755 27.1885 8.03683C27.1885 12.4754 21.21 16.0737 13.835 16.0737L13.4904 16.071Z" fill="var(--logo-fill)"/>
            </svg>
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">Suby Contacts</div>
            <div className="truncate text-xs text-muted-foreground">Personal CRM</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {SECTIONS.map((section) => (
            <div key={section.label} className="mb-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground px-5 pb-1">{section.label}</div>
              <nav className="grid gap-0.5 px-2">
                {section.items.map((item) => {
                  const active = isActive(item.href);
                  const badge = item.badgeKey === "overdue" ? overdueCount : item.badgeKey === "unread_inbox" ? unreadInbox : 0;
                  const Icon = item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "sidebar-nav-item group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
                        active
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {badge > 0 && (
                        <span className="grid min-w-5 place-items-center rounded-full bg-status-red-bg px-1.5 text-[10px] font-semibold leading-5 text-status-red animate-fade-in">
                          {badge}
                        </span>
                      )}
                      {active && (
                        <span className="absolute -left-2 top-2 bottom-2 w-0.5 rounded-full bg-foreground" />
                      )}
                    </Link>
                  );
                })}
              </nav>
            </div>
          ))}
        </div>

        <div className="border-t border-border p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 px-2">
            <span className="truncate text-xs text-muted-foreground">
              {session?.user?.email || "Signed in"}
            </span>
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer shrink-0"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
          </div>
          <Button
            className="w-full justify-start"
            onClick={signOut}
            size="sm"
            type="button"
            variant="outline"
          >
            <LogOut />
            Sign out
          </Button>
        </div>
      </aside>
    </>
  );
}
