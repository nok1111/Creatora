import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MODULES } from "@/app/nav";
import { cn } from "@/lib/utils";

/**
 * App shell: fixed left navigation rail + content area.
 * The rail uses its own surface token (sidebar) which stays dark in both
 * themes — the editing shell is dark-first by design.
 */
export function AppShell() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full">
      <nav
        aria-label="Main navigation"
        className="flex w-14 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-3 lg:w-48 lg:items-stretch lg:px-2"
      >
        <div className="mb-4 flex items-center justify-center gap-2 px-2 lg:justify-start">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            C
          </div>
          <span className="hidden text-sm font-semibold tracking-wide text-sidebar-accent-foreground lg:inline">
            Creatora
          </span>
        </div>

        {MODULES.map((m) => (
          <NavLink
            key={m.key}
            to={m.path}
            end={m.path === "/"}
            title={t(`nav.${m.key}`)}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors",
                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "justify-center lg:justify-start",
                isActive &&
                  "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_hsl(var(--primary))]",
              )
            }
          >
            <m.icon className="size-4 shrink-0" />
            <span className="hidden truncate lg:inline">{t(`nav.${m.key}`)}</span>
          </NavLink>
        ))}
      </nav>

      <main className="min-w-0 flex-1 overflow-auto scrollbar-slim">
        <Outlet />
      </main>
    </div>
  );
}
