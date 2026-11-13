import { describe, expect, it } from "vitest";
import { metricValue, type Metric } from "./analytics-types";

const m = (metrics: Metric[]) => ({ metrics });

describe("metricValue", () => {
  it("returns the value for a served key", () => {
    expect(
      metricValue(m([{ key: "views", label: "Views", unit: "count", value: 42 }]), "views"),
    ).toBe(42);
  });
  it("returns null — never 0 — for an unserved key", () => {
    expect(metricValue(m([{ key: "likes", label: "L", unit: "count", value: 1 }]), "shares")).toBeNull();
    expect(metricValue(m([]), "views")).toBeNull();
  });
  it("distinguishes zero-value metrics from missing ones", () => {
    expect(
      metricValue(m([{ key: "comments", label: "C", unit: "count", value: 0 }]), "comments"),
    ).toBe(0);
  });
});
