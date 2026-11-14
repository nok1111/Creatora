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

type Tab = "dashboard" | "platforms" | "compare" | "insights" | "sync" | "import" | "packets";

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "Dashboard", icon: <BarChart3 size={14} /> },
  { key: "platforms", label: "Platforms", icon: <Package size={14} /> },
  { key: "compare", label: "Compare", icon: <GitCompareArrows size={14} /> },
  { key: "insights", label: "Insights", icon: <Lightbulb size={14} /> },
  { key: "sync", label: "Sync", icon: <RefreshCw size={14} /> },
  { key: "import", label: "Import", icon: <Upload size={14} /> },
  { key: "packets", label: "Publish packets", icon: <Package size={14} /> },
];

export function AnalyticsPage() {
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
          <h1 className="text-base font-semibold">Analytics</h1>
          {status.data && (
            <span className="text-[11px] text-muted-foreground">
              {status.data.syncableTargets} published targets syncable
            </span>
          )}
        </div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <Button
              key={t.key}
              size="sm"
              variant={tab === t.key ? "secondary" : "ghost"}
              className={cn("gap-1.5 text-xs", tab === t.key && "bg-secondary")}
              onClick={() => setTab(t.key)}
            >
              {t.icon}
              {t.label}
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
