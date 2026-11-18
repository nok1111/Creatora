/**
 * Creatora logomark — coral tile, graphite "C" with a cream play
 * triangle nested in the opening. Single SVG source; the raster app
 * icons in src-tauri/icons/ are generated from this geometry via
 * qa/gen_icons.py.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-label="Creatora"
    >
      <defs>
        <linearGradient id="creatora-mark-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF8A70" />
          <stop offset="1" stopColor="#F0522F" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#creatora-mark-grad)" />
      <path
        d="M 347.3 356.7 A 140 140 0 1 1 347.3 155.3"
        fill="none"
        stroke="#241F1A"
        strokeWidth="66"
      />
      <path
        d="M 310 214 L 310 298 L 392 256 Z"
        fill="#F4F0E8"
        stroke="#F4F0E8"
        strokeWidth="14"
        strokeLinejoin="round"
      />
    </svg>
  );
}
