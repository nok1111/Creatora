import { describe, expect, it } from "vitest";
import { extractHashtags, PLATFORM_LABEL } from "./social-types";

describe("extractHashtags", () => {
  it("pulls #tags from caption text", () => {
    expect(extractHashtags("hello #world and #rust, #ok!")).toEqual([
      "world",
      "rust",
      "ok",
    ]);
  });
  it("ignores lone # and mid-word hashes", () => {
    expect(extractHashtags("# # a#b #tag")).toEqual(["tag"]);
  });
  it("mirrors Rust trim: only edge punctuation stripped", () => {
    // mid-token punctuation survives in both impls
    expect(extractHashtags("#a.b #c-d,")).toEqual(["a.b", "c-d"]);
  });
});

describe("platform labels", () => {
  it("covers the four platforms", () => {
    expect(Object.keys(PLATFORM_LABEL).sort()).toEqual([
      "facebook",
      "instagram",
      "tiktok",
      "youtube",
    ]);
  });
});
