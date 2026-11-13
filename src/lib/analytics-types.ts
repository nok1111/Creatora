// Phase 9 — analytics TS mirrors of the Rust models (ADR-029).
// Every metric value carries its provenance: api | import | local.

export type MetricSource = "api" | "import" | "local";

export interface Metric {
  key: string;
  label: string;
  unit: string; // count | seconds | minutes | ratio | percent
  value: number;
}

export interface Unavailable {
  key: string;
  reason: string;
}

export interface Snapshot {
  id: string;
  targetId: string;
  platform: string;
  remoteId: string | null;
  period: string;
  source: MetricSource;
  fetchedAt: string;
  metrics: { metrics: Metric[]; unavailable: Unavailable[] };
}

export interface DashboardPost {
  targetId: string;
  platform: string;
  remoteId: string | null;
  source: MetricSource;
  fetchedAt: string;
  publishedAt: string | null;
  title: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  versionId: string | null;
  metrics: { metrics: Metric[]; unavailable: Unavailable[] };
}

export interface Dashboard {
  windowDays: number;
  posts: DashboardPost[];
}

export interface SyncRun {
  id: string;
  triggerKind: "manual" | "scheduled";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "partial" | "failed" | "cancelled";
  targetsTotal: number;
  targetsOk: number;
  targetsFailed: number;
  errors: string[];
}

export interface SyncStatus {
  intervalMinutes: number;
  lastFinishedAt: string | null;
  syncableTargets: number;
}

export interface Insight {
  kind: string;
  title: string;
  detail: string;
  evidence: string;
  sampleSize: number;
  caveat: string;
}

export interface CompareResult {
  metricKeys: string[];
  rows: CompareRow[];
}

export interface CompareRow {
  targetId: string;
  platform?: string;
  remoteId?: string | null;
  source?: MetricSource;
  fetchedAt?: string;
  title?: string;
  publishedAt?: string | null;
  durationMs?: number | null;
  metrics: Record<string, number>;
  unavailable?: Unavailable[];
  noData?: boolean;
}

export interface ImportPreviewRow {
  platform: string;
  remoteId: string;
  period: string;
  date: string | null;
  title: string | null;
  metrics: [string, number][];
  targetId: string | null;
  issue: string | null;
}

export interface ImportPreview {
  format: string;
  rowsSeen: number;
  rows: ImportPreviewRow[];
  columns: string[];
  matched: number;
  unmatched: number;
  issues: string[];
}

export interface ImportBatch {
  id: string;
  filename: string;
  format: string;
  sourceLabel: string;
  rowsSeen: number;
  rowsImported: number;
  rowsSkipped: number;
  createdAt: string;
}

export interface PublishPacket {
  id: string;
  targetId: string;
  dirPath: string;
  files: string[];
  createdAt: string;
}

export const METRIC_LABEL: Record<string, string> = {
  views: "Views",
  impressions: "Impressions",
  reach: "Reach",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  watch_time_minutes: "Watch time (min)",
  avg_view_duration_sec: "Avg view (s)",
  followers_gained: "Followers gained",
  ig_total_interactions: "Total interactions",
  yt_impressions_ctr: "Impressions CTR (%)",
};

export function metricValue(
  m: { metrics: Metric[] } | { metrics: Metric[]; unavailable: Unavailable[] },
  key: string,
): number | null {
  const hit = m.metrics.find((x) => x.key === key);
  return hit ? hit.value : null;
}
