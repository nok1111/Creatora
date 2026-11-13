// Minimal SVG charts — no chart library, honest data only.
// Every point rendered is a real stored value; zero invention.

export function MiniLine({
  points,
  width = 220,
  height = 56,
  className,
}: {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-muted-foreground border border-dashed border-border rounded"
        style={{ width, height }}
      >
        no data
      </div>
    );
  }
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const path = points
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / span) * (height - 6) - 3;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} className={className}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {points.map((v, i) => {
        const x = i * step;
        const y = height - ((v - min) / span) * (height - 6) - 3;
        return <circle key={i} cx={x} cy={y} r="2" fill="currentColor" />;
      })}
    </svg>
  );
}

export function MiniBar({
  values,
  labels,
  width = 320,
  height = 120,
  className,
}: {
  values: number[];
  labels?: string[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-muted-foreground border border-dashed border-border rounded"
        style={{ width, height }}
      >
        no data
      </div>
    );
  }
  const max = Math.max(...values, 1);
  const bw = width / values.length;
  return (
    <svg width={width} height={height} className={className}>
      {values.map((v, i) => {
        const h = (v / max) * (height - 18);
        return (
          <g key={i}>
            <rect
              x={i * bw + 2}
              y={height - h - 14}
              width={Math.max(bw - 4, 2)}
              height={h}
              rx="2"
              className="fill-primary/70"
            />
            {labels?.[i] !== undefined && (
              <text
                x={i * bw + bw / 2}
                y={height - 2}
                textAnchor="middle"
                fontSize="9"
                className="fill-muted-foreground"
              >
                {labels[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const cls =
    source === "api"
      ? "bg-green-500/15 text-green-400"
      : source === "import"
        ? "bg-amber-500/15 text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${cls}`}>
      {source}
    </span>
  );
}
