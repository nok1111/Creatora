import { describe, it, expect, beforeEach } from "vitest";
import { evalSuggestions, dismissedKeys, dismissSuggestion, type SuggestionContext } from "./suggestions";

const base: SuggestionContext = {
  exportedHorizontal: false,
  hasVerticalVersion: false,
  hasSubtitles: false,
  subtitleStyleApplied: false,
  hasThumbnail: false,
  postUsesThumbnail: false,
  multiFormat: false,
  hasSocialPost: false,
};

describe("evalSuggestions", () => {
  it("suggests vertical adaptation after a horizontal export", () => {
    const out = evalSuggestions({ ...base, exportedHorizontal: true });
    expect(out.map((s) => s.key)).toContain("adapt-vertical");
  });

  it("does not suggest vertical when a vertical version already exists", () => {
    const out = evalSuggestions({ ...base, exportedHorizontal: true, hasVerticalVersion: true });
    expect(out.map((s) => s.key)).not.toContain("adapt-vertical");
  });

  it("suggests a subtitle style only when subtitles exist unstyled", () => {
    expect(
      evalSuggestions({ ...base, hasSubtitles: true }).map((s) => s.key),
    ).toContain("subtitle-style");
    expect(
      evalSuggestions({ ...base, hasSubtitles: true, subtitleStyleApplied: true }).map((s) => s.key),
    ).not.toContain("subtitle-style");
    expect(evalSuggestions({ ...base }).map((s) => s.key)).not.toContain("subtitle-style");
  });

  it("suggests thumbnail→post only when a thumbnail is unused", () => {
    expect(evalSuggestions({ ...base, hasThumbnail: true }).map((s) => s.key)).toContain(
      "thumbnail-to-post",
    );
    expect(
      evalSuggestions({ ...base, hasThumbnail: true, postUsesThumbnail: true }).map((s) => s.key),
    ).not.toContain("thumbnail-to-post");
  });

  it("suggests publish prep only for multi-format without posts", () => {
    expect(evalSuggestions({ ...base, multiFormat: true }).map((s) => s.key)).toContain(
      "prepare-publish",
    );
    expect(
      evalSuggestions({ ...base, multiFormat: true, hasSocialPost: true }).map((s) => s.key),
    ).not.toContain("prepare-publish");
  });

  it("caps output at two suggestions", () => {
    const out = evalSuggestions({
      ...base,
      exportedHorizontal: true,
      hasSubtitles: true,
      hasThumbnail: true,
      multiFormat: true,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("every suggestion has a navigation target", () => {
    const out = evalSuggestions({ ...base, exportedHorizontal: true, hasSubtitles: true });
    for (const s of out) {
      expect(s.to.startsWith("/")).toBe(true);
      expect(s.actionLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("dismissals", () => {
  beforeEach(() => localStorage.clear());

  it("dismissSuggestion persists the key", () => {
    expect(dismissedKeys().has("adapt-vertical")).toBe(false);
    dismissSuggestion("adapt-vertical");
    expect(dismissedKeys().has("adapt-vertical")).toBe(true);
  });
});
