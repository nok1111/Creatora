import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { api } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "12m" },
];

export function InsightsPanel() {
  const [days, setDays] = useState(90);
  const q = useQuery({
    queryKey: ["analytics-insights", days],
    queryFn: () => api.analyticsInsights(days),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              className={cn(
                "px-2.5 py-1 text-xs rounded",
                days === w.days ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          Computed locally from stored snapshots — works offline. Every card
          shows its sample size; small samples mean weak evidence.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {(q.data ?? []).map((i) => (
          <div key={i.kind} className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-2">
              <Lightbulb size={14} className="text-amber-400" />
              <div className="text-sm font-medium">{i.title}</div>
            </div>
            <p className="mt-2 text-xs">{i.detail}</p>
            <div className="mt-3 space-y-1 text-[11px] text-muted-foreground">
              <div>Evidence: {i.evidence}</div>
              <div>Sample: n={i.sampleSize}</div>
              <div className="text-amber-400/80">{i.caveat}</div>
            </div>
          </div>
        ))}
        {q.data?.length === 0 && (
          <div className="col-span-2 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Not enough stored data for insights yet — sync or import stats
            first.
          </div>
        )}
      </div>
    </div>
  );
}
