import { cn } from "@/lib/utils";

export type SpotKind = "media" | "projects" | "stats" | "posts" | "search" | "export" | "library";

const C = {
  line: "hsl(var(--muted-foreground))",
  faint: "hsl(var(--muted-foreground) / 0.4)",
  coral: "hsl(var(--primary))",
  lav: "hsl(var(--accent-foreground))",
  lime: "hsl(var(--success))",
  butter: "hsl(var(--warning))",
};

/**
 * Spot illustrations for empty states — light line art in brand tones.
 * Each kind is a small composition; kept flat and quiet so the copy and
 * the action button stay the focus.
 */
export function SpotArt({ kind, className }: { kind: SpotKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 110"
      className={cn("h-24 w-auto", className)}
      role="img"
      aria-hidden
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "media" && (
        <g stroke={C.line} strokeWidth={3}>
          <rect x={30} y={22} width={100} height={66} rx={8} />
          <line x1={30} y1={36} x2={130} y2={36} stroke={C.faint} />
          <line x1={30} y1={74} x2={130} y2={74} stroke={C.faint} />
          {[44, 60, 76, 92, 108].map((x) => (
            <g key={x} stroke={C.faint} strokeWidth={2}>
              <line x1={x} y1={22} x2={x} y2={36} />
              <line x1={x} y1={74} x2={x} y2={88} />
            </g>
          ))}
          <path d={`M 72 44 L 72 66 L 92 55 Z`} fill={C.coral} stroke={C.coral} strokeWidth={4} />
          <line x1={52} y1={98} x2={108} y2={98} stroke={C.faint} strokeWidth={3} />
        </g>
      )}
      {kind === "projects" && (
        <g stroke={C.line} strokeWidth={3}>
          <path d="M 34 40 L 66 40 L 74 48 L 126 48 L 126 88 L 34 88 Z" />
          <path d="M 34 40 L 34 34 L 60 34 L 66 40" />
          <rect x={52} y={56} width={40} height={24} rx={3} stroke={C.coral} />
          <path d="M 68 61 L 68 75 L 82 68 Z" fill={C.coral} stroke={C.coral} strokeWidth={3} />
          <line x1={100} y1={62} x2={118} y2={62} stroke={C.faint} />
          <line x1={100} y1={70} x2={112} y2={70} stroke={C.faint} />
        </g>
      )}
      {kind === "stats" && (
        <g stroke={C.line} strokeWidth={3}>
          <line x1={36} y1={90} x2={128} y2={90} />
          <rect x={46} y={58} width={14} height={32} rx={2} fill={C.coral} stroke={C.coral} opacity={0.85} />
          <rect x={70} y={42} width={14} height={48} rx={2} fill={C.lav} stroke={C.lav} opacity={0.85} />
          <rect x={94} y={66} width={14} height={24} rx={2} fill={C.lime} stroke={C.lime} opacity={0.85} />
          <path d="M 42 50 L 66 34 L 88 46 L 118 26" stroke={C.butter} />
          <circle cx={118} cy={26} r={3.5} fill={C.butter} stroke={C.butter} />
        </g>
      )}
      {kind === "posts" && (
        <g stroke={C.line} strokeWidth={3}>
          <rect x={56} y={18} width={52} height={80} rx={9} />
          <line x1={72} y1={26} x2={92} y2={26} stroke={C.faint} />
          <rect x={64} y={38} width={36} height={22} rx={4} fill={C.coral} stroke={C.coral} opacity={0.85} />
          <line x1={64} y1={68} x2={100} y2={68} stroke={C.faint} />
          <line x1={64} y1={76} x2={92} y2={76} stroke={C.faint} />
          <path d="M 40 52 L 40 72 L 52 72" stroke={C.lav} />
          <circle cx={40} cy={46} r={7} stroke={C.lav} />
        </g>
      )}
      {kind === "search" && (
        <g stroke={C.line} strokeWidth={3}>
          <rect x={38} y={30} width={84} height={56} rx={7} strokeDasharray="7 6" />
          <circle cx={86} cy={56} r={18} stroke={C.coral} strokeWidth={4} />
          <line x1={99} y1={69} x2={114} y2={84} stroke={C.coral} strokeWidth={5} />
          <path d="M 78 48 L 78 64 L 92 56 Z" fill={C.coral} stroke="none" />
        </g>
      )}
      {kind === "export" && (
        <g stroke={C.line} strokeWidth={3}>
          <rect x={40} y={64} width={80} height={26} rx={6} />
          <line x1={80} y1={22} x2={80} y2={56} stroke={C.coral} strokeWidth={4} />
          <path d="M 66 36 L 80 20 L 94 36" stroke={C.coral} strokeWidth={4} />
          <line x1={56} y1={77} x2={72} y2={77} stroke={C.faint} />
          <circle cx={104} cy={77} r={4} stroke={C.lime} fill={C.lime} />
        </g>
      )}
      {kind === "library" && (
        <g stroke={C.line} strokeWidth={3}>
          <rect x={34} y={28} width={26} height={58} rx={3} />
          <rect x={66} y={28} width={26} height={58} rx={3} />
          <rect x={98} y={34} width={26} height={52} rx={3} transform={`rotate(10 111 60)`} />
          <path d="M 41 56 L 41 72 M 47 52 L 47 72 M 53 58 L 53 72" stroke={C.coral} strokeWidth={2.5} />
          <circle cx={79} cy={52} r={7} stroke={C.lav} />
        </g>
      )}
    </svg>
  );
}
