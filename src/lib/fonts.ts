import { convertFileSrc } from "@tauri-apps/api/core";

/** path → generated family name, so preview can show brand-kit fonts. */
const loaded = new Map<string, string>();

/** Register a local font file as a FontFace (async load) and return a stable
    family name usable in CSS `fontFamily`. Same path → same family. */
export function fontFamilyFor(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const hit = loaded.get(path);
  if (hit) return hit;
  const family = `loaded-font-${loaded.size}`;
  loaded.set(path, family);
  new FontFace(family, `url("${convertFileSrc(path)}")`)
    .load()
    .then((f) => document.fonts.add(f))
    .catch(() => loaded.delete(path));
  return family;
}
