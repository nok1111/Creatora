import { useMemo } from "react";
import { cn } from "@/lib/utils";

/** Deterministic 32-bit hash — same asset id always draws the same bars. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Audio fallback tile — a synthetic waveform in brand coral on a dark
 * bed, deterministic per `seed` so each asset gets a stable "shape".
 * Used wherever an audio asset has no real waveform thumbnail.
 */
export function AudioTile({
  seed,
  bars = 36,
  className,
}: {
  seed: string;
  bars?: number;
  className?: string;
}) {
  const heights = useMemo(() => {
    let state = hashSeed(seed) || 1;
    const rnd = () => {
      // xorshift32
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    // smooth-ish envelope: centre-biased amplitude + jitter
    return Array.from({ length: bars }, (_, i) => {
      const env = Math.sin((Math.PI * i) / (bars - 1)) ** 0.7;
      return 0.12 + env * (0.35 + rnd() * 0.5);
    });
  }, [seed, bars]);

  const W = 160;
  const H = 90;
  const bw = W / bars;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("size-full", className)}
      role="img"
      aria-label="Audio"
    >
      <rect width={W} height={H} fill="#1B1A22" />
      {heights.map((v, i) => {
        const bh = Math.max(3, v * H);
        return (
          <rect
            key={i}
            x={i * bw + bw * 0.22}
            y={(H - bh) / 2}
            width={bw * 0.56}
            height={bh}
            rx={bw * 0.2}
            fill="hsl(var(--primary))"
            opacity={0.55 + v * 0.45}
          />
        );
      })}
      <rect width={W} height={H} fill="none" stroke="hsl(var(--border))" strokeWidth={0} />
    </svg>
  );
}
