import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef, useState } from "react";
import {
  AnchoredMenu,
  AnchoredMenuItem,
  AnchoredPopup,
} from "@/components/ui/anchored-menu";

// AnchoredMenu must render through a portal (never clipped by overflow
// ancestors), close on Escape/outside pointerdown, keep clicks on its own
// items working, and support arrow-key navigation.

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function Harness({ onClose }: { onClose: () => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <div style={{ overflow: "hidden", height: 10 }}>
      <button ref={btnRef} id="trigger" onClick={() => setOpen(!open)}>
        trigger
      </button>
      <AnchoredMenu
        open={open}
        onClose={onClose}
        anchor={btnRef}
        side="top"
        align="start"
      >
        <AnchoredMenuItem id="item-a">A</AnchoredMenuItem>
        <AnchoredMenuItem id="item-b">B</AnchoredMenuItem>
      </AnchoredMenu>
    </div>
  );
}

describe("AnchoredMenu", () => {
  it("renders via portal into document.body, outside the clipped parent", () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    const menu = document.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu!.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    // Items are reachable for clicks.
    expect(document.getElementById("item-a")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside pointerdown but not on the anchor or its items", () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    act(() => {
      document
        .getElementById("trigger")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      document
        .getElementById("item-a")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("receives item clicks and navigates with arrow keys", () => {
    const onClose = vi.fn();
    mount(<Harness onClose={onClose} />);
    // First item focused on open.
    expect(document.activeElement?.id).toBe("item-a");
    act(() => {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement?.id).toBe("item-b");
    act(() => {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement?.id).toBe("item-a");

    let clicked = false;
    act(() =>
      root.render(
        <AnchoredMenu open onClose={onClose} anchor={{ x: 10, y: 10 }}>
          <AnchoredMenuItem id="pt" onClick={() => (clicked = true)}>
            go
          </AnchoredMenuItem>
        </AnchoredMenu>,
      ),
    );
    act(() => {
      document.getElementById("pt")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicked).toBe(true);
  });

  it("AnchoredPopup renders floating content without focus/dismiss wiring", () => {
    mount(
      <AnchoredPopup open anchor={{ x: 5, y: 5 }}>
        <div id="flyout">preview</div>
      </AnchoredPopup>,
    );
    expect(document.getElementById("flyout")).toBeTruthy();
  });
});
