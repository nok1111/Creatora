/**
 * Creative-filter preview (WebGL2) — SHARED compositor.
 *
 * One lazily-created GL context renders every filtered clip, then each
 * clip's DOM layer blits the result into its own 2D canvas at the right
 * z-position (DOM order keeps track order, opacity and transforms — a
 * single fullscreen canvas could not interleave with unfiltered layers).
 *
 * Parity with export:
 *  - color: the entry's `lut` ops baked into a 33³ RGB texture (the SAME
 *    `bakeLutData` the Rust side uses for the .cube), sampled trilinear —
 *    ffmpeg runs `lut3d=interp=trilinear` on the identical table.
 *  - spatial: vignette/grain/CA/bloom/halation/sharp/diffuse uniforms
 *    scaled by `intensity` exactly like `filter_fragments` (fxeffects.rs).
 *  - intensity is a shader mix (linear ops commute with trilinear
 *    sampling), so the LUT never rebakes on slider drags.
 *
 * Filter stacking = ping-pong between two FBOs, one pass per filter in
 * effect order (the export chains them the same way). On context loss or
 * any failure `render` returns false → the layer falls back to the
 * unfiltered DOM video.
 */

import { fxEntry } from "./manifest";
import { bakeLutData, LUT_SIZE } from "./lut";
import { resolveConstants } from "./manifest";
import type { Clip } from "@/lib/project-types";

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform float uHasLut, uIntensity, uCompare, uVig, uGrain, uCa, uBloom, uHal, uSharp, uSoft;
uniform vec2 uRes;
uniform float uSeed;
in vec2 vUv;
out vec4 frag;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }

vec3 grade(vec2 uv){
  vec3 c = texture(uSrc, uv).rgb;
  if(uHasLut>0.5){
    vec3 g = texture(uLut, clamp(c,0.,1.)).rgb;
    c = mix(c, g, uIntensity);
  }
  return c;
}

void main(){
  vec2 uv = vUv;
  if(uCompare>0.001 && uv.x<uCompare){ frag = texture(uSrc,uv); return; }
  vec3 c;
  // chromatic aberration — r/b diverge horizontally (lut3d→rgbashift order:
  // pointwise ops commute with displacement, so grading per-offset is exact)
  if(uCa>0.0005){
    vec2 d = vec2(uCa/uRes.x, 0.);
    c = vec3(grade(uv+d).r, grade(uv).g, grade(uv-d).b);
  } else c = grade(uv);

  float md = min(uRes.x, uRes.y);

  // bloom — poisson taps of highlights, screen-blended (σ≈export's gblur)
  if(uBloom>0.0005){
    float rad = uBloom*18.0/md;
    vec3 acc = vec3(0.);
    const int N = 12;
    for(int i=0;i<N;i++){
      float a = float(i)*2.399963; float r = rad*sqrt((float(i)+.5)/float(N));
      vec3 s = grade(uv + vec2(cos(a),sin(a))*r);
      float hl = smoothstep(.55,.95, dot(s,vec3(.2126,.7152,.0722)));
      acc += s*hl;
    }
    vec3 bl = acc/float(N);
    c = 1.-(1.-c)*(1.-bl*(uBloom*1.7));
  }
  // halation — warm bleed around highlights
  if(uHal>0.0005){
    float rad = uHal*8.0/md;
    vec3 acc=vec3(0.); const int N=8;
    for(int i=0;i<N;i++){
      float a=float(i)*2.399963; float r=rad*sqrt((float(i)+.5)/float(N));
      acc += grade(uv+vec2(cos(a),sin(a))*r);
    }
    vec3 bl = acc/float(N)*vec3(1.,.78,.55);
    c = 1.-(1.-c)*(1.-bl*(uHal*0.7));
  }
  // sharpen — 5-tap unsharp
  if(uSharp>0.0005){
    vec2 px = 1./uRes;
    vec3 nb = grade(uv+vec2(px.x,0.))+grade(uv-vec2(px.x,0.))+grade(uv+vec2(0.,px.y))+grade(uv-vec2(0.,px.y));
    c += (c - nb*0.25)*(uSharp*1.4);
  }
  // diffusion — mix toward local blur
  if(uSoft>0.0005){
    vec2 px = vec2(uSoft*3.0)/uRes;
    vec3 acc=vec3(0.); const int N=8;
    for(int i=0;i<N;i++){
      float a=float(i)*2.399963; float r=sqrt((float(i)+.5)/float(N));
      acc += grade(uv+vec2(cos(a),sin(a))*r*px);
    }
    c = mix(c, acc/float(N), uSoft*0.55);
  }
  c = clamp(c, 0., 1.);
  // grain — temporal+uniform like ffmpeg noise=alls:N:allf=t+u
  if(uGrain>0.0005){
    float n = hash(uv*uRes + vec2(uSeed*911., uSeed*577.))-.5;
    c += n*uGrain*0.22;
  }
  // vignette
  if(uVig>0.0005){
    vec2 d = (uv-.5)*vec2(uRes.x/uRes.y,1.);
    float v = 1.-uVig*1.9*pow(dot(d,d)*2.,1.3)*.5;
    c *= clamp(v,0.,1.);
  }
  frag = vec4(c, texture(uSrc,uv).a);
}`;

/** One filter pass = manifest entry + resolved spatial uniforms. */
export interface FilterPass {
  entryId: string;
  /** Cache key for the LUT texture ("" = pure-spatial filter). */
  lutKey: string;
  /** Resolved consts for LUT baking (only read on first use of lutKey). */
  lutConsts?: Record<string, number>;
  uniforms: Record<string, number>;
}

/** Canonical spatial keys the shader/fragments share. */
const SPATIAL = ["vig", "grain", "ca", "bloom", "hal", "sharp", "soft"] as const;

class FilterGL {
  cv: HTMLCanvasElement | null = null;
  gl: WebGL2RenderingContext | null = null;
  prog: WebGLProgram | null = null;
  uniforms = new Map<string, WebGLUniformLocation | null>();
  srcTex: WebGLTexture | null = null;
  fbo: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
  fboTex: [WebGLTexture, WebGLTexture] | null = null;
  luts = new Map<string, WebGLTexture>();
  lost = false;
  onStatus: ((st: "ok" | "lost") => void) | null = null;

  private ensure(): boolean {
    if (this.lost) return false;
    if (this.gl) return true;
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2", { premultipliedAlpha: false, alpha: true });
    if (!gl) {
      this.lost = true;
      this.onStatus?.("lost");
      return false;
    }
    cv.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      this.onStatus?.("lost");
    });
    this.cv = cv;
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error("[filterGL]", gl.getShaderInfoLog(s));
        this.lost = true;
        this.onStatus?.("lost");
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[filterGL]", gl.getProgramInfoLog(prog));
      this.lost = true;
      this.onStatus?.("lost");
      return false;
    }
    this.prog = prog;
    for (const u of ["uSrc","uLut","uHasLut","uIntensity","uCompare","uVig","uGrain","uCa","uBloom","uHal","uSharp","uSoft","uRes","uSeed"])
      this.uniforms.set(u, gl.getUniformLocation(prog, u));
    // fullscreen triangle
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // source texture + ping-pong FBOs
    this.srcTex = gl.createTexture();
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return [t, f] as [WebGLTexture, WebGLFramebuffer];
    };
    const [t0, f0] = mk();
    const [t1, f1] = mk();
    this.fboTex = [t0, t1];
    this.fbo = [f0, f1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /** Cache key: entry + consts that can reach the LUT (placeholders);
      intensity/spatial are excluded — they never trigger a rebake. */
  lutKeyFor(entryId: string, params: Record<string, number> | undefined): string {
    const entry = fxEntry(entryId);
    if (!entry?.lut?.length) return "";
    const consts = resolveConstants(entry, params);
    const relevant = Object.keys(consts)
      .filter((k) => k !== "intensity" && !(SPATIAL as readonly string[]).includes(k))
      .sort()
      .map((k) => `${k}=${consts[k]}`);
    return `${entryId}|${relevant.join(",")}`;
  }

  /** Bake+upload the LUT texture for `key` once (idempotent). */
  private ensureLut(pass: FilterPass): WebGLTexture | null {
    if (!pass.lutKey || !this.gl) return null;
    let t = this.luts.get(pass.lutKey) ?? null;
    if (t) return t;
    const entry = fxEntry(pass.entryId);
    if (!entry?.lut?.length) return null;
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // ANGLE: texImage3D is INVALID_OPERATION while FLIP_Y is set (left over
    // from the 2D source upload) — the texture stays empty and samples black.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const data = bakeLutData(entry.lut, pass.lutConsts ?? {}, 1);
    const u8 = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) u8[i] = Math.round(Math.min(1, Math.max(0, data[i])) * 255);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGB, gl.UNSIGNED_BYTE, u8);
    this.luts.set(pass.lutKey, t);
    return t;
  }

  /**
   * Render `src` through `passes` into the shared canvas (w×h). Returns the
   * canvas for blitting, or null on failure (caller keeps the DOM video).
   */
  render(src: CanvasImageSource, passes: FilterPass[], w: number, h: number, seed = 0): HTMLCanvasElement | null {
    if (!passes.length || !this.ensure() || !this.gl || !this.cv) return null;
    const gl = this.gl;
    if (this.cv.width !== w || this.cv.height !== h) {
      this.cv.width = w;
      this.cv.height = h;
      for (const t of this.fboTex!) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    // upload source
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    } catch {
      return null; // source not ready / tainted
    }
    gl.useProgram(this.prog);
    gl.uniform1i(this.uniforms.get("uSrc")!, 0);
    gl.uniform1i(this.uniforms.get("uLut")!, 1);
    gl.uniform2f(this.uniforms.get("uRes")!, w, h);
    gl.uniform1f(this.uniforms.get("uSeed")!, seed % 64);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);

    let input: WebGLTexture = this.srcTex!;
    for (let i = 0; i < passes.length; i++) {
      const last = i === passes.length - 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : this.fbo![i % 2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      const lut = this.ensureLut(passes[i]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lut);
      const u = passes[i].uniforms;
      const set = (k: string, v: number) => gl.uniform1f(this.uniforms.get(k)!, v);
      set("uHasLut", lut ? 1 : 0);
      set("uIntensity", (u.intensity ?? 100) / 100);
      set("uCompare", u.compare ?? 0);
      set("uVig", u.vig ?? 0);
      set("uGrain", u.grain ?? 0);
      set("uCa", (u.ca ?? 0) * 6); // px — matches export's ca*6
      set("uBloom", u.bloom ?? 0);
      set("uHal", u.hal ?? 0);
      set("uSharp", u.sharp ?? 0);
      set("uSoft", u.soft ?? 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      input = this.fboTex![i % 2];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.cv;
  }

  release() {
    const gl = this.gl;
    if (!gl) return;
    for (const [, t] of this.luts) gl.deleteTexture(t);
    this.luts.clear();
    this.fboTex?.forEach((t) => gl.deleteTexture(t));
    this.fbo?.forEach((f) => gl.deleteFramebuffer(f));
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.prog) gl.deleteProgram(this.prog);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.cv = null;
    this.prog = null;
    this.lost = false; // allow a later retry
  }
}

let inst: FilterGL | null = null;
export function filterGL(): FilterGL {
  inst ??= new FilterGL();
  return inst;
}

/** Filter passes for a clip's active filter effects (max 3, order kept). */
export function filterPassesFor(clip: Clip, relMs: number): FilterPass[] {
  const out: FilterPass[] = [];
  for (const e of clip.effects ?? []) {
    if (!e.enabled) continue;
    if (e.inMs != null && relMs < e.inMs) continue;
    if (e.outMs != null && relMs >= e.outMs) continue;
    const entry = fxEntry(e.type);
    if (entry?.kind !== "filter") continue;
    const consts = resolveConstants(entry, e.params);
    const i = Math.min(1, Math.max(0, (consts.intensity ?? 100) / 100));
    if (i <= 0) continue;
    const uniforms: Record<string, number> = { intensity: consts.intensity ?? 100 };
    for (const k of SPATIAL) uniforms[k] = (consts[k] ?? 0) * i;
    out.push({
      entryId: entry.id,
      lutKey: filterGL().lutKeyFor(entry.id, e.params),
      lutConsts: consts,
      uniforms,
    });
    if (out.length >= 3) break;
  }
  return out;
}
