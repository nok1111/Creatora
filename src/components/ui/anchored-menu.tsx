import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * AnchoredMenu / AnchoredPopup — floating UI rendered through a portal so it
 * is never clipped by `overflow` ancestors (the structural cause of the
 * clipped popovers in the editor). Position is computed from the anchor's
 * live bounding rect, flipped when the preferred side lacks room, and clamped
 * inside the viewport.
 */

export type AnchorPoint = { x: number; y: number };
export type AnchorSource =
  | RefObject<HTMLElement | null>
  | HTMLElement
  | DOMRect
  | AnchorPoint;

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const MARGIN = 8;

interface ResolvedRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function resolveRect(anchor: AnchorSource | null): ResolvedRect | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  if ("current" in anchor) return anchor.current?.getBoundingClientRect() ?? null;
  if ("top" in anchor) return anchor;
  return {
    top: anchor.y,
    bottom: anchor.y,
    left: anchor.x,
    right: anchor.x,
    width: 0,
    height: 0,
  };
}

/** Element the anchor points at (for "don't close when clicking the trigger"). */
function resolveEl(anchor: AnchorSource | null): HTMLElement | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor;
  if ("current" in anchor) return anchor.current;
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Positions `ref`'s element (position: fixed) next to the anchor. Writes left/
 * top directly to DOM style — no re-render loop. Re-places every render while
 * open plus on window resize and on any ancestor scroll (capture phase).
 */
function useAnchoredPosition(
  open: boolean,
  anchor: AnchorSource | null,
  side: Side,
  align: Align,
  offset: number,
) {
  const ref = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const el = ref.current;
    const r = resolveRect(anchor);
    if (!el || !r) return;
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let s = side;
    const spaceTop = r.top - MARGIN - offset;
    const spaceBottom = vh - r.bottom - offset - MARGIN;
    const spaceRight = vw - r.right - offset - MARGIN;
    const spaceLeft = r.left - offset - MARGIN;
    if (s === "top" && mh > spaceTop && spaceBottom > spaceTop) s = "bottom";
    else if (s === "bottom" && mh > spaceBottom && spaceTop > spaceBottom) s = "top";
    else if (s === "right" && mw > spaceRight && spaceLeft > spaceRight) s = "left";
    else if (s === "left" && mw > spaceLeft && spaceRight > spaceLeft) s = "right";

    let top: number;
    let left: number;
    if (s === "top" || s === "bottom") {
      top = s === "top" ? r.top - mh - offset : r.bottom + offset;
      left =
        align === "start"
          ? r.left
          : align === "end"
            ? r.right - mw
            : r.left + r.width / 2 - mw / 2;
    } else {
      left = s === "right" ? r.right + offset : r.left - mw - offset;
      top =
        align === "start"
          ? r.top
          : align === "end"
            ? r.bottom - mh
            : r.top + r.height / 2 - mh / 2;
    }

    el.style.left = `${clamp(left, MARGIN, Math.max(MARGIN, vw - mw - MARGIN))}px`;
    el.style.top = `${clamp(top, MARGIN, Math.max(MARGIN, vh - mh - MARGIN))}px`;
    el.style.maxHeight = `${vh - MARGIN * 2}px`;
    el.style.maxWidth = `${vw - MARGIN * 2}px`;
    el.style.visibility = "visible";
  }, [anchor, side, align, offset]);

  // Re-place every render while open (content/anchor may change size).
  useLayoutEffect(() => {
    if (open) place();
  });

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return ref;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [role="menuitem"]:not([aria-disabled="true"])',
    ),
  );
}

export interface AnchoredPopupProps {
  open: boolean;
  anchor: AnchorSource | null;
  side?: Side;
  align?: Align;
  offset?: number;
  className?: string;
  children?: ReactNode;
}

/** Non-interactive floating panel (hover previews, flyouts). No focus or
 * dismiss handling — purely visual. */
export function AnchoredPopup({
  open,
  anchor,
  side = "right",
  align = "start",
  offset = 6,
  className,
  children,
}: AnchoredPopupProps) {
  const ref = useAnchoredPosition(open, anchor, side, align, offset);
  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={cn("fixed z-50", className)}
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface AnchoredMenuProps extends AnchoredPopupProps {
  onClose: () => void;
  role?: string;
}

/** Portal menu anchored to an element or a point (context menus). Handles
 * Escape, outside pointerdown, and roving arrow-key focus between items. */
export function AnchoredMenu({
  open,
  onClose,
  anchor,
  side = "bottom",
  align = "start",
  offset = 6,
  className,
  children,
  role = "menu",
}: AnchoredMenuProps) {
  const ref = useAnchoredPosition(open, anchor, side, align, offset);

  // Dismiss: Escape anywhere; pointerdown outside the menu (except on the
  // anchor element itself, whose own click toggles).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const menu = ref.current;
      const target = e.target as Node;
      if (menu?.contains(target)) return;
      const anchorEl = resolveEl(anchor);
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, onClose, anchor]);

  // Focus first item on open. Live QA: WebView2 reports menu items
  // visibility:hidden for ~50-80ms after mount even though the container is
  // already visible, and focus() on a hidden element is a no-op — so retry
  // per frame until the focus actually lands (bounded).
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let tries = 0;
    const tryFocus = () => {
      const target = focusables(el)[0] ?? el;
      if (document.activeElement === target) return;
      target.focus();
      if (document.activeElement !== target && ++tries < 10) {
        raf = requestAnimationFrame(tryFocus);
      }
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = ref.current;
    if (!el) return;
    const items = focusables(el);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length].focus();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowRight") move(idx + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") move(idx - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
  };

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      tabIndex={-1}
      className={cn(
        "fixed z-50 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none",
        className,
      )}
      style={{ left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

export const AnchoredMenuItem = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { destructive?: boolean }
>(({ className, destructive, type, ...props }, ref) => (
  <button
    ref={ref}
    type={type ?? "button"}
    role="menuitem"
    className={cn(
      "flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors focus:bg-secondary focus:text-secondary-foreground disabled:pointer-events-none disabled:opacity-50",
      destructive && "text-destructive focus:bg-destructive/10",
      className,
    )}
    {...props}
  />
));
AnchoredMenuItem.displayName = "AnchoredMenuItem";

export const AnchoredMenuSeparator = ({ className }: { className?: string }) => (
  <div role="separator" className={cn("-mx-1 my-1 h-px bg-border", className)} />
);
