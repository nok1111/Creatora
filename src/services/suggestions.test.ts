import { describe, it, expect, beforeEach } from "vitest";
import { evalSuggestions, dismissedKeys, dismissSuggestion, type SuggestionContext } from "./suggestions";

const base: SuggestionContext = {
  hasMedia: true,
  hasClips: true,
  exportedAny: false,
  exportedHorizontal: false,
  hasVerticalVersion: false,
  hasSubtitles: false,
  subtitleStyleApplied: false,
  hasThumbnail: false,
  postUsesThumbnail: false,
  multiFormat: false,
  hasSocialPost: false,
};

const empty: SuggestionContext = {
  ...base,
  hasMedia: false,
  hasClips: false,
};

describe("evalSuggestions", () => {
  // A project whose workflow is "done": media, clips, subtitles, an export.
  const finished: SuggestionContext = {
    ...base,
    hasSubtitles: true,
    subtitleStyleApplied: true,
    exportedAny: true,
  };

  it("suggests media import when the project has no media", () => {
    expect(evalSuggestions({ ...empty }).map((s) => s.key)).toEqual(["import-media"]);
    expect(
      evalSuggestions({ ...empty, hasMedia: true }).map((s) => s.key),
    ).toContain("add-to-timeline");
  });

  it("does not suggest timeline import once clips exist", () => {
    const keys = evalSuggestions({ ...base }).map((s) => s.key);
    expect(keys).not.toContain("import-media");
    expect(keys).not.toContain("add-to-timeline");
  });

  it("suggests subtitles and export for an unsubtitled, unexported edit", () => {
    const keys = evalSuggestions({ ...base }).map((s) => s.key);
    expect(keys).toContain("create-subtitles");
    expect(keys).toContain("export-video");
    expect(
      evalSuggestions({ ...finished }).map((s) => s.key),
    ).not.toContain("export-video");
    expect(
      evalSuggestions({ ...finished }).map((s) => s.key),
    ).not.toContain("create-subtitles");
  });

  it("suggests vertical adaptation after a horizontal export", () => {
    const out = evalSuggestions({ ...finished, exportedHorizontal: true });
    expect(out.map((s) => s.key)).toContain("adapt-vertical");
  });

  it("does not suggest vertical when a vertical version already exists", () => {
    const out = evalSuggestions({
      ...finished,
      exportedHorizontal: true,
      hasVerticalVersion: true,
    });
    expect(out.map((s) => s.key)).not.toContain("adapt-vertical");
  });

  it("suggests a subtitle style only when subtitles exist unstyled", () => {
    expect(
      evalSuggestions({ ...finished, subtitleStyleApplied: false }).map((s) => s.key),
    ).toContain("subtitle-style");
    expect(evalSuggestions({ ...finished }).map((s) => s.key)).not.toContain(
      "subtitle-style",
    );
  });

  it("suggests thumbnail→post only when a thumbnail is unused", () => {
    expect(evalSuggestions({ ...finished, hasThumbnail: true }).map((s) => s.key)).toContain(
      "thumbnail-to-post",
    );
    expect(
      evalSuggestions({ ...finished, hasThumbnail: true, postUsesThumbnail: true }).map(
        (s) => s.key,
      ),
    ).not.toContain("thumbnail-to-post");
  });

  it("suggests publish prep for finished content without posts", () => {
    expect(evalSuggestions({ ...finished, multiFormat: true }).map((s) => s.key)).toContain(
      "prepare-publish",
    );
    // A plain finished export (no extra formats) also qualifies.
    expect(evalSuggestions({ ...finished }).map((s) => s.key)).toContain("prepare-publish");
    expect(
      evalSuggestions({ ...finished, multiFormat: true, hasSocialPost: true }).map(
        (s) => s.key,
      ),
    ).not.toContain("prepare-publish");
  });

  it("caps output at two suggestions", () => {
    const out = evalSuggestions({
      ...finished,
      exportedHorizontal: true,
      hasThumbnail: true,
      multiFormat: true,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("every suggestion has a navigation target", () => {
    const out = evalSuggestions({ ...finished, exportedHorizontal: true });
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
