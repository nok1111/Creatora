import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, List, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/ipc";
import { PLATFORM_LABEL, type ScheduledItem } from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";
import { PlatformIcon } from "./PlatformIcon";

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

/** First day of the week for the UI language (0 = Sunday … 6 = Saturday). */
function weekStart(lang: string): number {
  try {
    const l = new Intl.Locale(lang) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const wi = l.getWeekInfo?.() ?? l.weekInfo;
    if (wi) return wi.firstDay % 7;
  } catch {
    /* fall through to the heuristic */
  }
  return lang.startsWith("en") ? 0 : 1;
}

const LOCKED = new Set(["published", "publishing"]);

/**
 * Local calendar — month/week/list, drag to reschedule, click a day to start
 * a post scheduled there.
 * Reminder ≠ publish: items only auto-upload when autoPublish is on
 * AND the app is open at the due time (scheduler tick).
 */
export function CalendarView({
  onOpenPost,
  onCreateOnDay,
}: {
  onOpenPost: (id: string) => void;
  /** Local datetime ("YYYY-MM-DDTHH:mm", 12:00) of the clicked day. */
  onCreateOnDay?: (scheduleAt: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<Mode>("month");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [statusFilter, setStatusFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [dragDay, setDragDay] = useState<string | null>(null);
  const fd = weekStart(i18n.language);

  const startOfWeek = (d: Date) => {
    const f = startOfDay(d);
    f.setDate(f.getDate() - ((f.getDay() - fd + 7) % 7));
    return f;
  };

  const { from, to } = useMemo(() => {
    if (mode === "week") {
      const f = startOfWeek(cursor);
      const e = new Date(f);
      e.setDate(e.getDate() + 7);
      return { from: isoLocal(f), to: isoLocal(e) };
    }
    const f = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const e = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + (mode === "list" ? 3 : 1),
      1,
    );
    return { from: isoLocal(f), to: isoLocal(e) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cursor, fd]);

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
    for (const list of m.values())
      list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return m;
  }, [filtered]);

  const move = (dir: number) => {
    const d = new Date(cursor);
    if (mode === "week") d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setCursor(startOfDay(d));
  };

  const days = useMemo(() => {
    if (mode === "week") {
      const f = startOfWeek(cursor);
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(f);
        d.setDate(d.getDate() + i);
        return d;
      });
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startPad = (first.getDay() - fd + 7) % 7;
    const dim = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const cells: (Date | null)[] = Array(startPad).fill(null);
    for (let d = 1; d <= dim; d++) {
      cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    }
    return cells;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cursor, fd]);

  const drop = async (e: React.DragEvent, day: Date) => {
    setDragDay(null);
    const tid = e.dataTransfer.getData("text/target-id");
    if (!tid) return;
    const item = items?.find((i) => i.targetId === tid);
    if (!item || LOCKED.has(item.status)) return;
    const time = item.scheduledAt.slice(11, 16) || "12:00";
    const d = new Date(day);
    const [h, m] = time.split(":").map(Number);
    d.setHours(h, m, 0, 0);
    try {
      await api.schedulePostTarget(tid, isoLocal(d), item.autoPublish);
      toast.success(t("cal.rescheduled", { date: d.toLocaleDateString(i18n.language) }));
      void refetch();
    } catch (err) {
      reportError(err);
    }
  };

  const monthLabel = (d: Date) =>
    d.toLocaleDateString(i18n.language, { month: "long", year: "numeric" });
  const headerLabel =
    mode === "week"
      ? t("cal.weekOf", { date: new Date(from).toLocaleDateString(i18n.language) })
      : mode === "list"
        ? `${monthLabel(new Date(from))} – ${monthLabel(
            new Date(cursor.getFullYear(), cursor.getMonth() + 2, 1),
          )}`
        : monthLabel(cursor);

  const dayNoon = (d: Date) => {
    const x = new Date(d);
    x.setHours(12, 0, 0, 0);
    return isoLocal(x);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-xs">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => move(-1)}
          aria-label={t("cal.prev")}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-44 text-center text-sm font-medium capitalize">
          {headerLabel}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => move(1)}
          aria-label={t("cal.next")}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setCursor(startOfDay(new Date()))}>
          {t("cal.today")}
        </Button>
        <div className="flex-1" />
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="h-7 rounded border border-input bg-background px-1.5"
          aria-label={t("social.allPlatforms")}
        >
          <option value="">{t("social.allPlatforms")}</option>
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
          aria-label={t("social.allStatuses")}
        >
          <option value="">{t("social.allStatuses")}</option>
          {["draft", "ready", "scheduled", "published", "failed"].map((s) => (
            <option key={s} value={s}>
              {t(`social.st_${s}`)}
            </option>
          ))}
        </select>
        <div className="flex rounded border border-input p-0.5">
          {(["month", "week", "list"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5",
                mode === m && "bg-primary text-primary-foreground",
              )}
            >
              {m === "list" && <List className="size-3" />}
              {t(`cal.${m}`)}
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
                  {new Date(i.scheduledAt).toLocaleString(i18n.language)}
                </span>
                <span className="flex items-center gap-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  <PlatformIcon platform={i.platform} className="size-3" />
                  {PLATFORM_LABEL[i.platform]}
                </span>
                <span className="flex-1 truncate font-medium">{i.title}</span>
                {i.autoPublish && <Zap className="size-3 text-warning" />}
                <span className="text-[10px] uppercase text-muted-foreground">
                  {t(`social.st_${i.status}`, { defaultValue: i.status })}
                </span>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("cal.empty")}
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-7 content-start gap-1">
            {Array.from({ length: 7 }, (_, i) => (
              <div
                key={i}
                className="pb-1 text-center text-[10px] font-medium uppercase text-muted-foreground"
              >
                {new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(
                  new Date(2024, 0, 7 + fd + i), // 2024-01-07 is a Sunday
                )}
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
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragDay !== key) setDragDay(key);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                      setDragDay((cur) => (cur === key ? null : cur));
                  }}
                  onDrop={(e) => void drop(e, d)}
                  onClick={() => onCreateOnDay?.(dayNoon(d))}
                  title={onCreateOnDay ? t("cal.newOnDay") : undefined}
                  data-day={key}
                  className={cn(
                    "min-h-24 rounded border border-border p-1 transition-colors",
                    onCreateOnDay && "cursor-pointer hover:bg-accent/40",
                    isToday && "border-primary/50 bg-primary/5",
                    dragDay === key && "border-primary bg-primary/15",
                  )}
                >
                  <p className="text-[10px] text-muted-foreground">
                    {d.getDate()}
                  </p>
                  {dayItems.map((it) => (
                    <button
                      key={it.targetId}
                      draggable={!LOCKED.has(it.status)}
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/target-id", it.targetId)
                      }
                      onDragEnd={() => setDragDay(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPost(it.postId);
                      }}
                      className={cn(
                        "mt-0.5 flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px]",
                        it.status === "published"
                          ? "bg-success/15 text-success"
                          : it.status === "failed"
                            ? "bg-destructive/15 text-destructive"
                            : "bg-primary/10 text-primary",
                      )}
                      title={`${PLATFORM_LABEL[it.platform]} · ${it.scheduledAt.slice(11, 16)} · ${it.autoPublish ? t("cal.auto") : t("cal.reminder")}`}
                    >
                      <PlatformIcon
                        platform={it.platform}
                        colored={false}
                        className="size-2.5"
                      />
                      <span className="shrink-0 tabular-nums opacity-70">
                        {it.scheduledAt.slice(11, 16)}
                      </span>
                      {it.autoPublish && <Zap className="size-2 shrink-0" />}
                      <span className="truncate">
                        {it.title || PLATFORM_LABEL[it.platform]}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="border-t border-border px-5 py-1.5 text-[10px] text-muted-foreground">
        {t("cal.footer")}
      </p>
    </div>
  );
}
