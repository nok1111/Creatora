/**
 * Shared parity vectors — MUST match
 * src-tauri/tests/render_e2e.rs::keyframe_eval_parity_table.
 * Any drift = preview/render mismatch (ADR-017).
 */
import { describe, expect, it } from "vitest";
import { evalKeyframes } from "@/lib/effects";
import type { Keyframe } from "@/lib/project-types";

const kf = (tMs: number, v: number): Keyframe => ({ tMs, v, ease: "linear" });

describe("evalKeyframes — shared parity vectors (mirror of Rust eval_at)", () => {
  const cases: Array<[Keyframe[], number, number, number]> = [
    [[], 500, 0.7, 0.7],
    [[kf(100, 0), kf(900, 1)], 500, 0, 0.5],
    [[kf(100, 0), kf(900, 1)], 0, 0, 0],
    [[kf(100, 0), kf(900, 1)], 5000, 0, 1],
    [[kf(0, 2), kf(1000, -1)], 250, 9, 1.25],
    [[kf(0, 1), kf(500, 3), kf(1000, 2)], 750, 0, 2.5],
    [[kf(200, 5)], 0, 1, 5],
  ];
  cases.forEach(([kfs, t, base, want], i) => {
    it(`vector ${i + 1}`, () => {
      expect(evalKeyframes(kfs, t, base)).toBeCloseTo(want, 9);
    });
  });
});
