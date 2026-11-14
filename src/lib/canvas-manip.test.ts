import { describe, it, expect } from "vitest";
import { snapToGuides, scaleFromCorner, angleDeg } from "./canvas-manip";

describe("snapToGuides", () => {
  it("snaps to center within tolerance", () => {
    const r = snapToGuides(963, 537, 1920, 1080, 12);
    expect(r.x).toBe(960); expect(r.y).toBe(540);
    expect(r.vGuide).toBe(960); expect(r.hGuide).toBe(540);
  });
  it("leaves points beyond tolerance untouched", () => {
    const r = snapToGuides(100, 100, 1920, 1080, 12);
    expect(r.x).toBe(100); expect(r.vGuide).toBeNull();
  });
});

describe("scaleFromCorner", () => {
  it("scales uniformly by dominant axis", () => {
    const r = scaleFromCorner(1, 1, 400, 200, 40, 0);
    expect(r.scaleX).toBeCloseTo(1.1); expect(r.scaleY).toBeCloseTo(1.1);
  });
  it("clamps to a minimum", () => {
    const r = scaleFromCorner(1, 1, 100, 100, -500, -500);
    expect(r.scaleX).toBeCloseTo(0.05);
  });
});

describe("angleDeg", () => {
  it("above center = 0 deg", () => {
    expect(angleDeg(100, 100, 100, 50)).toBeCloseTo(0);
  });
  it("right of center = 90 deg", () => {
    expect(angleDeg(100, 100, 150, 100)).toBeCloseTo(90);
  });
});
