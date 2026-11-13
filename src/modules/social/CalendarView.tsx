import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, List, Zap } from "lucide-react";
import { api } from "@/lib/ipc";
import { PLATFORM_LABEL, type ScheduledItem } from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Mode = "month" | "week" | "list";

function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Local calendar — month/week/list, drag to reschedule.
 * Reminder ≠ publish: items only auto-upload when autoPublish is on
 * AND the app is open at the due time (scheduler tick).
 */
export function CalendarView({
  onOpenPost,
}: {
  onOpenPost: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("month");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [statusFilter, setStatusFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");

  const { from, to } = useMemo(() => {
    if (mode === "week") {
      const f = new Date(cursor);
      f.setDate(f.getDate() - f.getDay());
      const t = new Date(f);
      t.setDate(t.getDate() + 7);
      return { from: isoLocal(f), to: isoLocal(t) };
    }
    if (mode === "list") {
      const t = new Date(cursor);
      t.setMonth(t.getMonth() + 3);
      return { from: isoLocal(new Date(2020, 0, 1)), to: isoLocal(t) };
    }
    const f = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const t = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    return { from: isoLocal(f), to: isoLocal(t) };
  }, [mode, cursor]);

  const { data: items, refetch } = useQuery({
    queryKey: ["scheduled", from, to],
    queryFn: () => api.listScheduled(from, to),
  });

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (i) =>
          (!statusFilter || i.status === statusFilter) &&
          (!platformFilter || i.platform === platformFilter),
      ),
    [items, statusFilter, platformFilter],
  );

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduledItem[]>();
    for (const i of filtered) {
      const day = i.scheduledAt.slice(0, 10);
      m.set(day, [...(m.get(day) ?? []), i]);
    }
    return m;
  }, [filtered]);

  const move = (dir: number) => {
    const d = new Date(cursor);
    if (mode === "week") d.setDate(d.getDate() + dir * 7);
    else if (mode === "month") d.setMonth(d.getMonth() + dir);
    else d.setDate(d.getDate() + dir * 30);
    setCursor(startOfDay(d));
  };

  const days = useMemo(() => {
    if (mode === "week") {
      const f = new Date(cursor);
      f.setDate(f.getDate() - f.getDay());
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(f);
        d.setDate(d.getDate() + i);
        return d;
      });
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startPad = first.getDay();
    const dim = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const cells: (Date | null)[] = Array(startPad).fill(null);
    for (let d = 1; d <= dim; d++) {
      cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    }
    return cells;
  }, [mode, cursor]);

  const drop = async (e: React.DragEvent, day: Date) => {
    const tid = e.dataTransfer.getData("text/target-id");
    if (!tid) return;
    const item = items?.find((i) => i.targetId === tid);
    if (!item) return;
    const time = item.scheduledAt.slice(11, 16) || "12:00";
    const d = new Date(day);
    const [h, m] = time.split(":").map(Number);
    d.setHours(h, m, 0, 0);
    await api.schedulePostTarget(tid, isoLocal(d), item.autoPublish);
    toast.success(`Rescheduled to ${d.toLocaleDateString()}`);
    void refetch();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-xs">
        <Button size="sm" variant="ghost" onClick={() => move(-1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="w-44 text-center text-sm font-medium">
          {mode === "week"
            ? `Week of ${new Date(from).toLocaleDateString()}`
            : cursor.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
        </span>
        <Button size="sm" variant="ghost" onClick={() => move(1)}>
          <ChevronRight className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setCursor(startOfDay(new Date()))}>
          Today
        </Button>
        <div className="flex-1" />
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="h-7 rounded border border-input bg-background px-1.5"
        >
          <option value="">All platforms</option>
          {Object.entries(PLATFORM_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-7 rounded border border-input bg-background px-1.5"
        >
          <option value="">All statuses</option>
          {["draft", "ready", "scheduled", "published", "failed"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="flex rounded border border-input p-0.5">
          {(["month", "week", "list"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 capitalize",
                mode === m && "bg-primary text-primary-foreground",
              )}
            >
              {m === "list" && <List className="size-3" />}
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {mode === "list" ? (
          <div className="space-y-1.5">
            {filtered.map((i) => (
              <div
                key={i.targetId}
                className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2 text-xs hover:bg-accent"
                onClick={() => onOpenPost(i.postId)}
              >
                <span className="w-40 text-muted-foreground">
                  {new Date(i.scheduledAt).toLocaleString()}
                </span>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  {PLATFORM_LABEL[i.platform]}
                </span>
                <span className="flex-1 truncate font-medium">{i.title}</span>
                {i.autoPublish && <Zap className="size-3 text-amber-400" />}
                <span className="text-[10px] uppercase text-muted-foreground">
                  {i.status}
                </span>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Nothing scheduled in this range.
              </p>
            )}
          </div>
        ) : (
          <div className="grid h-full grid-cols-7 gap-1">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div
                key={d}
                className="pb-1 text-center text-[10px] font-medium uppercase text-muted-foreground"
              >
                {d}
              </div>
            ))}
            {days.map((d, i) => {
              if (!d) return <div key={i} />;
              const key = isoLocal(d).slice(0, 10);
              const dayItems = byDay.get(key) ?? [];
              const isToday = key === isoLocal(new Date()).slice(0, 10);
              return (
                <div
                  key={i}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => void drop(e, d)}
                  className={cn(
                    "min-h-20 rounded border border-border p-1",
                    isToday && "border-primary/50 bg-primary/5",
                  )}
                >
                  <p className="text-[10px] text-muted-foreground">
                    {d.getDate()}
                  </p>
                  {dayItems.map((it) => (
                    <button
                      key={it.targetId}
                      draggable
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/target-id", it.targetId)
                      }
                      onClick={() => onOpenPost(it.postId)}
                      className={cn(
                        "mt-0.5 block w-full truncate rounded px-1 py-0.5 text-left text-[10px]",
                        it.status === "published"
                          ? "bg-green-500/15 text-green-400"
                          : it.status === "failed"
                            ? "bg-red-500/15 text-red-400"
                            : "bg-primary/10 text-primary",
                      )}
                      title={`${PLATFORM_LABEL[it.platform]} · ${it.scheduledAt.slice(11, 16)}${it.autoPublish ? " · auto" : " · reminder"}`}
                    >
                      {it.autoPublish && <Zap className="mr-0.5 inline size-2" />}
                      {it.title || PLATFORM_LABEL[it.platform]}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="border-t border-border px-5 py-1.5 text-[10px] text-muted-foreground">
        Local scheduling: items publish automatically only when marked ⚡
        auto-publish with a connected account + exported file, while the app
        is open. Everything else is a reminder — nothing is ever marked
        "published" without a real upload.
      </p>
    </div>
  );
}
