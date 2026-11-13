/** Mirrors media::commands::AssetSummary / ImportOutcome. */

export type AssetKind =
  | "video"
  | "audio"
  | "image"
  | "graphic"
  | "font"
  | "template"
  | "project";

export interface AssetSummary {
  id: string;
  kind: AssetKind;
  filePath: string;
  name: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codec: string | null;
  thumbnailPath: string | null;
  status: "ok" | "missing" | "processing";
  duplicateOf: string | null;
  isFavorite: boolean;
}

export interface CollectionSummary {
  id: string;
  name: string;
  parentId: string | null;
  assetCount: number;
}

export interface TagSummary {
  id: string;
  name: string;
  assetCount: number;
}

export interface ImportOutcome {
  imported: AssetSummary[];
  errors: [string, string][];
  cancelled: boolean;
}
