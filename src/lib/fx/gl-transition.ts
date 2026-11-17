/**
 * WebGL2 renderer for library transitions in the preview.
 *
 * Design constraints (product requirements):
 *  - ONE shared context/canvas for the whole app, created lazily and reused
 *    by every transition (no per-mount canvas recreation).
 *  - Programs are compiled once per (entry, ease); parameter changes only
 *    update uniforms, so dragging a slider never recompiles a shader.
 *  - `release()` frees textures/programs when the preview stops using GL;
 *    after an idle period the context itself is dropped.
 *  - Context loss is survivable: status flips to "lost", callers fall back
 *    to the DOM crossfade, and resources rebuild on `contextrestored`.
 *  - If WebGL2 is missing or a shader fails to compile the status becomes
 *    "unavailable" and callers keep the DOM fallback.
 *
 * The shader is generated from the manifest recipe (gl-shader.ts) — the same
 * text the export's native graph is bounded against in the Rust parity tests.
 */

import { resolveConstants, type FxEntry } from "./manifest";
import { VERTEX_SHADER, buildFragmentShader } from "./gl-shader";

export type GlStatus = "ok" | "lost" | "unavailable";
export type TexSource = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;

interface Prog {
  program: WebGLProgram;
  uniforms: string[];
  loc: Map<string, WebGLUniformLocation | null>;
}

const IDLE_DROP_MS = 10_000;

export class TransitionGL {
  /** Re-created after `dispose()` (a lost canvas can't get a new context). */
  canvas = document.createElement("canvas");
  status: GlStatus = "ok";
  /** Notified whenever `status` changes (React state setter). */
  onStatus: ((s: GlStatus) => void) | null = null;

  private gl: WebGL2RenderingContext | null = null;
  private programs = new Map<string, Prog>();
  private tex: [WebGLTexture, WebGLTexture] | null = null;
  private quad: WebGLBuffer | null = null;
  private vs: WebGLShader | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private listenersBound = false;

  private setStatus(s: GlStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  /** Create (or revive) the context. Returns false when GL is unusable. */
  private ensure(): boolean {
    if (this.idleTimer) (clearTimeout(this.idleTimer), (this.idleTimer = null));
    if (this.status === "unavailable" || this.status === "lost") return false;
    if (this.gl && !this.gl.isContextLost()) return true;
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      this.setStatus("unavailable");
      return false;
    }
    this.gl = gl;
    if (!this.listenersBound) {
      this.listenersBound = true;
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault(); // allows restore
        this.programs.clear();
        this.tex = null;
        this.quad = null;
        this.vs = null;
        this.setStatus("lost");
      });
      this.canvas.addEventListener("webglcontextrestored", () => {
        this.gl = null;
        this.status = "ok"; // silent: rebuilt lazily on next draw
        this.onStatus?.("ok");
      });
    }
    return true;
  }

  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("fx shader compile failed:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  private program(entry: FxEntry, ease: string | undefined): Prog | null {
    const gl = this.gl!;
    const key = `${entry.id}|${ease ?? ""}`;
    const hit = this.programs.get(key);
    if (hit) return hit;
    if (!this.vs) this.vs = this.compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const spec = buildFragmentShader(entry, ease);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, spec.source);
    if (!this.vs || !fs) {
      this.setStatus("unavailable");
      return null;
    }
    const program = gl.createProgram()!;
    gl.attachShader(program, this.vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("fx program link failed:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      this.setStatus("unavailable");
      return null;
    }
    const loc = new Map<string, WebGLUniformLocation | null>();
    for (const n of ["uA", "uB", "uRes", "uU", ...spec.uniforms.map((u) => `u_${u}`)])
      loc.set(n, gl.getUniformLocation(program, n));
    const p: Prog = { program, uniforms: spec.uniforms, loc };
    this.programs.set(key, p);
    return p;
  }

  private ensureTextures(gl: WebGL2RenderingContext) {
    if (this.tex) return;
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex = [mk(), mk()];
  }

  /**
   * Draw one frame of `entry` at linear progress `u` (0→1).
   * `a`/`b` are layer canvases already rasterised at `w`×`h`.
   * Returns false when GL can't render (caller keeps the DOM fallback).
   */
  draw(o: {
    entry: FxEntry;
    ease?: string;
    params: Record<string, number> | undefined;
    u: number;
    a: TexSource;
    b: TexSource;
    w: number;
    h: number;
  }): boolean {
    if (!this.ensure()) return false;
    const gl = this.gl!;
    const prog = this.program(o.entry, o.ease);
    if (!prog) return false;
    if (this.canvas.width !== o.w || this.canvas.height !== o.h) {
      this.canvas.width = o.w;
      this.canvas.height = o.h;
    }
    this.ensureTextures(gl);
    if (!this.quad) {
      this.quad = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    }
    gl.viewport(0, 0, o.w, o.h);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const [ta, tb] = this.tex!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ta);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, o.a);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, o.b);

    gl.useProgram(prog.program);
    gl.uniform1i(prog.loc.get("uA")!, 0);
    gl.uniform1i(prog.loc.get("uB")!, 1);
    gl.uniform2f(prog.loc.get("uRes")!, o.w, o.h);
    gl.uniform1f(prog.loc.get("uU")!, Math.min(1, Math.max(0, o.u)));
    const consts = resolveConstants(o.entry, o.params);
    for (const n of prog.uniforms) gl.uniform1f(prog.loc.get(`u_${n}`) ?? null, consts[n] ?? 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return !gl.isContextLost();
  }

  /** Free GPU objects but keep the context for fast reuse; the context
   *  itself is dropped after an idle period. Call when no transition is
   *  being previewed any more. */
  release() {
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      for (const p of this.programs.values()) gl.deleteProgram(p.program);
      if (this.tex) for (const t of this.tex) gl.deleteTexture(t);
      if (this.quad) gl.deleteBuffer(this.quad);
      if (this.vs) gl.deleteShader(this.vs);
    }
    this.programs.clear();
    this.tex = null;
    this.quad = null;
    this.vs = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_DROP_MS);
  }

  /** Drop the context entirely (frees the browser's GL context slot). */
  dispose() {
    if (this.idleTimer) (clearTimeout(this.idleTimer), (this.idleTimer = null));
    const gl = this.gl;
    if (gl && !gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.programs.clear();
    this.tex = null;
    this.quad = null;
    this.vs = null;
    // A deliberate drop must not leave the singleton stuck in "lost" —
    // notify so React re-enables the GL path it disabled on "lost".
    this.setStatus("ok");
    this.listenersBound = false;
    this.canvas = document.createElement("canvas");
  }

  /** Test/debug: read the framebuffer as straight-alpha RGBA, top row first. */
  readPixels(w: number, h: number): Uint8Array | null {
    const gl = this.gl;
    if (!gl) return null;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // flip rows (GL origin is bottom-left)
    const out = new Uint8Array(px.length);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }
}

let shared: TransitionGL | null = null;
export const transitionGL = (): TransitionGL => (shared ??= new TransitionGL());

export const hasTransitionRecipe = (e: FxEntry | undefined): e is FxEntry =>
  !!e && e.kind === "transition" && !!e.expr && e.preview === "gl";
