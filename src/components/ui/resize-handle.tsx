import { useRef } from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  /** "vertical" → divider between columns (drag on X). */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  /** +1: dragging right/down grows; -1: left/up grows. */
  grow?: 1 | -1;
  /** Double-click resets to this value. */
  defaultValue?: number;
  /** (px, commit) — commit=false mid-drag, true on release/keyboard. */
  onResize: (px: number, commit: boolean) => void;
  className?: string;
  label?: string;
}

/** Draggable panel separator. Pointer-capture drag with live updates, hard
 * min/max clamps, keyboard support (arrows ±16, Shift ±48), double-click
 * reset, and a visible hover/focus affordance. */
export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  grow = 1,
  defaultValue,
  onResize,
  className,
  label,
}: ResizeHandleProps) {
  const drag = useRef<{ start: number; base: number } | null>(null);
  const vertical = orientation === "vertical";
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));

  const pos = (e: { clientX: number; clientY: number }) =>
    vertical ? e.clientX : e.clientY;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      className={cn(
        "shrink-0 touch-none select-none bg-transparent outline-none transition-colors hover:bg-primary/50 focus-visible:bg-primary/50",
        vertical ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { start: pos(e), base: value };
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* jsdom lacks pointer capture — drag still works via the element */
        }
      }}
      onPointerMove={(e) => {
        if (drag.current)
          onResize(clamp(drag.current.base + grow * (pos(e) - drag.current.start)), false);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        onResize(clamp(drag.current.base + grow * (pos(e) - drag.current.start)), true);
        drag.current = null;
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => {
        if (defaultValue != null) onResize(clamp(defaultValue), true);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        let delta = 0;
        if (vertical && e.key === "ArrowRight") delta = step;
        else if (vertical && e.key === "ArrowLeft") delta = -step;
        else if (!vertical && e.key === "ArrowDown") delta = step;
        else if (!vertical && e.key === "ArrowUp") delta = -step;
        if (delta) {
          e.preventDefault();
          onResize(clamp(value + grow * delta), true);
        }
      }}
    />
  );
}
