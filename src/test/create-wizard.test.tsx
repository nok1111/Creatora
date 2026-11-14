import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { CreatePage } from "@/modules/create/CreatePage";

// Verify the /create wizard wiring: each format card must translate to the
// correct canvas dimensions passed to useProject.createNew.
const createNew = vi.fn(async (_opts: unknown) => ({}));
vi.mock("@/stores/project", () => ({
  useProject: (sel: (s: { createNew: typeof createNew }) => unknown) =>
    sel({ createNew }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// The wizard's job here is calling createNew with the right dims — bypass
// the unsaved-changes guard (it needs a real project store to decide).
vi.mock("@/services/project-switch", () => ({
  requestProjectSwitch: (fn: () => Promise<void>) => void fn(),
}));

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
  });
}

function click(el: Element | null) {
  expect(el, "element exists").toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const cardByLabel = (label: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  ) ?? null;

const startBtn = () =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Start editing"),
  ) ?? null;

function setInput(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  createNew.mockClear();
  mount();
  return () => {
    act(() => root.unmount());
    container.remove();
  };
});

describe("create wizard", () => {
  it("default vertical card creates a 1080x1920 project", async () => {
    click(startBtn());
    await act(async () => {});
    expect(createNew).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1080, height: 1920, fpsNum: 30 }),
    );
  });

  it("YouTube card creates 1920x1080 and uses the typed name", async () => {
    click(cardByLabel("YouTube video"));
    setInput(
      container.querySelector('input[placeholder="Name your project"]')!,
      "My video",
    );
    click(startBtn());
    await act(async () => {});
    expect(createNew).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My video", width: 1920, height: 1080 }),
    );
  });

  it("square card creates 1080x1080", async () => {
    click(cardByLabel("Square post"));
    click(startBtn());
    await act(async () => {});
    expect(createNew).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1080, height: 1080 }),
    );
  });

  it("custom card uses entered dimensions", async () => {
    click(cardByLabel("Custom format"));
    const inputs = [...container.querySelectorAll("input")].filter(
      (i) => i.placeholder !== "Name your project",
    );
    expect(inputs.length).toBe(2);
    setInput(inputs[0] as HTMLInputElement, "1280");
    setInput(inputs[1] as HTMLInputElement, "720");
    click(startBtn());
    await act(async () => {});
    expect(createNew).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 720 }),
    );
  });
});
