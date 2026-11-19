/**
 * Recipe → GLSL ES 3.00 fragment shader (pure string builder; no GL here,
 * so it is unit-testable). Params become float uniforms (`u_<name>`), so a
 * slider drag only updates uniforms — the program is compiled once per
 * (entry, ease), never per value.
 */

import { FX_MANIFEST, type FxEntry } from "./manifest";
import { freeVars, parse, toGlsl } from "./expr";

export interface ShaderSpec {
  source: string;
  /** Param/derived names that need a `u_<name>` float uniform. */
  uniforms: string[];
}

export const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/** Template with `{T}` inlined, `{u}` → `u` and `{name}` → `u_name`. */
export function glTemplate(e: FxEntry, ease?: string): string {
  if (!e.expr) throw new Error(`${e.id}: not a transition recipe`);
  const easeName = ease && FX_MANIFEST.eases[ease] ? ease : (e.defaultEase ?? "linear");
  return e.expr
    .replace(/\{T\}/g, () => FX_MANIFEST.eases[easeName])
    .replace(/\{(\w+)\}/g, (_, n: string) => (n === "u" ? "u" : `u_${n}`));
}

export function buildFragmentShader(e: FxEntry, ease?: string): ShaderSpec {
  const ast = parse(glTemplate(e, ease));
  const uniforms = [...freeVars(ast)].filter((n) => n.startsWith("u_")).map((n) => n.slice(2));
  const decl = uniforms.map((n) => `uniform float u_${n};`).join("\n");
  const source = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2 uRes;
uniform float uU;
${decl}
out vec4 outColor;
int CH = 0;
float W; float H; float X; float Y; float u; float PLANE;
float fx_mod(float a, float b){ return a - b*floor(a/b); }
float sampA(float x, float y){
  ivec2 p = ivec2(int(clamp(floor(x),0.0,W-1.0)), int(clamp(floor(y),0.0,H-1.0)));
  return texelFetch(uA, p, 0)[CH]*255.0;
}
float sampB(float x, float y){
  ivec2 p = ivec2(int(clamp(floor(x),0.0,W-1.0)), int(clamp(floor(y),0.0,H-1.0)));
  return texelFetch(uB, p, 0)[CH]*255.0;
}
float recipe(){ return ${toGlsl(ast)}; }
void main(){
  W = uRes.x; H = uRes.y; u = uU;
  X = floor(gl_FragCoord.x);
  Y = H - 1.0 - floor(gl_FragCoord.y);
  vec4 o = vec4(0.0);
  for (int c = 0; c < 4; c++) {
    CH = c; PLANE = float(c);
    o[c] = clamp(floor(recipe()), 0.0, 255.0) / 255.0;
  }
  outColor = vec4(o.rgb * o.a, o.a);
}
`;
  return { source, uniforms };
}

/** Fast path for transitions whose render is `kind:"fields"`: the ax/ay/m
 *  (and optional glow) recipes are evaluated ONCE per pixel and the blend
 *  runs as vec4 ops — same math as the export's geq fields + remap +
 *  maskedmerge + screen-blend chain. The generic `buildFragmentShader`
 *  path re-evaluates the whole merged expr per channel (~4× the field
 *  math per pixel), which makes heavy warps (rip, tearRift) stutter. */
export function buildTransitionFieldShader(e: FxEntry, ease?: string): ShaderSpec | null {
  const fields = e.render?.kind === "fields" ? e.render.fields : null;
  if (!fields) return null;
  const easeName = ease && FX_MANIFEST.eases[ease] ? ease : (e.defaultEase ?? "linear");
  const easeBody = FX_MANIFEST.eases[easeName];
  const tpl = (s: string) =>
    s
      .replace(/\{T\}/g, () => easeBody)
      .replace(/\{u\}/g, "u")
      .replace(/\{(\w+)\}/g, (_, n: string) => `u_${n}`);
  const asts = (["ax", "ay", "m", "glow"] as const).map(
    (k) => [k, fields[k] ? parse(tpl(fields[k] as string)) : null] as const,
  );
  const uniforms = [
    ...new Set(asts.flatMap(([, a]) => (a ? [...freeVars(a)] : []))),
  ]
    .filter((n) => n.startsWith("u_"))
    .map((n) => n.slice(2));
  if (asts[3][1]) for (const t of ["cr", "cg", "cb"]) if (!uniforms.includes(t)) uniforms.push(t);
  const decl = uniforms.map((n) => `uniform float u_${n};`).join("\n");
  const g = (i: number, dflt: string) =>
    asts[i][1] ? toGlsl(asts[i][1]) : dflt;
  const source = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2 uRes;
uniform float uU;
${decl}
out vec4 outColor;
float W; float H; float X; float Y; float u; float PLANE;
float fx_mod(float a, float b){ return a - b*floor(a/b); }
void main(){
  W = uRes.x; H = uRes.y; u = uU;
  X = floor(gl_FragCoord.x);
  Y = H - 1.0 - floor(gl_FragCoord.y);
  PLANE = 0.0;
  vec2 s = vec2(${g(0, "X")}, ${g(1, "Y")});
  ivec2 pa = ivec2(int(clamp(floor(s.x),0.0,W-1.0)), int(clamp(floor(s.y),0.0,H-1.0)));
  ivec2 pb = ivec2(int(X), int(Y));
  vec4 a = texelFetch(uA, pa, 0);
  vec4 b = texelFetch(uB, pb, 0);
  float mm = clamp(${g(2, "1.0")}, 0.0, 1.0);
  vec4 o = a * mm + b * (1.0 - mm);
  ${asts[3][1] ? `vec3 tint = vec3(u_cr, u_cg, u_cb) / 255.0;
  vec3 l = min(clamp(${g(3, "0.0")}, 0.0, 4.0) * tint, vec3(1.0));
  o.rgb = o.rgb + (1.0 - o.rgb) * l;` : ""}
  outColor = vec4(o.rgb * o.a, o.a);
}
`;
  return { source, uniforms };
}

/** Single-clip field effects (intro/outro, render.kind="fields") — the
 *  declarative ax/ay/m/glow recipe compiled straight to GLSL: same math
 *  the export's geq field videos + remap/maskedmerge/screen graph runs.
 *  `u` is window progress 0→1, params arrive as u_<name> uniforms and the
 *  glow tint as uTint (cr/cg/cb, 0..1). */
export function buildFieldShader(e: FxEntry): ShaderSpec | null {
  const fields = e.render?.kind === "fields" ? e.render.fields : null;
  if (!fields) return null;
  const ease = FX_MANIFEST.eases[e.defaultEase ?? "linear"] ?? "{u}";
  const tpl = (s: string) =>
    s
      .replace(/\{T\}/g, () => ease)
      .replace(/\{u\}/g, "u")
      .replace(/\{(\w+)\}/g, (_, n: string) => `u_${n}`);
  const asts = (["ax", "ay", "m", "glow"] as const).map(
    (k) => [k, fields[k] ? parse(tpl(fields[k] as string)) : null] as const,
  );
  const uniforms = [
    ...new Set(asts.flatMap(([, a]) => (a ? [...freeVars(a)] : []))),
  ]
    .filter((n) => n.startsWith("u_"))
    .map((n) => n.slice(2));
  const decl = uniforms.map((n) => `uniform float u_${n};`).join("\n");
  const g = (i: number, dflt: string) =>
    asts[i][1] ? toGlsl(asts[i][1]) : dflt;
  const source = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uU;
uniform vec3 uTint;
${decl}
out vec4 outColor;
float W; float H; float X; float Y; float u;
float fx_mod(float a, float b){ return a - b*floor(a/b); }
void main(){
  W = uRes.x; H = uRes.y; u = uU;
  X = floor(gl_FragCoord.x);
  Y = H - 1.0 - floor(gl_FragCoord.y);
  vec2 s = vec2(${g(0, "X")}, ${g(1, "Y")});
  ivec2 p = ivec2(int(clamp(floor(s.x),0.0,W-1.0)), int(clamp(floor(s.y),0.0,H-1.0)));
  vec4 a = texelFetch(uSrc, p, 0);
  float mm = clamp(${g(2, "1.0")}, 0.0, 1.0);
  vec4 o = mix(vec4(0.0), a, mm);
  ${asts[3][1] ? `vec3 l = min(clamp(${g(3, "0.0")}, 0.0, 4.0) * uTint, vec3(1.0));
  o.rgb = o.rgb + (1.0 - o.rgb) * l;` : ""}
  outColor = vec4(o.rgb, o.a);
}
`;
  return { source, uniforms };
}
