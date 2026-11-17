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
