import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  GitCompareArrows,
  Lightbulb,
  RefreshCw,
  Upload,
  Package,
  Activity,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dashboard } from "./Dashboard";
import { ComparePanel } from "./ComparePanel";
import { InsightsPanel } from "./InsightsPanel";
import { SyncPanel } from "./SyncPanel";
import { ImportPanel } from "./ImportPanel";
import { PacketsPanel } from "./PacketsPanel";
import { PlatformView } from "./PlatformView";
import { useTranslation } from "react-i18next";

type Tab = "dashboard" | "platforms" | "compare" | "insights" | "sync" | "import" | "packets";

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "ana.tab_dashboard", icon: <BarChart3 size={14} /> },
  { key: "platforms", label: "ana.tab_platforms", icon: <Package size={14} /> },
  { key: "compare", label: "ana.tab_compare", icon: <GitCompareArrows size={14} /> },
  { key: "insights", label: "ana.tab_insights", icon: <Lightbulb size={14} /> },
  { key: "sync", label: "ana.tab_sync", icon: <RefreshCw size={14} /> },
  { key: "import", label: "ana.tab_import", icon: <Upload size={14} /> },
  { key: "packets", label: "ana.tab_packets", icon: <Package size={14} /> },
];

export function AnalyticsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("dashboard");
  const status = useQuery({
    queryKey: ["analytics-sync-status"],
    queryFn: () => api.analyticsSyncStatus(),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <Activity size={18} className="text-primary" />
          <h1 className="text-base font-semibold">{t("ana.title")}</h1>
          {status.data && (
            <span className="text-[11px] text-muted-foreground">
              {t("ana.syncableNote", { count: status.data.syncableTargets })}
            </span>
          )}
        </div>
        <nav className="flex gap-1">
          {TABS.map((tab2) => (
            <Button
              key={tab2.key}
              size="sm"
              variant={tab === tab2.key ? "secondary" : "ghost"}
              className={cn("gap-1.5 text-xs", tab === tab2.key && "bg-secondary")}
              onClick={() => setTab(tab2.key)}
            >
              {tab2.icon}
              {t(`ana.tab_${tab2.key}`)}
            </Button>
          ))}
        </nav>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {tab === "dashboard" && <Dashboard />}
          {tab === "platforms" && <PlatformView />}
        {tab === "compare" && <ComparePanel />}
        {tab === "insights" && <InsightsPanel />}
        {tab === "sync" && <SyncPanel />}
        {tab === "import" && <ImportPanel />}
        {tab === "packets" && <PacketsPanel />}
      </div>
    </div>
  );
}
