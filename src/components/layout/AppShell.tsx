import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MODULES } from "@/app/nav";
import { cn } from "@/lib/utils";

/**
 * App shell: compact horizontal top navigation over a full-width
 * workspace. Creative Pop identity — coral active pill on a graphite
 * topbar. One workspace, not an admin panel.
 */
export function AppShell() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-topbar-border bg-topbar px-3">
        {/* Brand */}
        <div className="mr-2 flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
            C
          </div>
          <span className="hidden text-sm font-semibold tracking-wide text-topbar-accent-foreground sm:inline">
            Creatora
          </span>
        </div>

        <nav aria-label="Main navigation" className="flex items-center gap-1">
          {MODULES.map((m) => (
            <NavLink
              key={m.key}
              to={m.path}
              end={m.path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-topbar-foreground transition-colors",
                  "hover:bg-topbar-accent hover:text-topbar-accent-foreground",
                  isActive &&
                    "bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground",
                )
              }
            >
              <m.icon className="size-4 shrink-0" />
              <span className="hidden truncate md:inline">{t(`nav.${m.key}`)}</span>
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-slim">
        <Outlet />
      </main>
    </div>
  );
}
