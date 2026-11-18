/**
 * Light & Atmosphere effect programs for the shared filter compositor.
 *
 * Each manifest `kind:"effect"` entry with `preview:"gl"` gets a dedicated
 * fragment program with a fixed uniform signature:
 *   uSrc (sampler2D) · uRes (vec2, px) · uP0..uP3 (vec4 — 16 floats from pack)
 *
 * All field math is in H-fraction units (y ∈ [0,1], x ∈ [0,aspect]) so the
 * same constants drive the `geq` sprite bakes in render/fxeffects.rs.
 * `pack` resolves every time-varying term per frame through the SHARED
 * curves in envelopes.ts (mirrored in Rust, pinned by curves.golden.json) —
 * the shader itself is static per effect.
 *
 * Composition is screen blending: out = 1-(1-c)(1-l) — the same
 * `blend=screen` the export graph uses.
 */

import { flareDrift, flickerEnv, glintSweep, leakDrift, raysSwayRad } from "./envelopes";

export interface GlEffectDef {
  /** Fragment shader source (shared header prepended). */
  frag: string;
  /** Resolved consts → uP0..uP3 (16 floats). ctx.t = clip-rel seconds,
   *  frame-quantised to the project fps (as in export). */
  pack: (c: Record<string, number>, ctx: { t: number; w: number; h: number }) => number[];
}

const HEADER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform vec4 uP0, uP1, uP2, uP3;
in vec2 vUv;
out vec4 frag;
vec3 src(vec2 uv){ return texture(uSrc, uv).rgb; }
vec4 screen(vec3 l){
  vec3 c = src(vUv);
  return vec4(1. - (1. - c) * (1. - clamp(l, 0., 1.)), texture(uSrc, vUv).a);
}
`;

/** 0xRRGGBB param → [r,g,b] 0..1 */
const rgb = (v: number): [number, number, number] => [
  ((v >> 16) & 255) / 255,
  ((v >> 8) & 255) / 255,
  (v & 255) / 255,
];

export const LIGHT_EFFECTS: Record<string, GlEffectDef> = {
  // ── Cinematic Lens Flare ────────────────────────────────────────────
  // uP0 = (cx, cy, sx, sy)   anchor uv + streak σ in H-units
  // uP1 = (cr, cg, cb, gain) tint + intensity·flicker
  // uP2 = (coreR, g1, g2, g3) ghost amplitudes
  // uP3 = (g4, aspect, -, -)
  lensFlare: {
    frag: `${HEADER}
void main(){
  vec2 d = (vUv - uP0.xy) * vec2(uP3.y, 1.);
  float streak = exp(-pow(d.y / uP0.w, 2.)) * exp(-pow(d.x / uP0.z, 2.));
  float core = exp(-dot(d, d) / (2. * uP2.x * uP2.x));
  float g = uP2.y * exp(-pow(length(d - vec2(-0.55, 0.)) / 0.07, 2.))
          + uP2.z * exp(-pow(length(d - vec2( 0.38, 0.)) / 0.045, 2.))
          + uP2.w * exp(-pow(length(d - vec2( 0.62, 0.)) / 0.03, 2.))
          + uP3.x * exp(-pow(length(d - vec2(-0.30, 0.)) / 0.11, 2.));
  float halo = exp(-dot(d, d) / 0.18);
  float s = streak * 1.6 + core * 1.4 + halo * 0.5 + g;
  vec3 tint = mix(uP1.rgb, vec3(1.), clamp(core * 0.7, 0., 1.));
  frag = screen(tint * s * uP1.w);
}`,
    pack: (c, { t, w, h }) => {
      const asp = w / h;
      const [dx, dy] = flareDrift(c.speed, t);
      const g =
        [[0, 0, 0, 0], [0.5, 0.6, 0, 0], [0.5, 0.6, 0.45, 0.35]][Math.round((c.ghosts ?? 0) / 2)] ??
        [0, 0, 0, 0];
      return [
        c.x / 100 + dx, c.y / 100 + dy, 0.26 * c.spread * asp, 0.004,
        c.cr, c.cg, c.cb, (c.intensity / 100) * flickerEnv(c.flicker, 0.7 + 5 * c.speed, t),
        0.045, g[0], g[1], g[2],
        g[3], asp, 0, 0,
      ];
    },
  },

  // ── Light Leak ──────────────────────────────────────────────────────
  // uP0 = (ax, ay, sigma, -)      main anchor uv (+drift), σ in H-units
  // uP1 = (cr, cg, cb, gain)    tint + intensity·flicker
  // uP2 = (b2ax, b2ay, b2amp, aspect)  second anchor (dual pattern)
  lightLeak: {
    frag: `${HEADER}
void main(){
  vec2 asp = vec2(uP2.w, 1.);
  float s2 = uP0.z * uP0.z;
  vec2 d = (vUv - uP0.xy) * asp;
  float d2v = dot(d, d);
  float halo = exp(-d2v / (2. * s2));
  float core = exp(-d2v / (2. * s2 * 0.12));
  vec2 dl = d - vec2(0.55, -0.35) * uP0.z;      // organic secondary lobe
  float aux = 0.5 * exp(-dot(dl, dl) / (2. * s2 * 0.25));
  vec2 d3 = (vUv - uP2.xy) * asp;               // second anchor (dual sides)
  float b2 = uP2.z * exp(-dot(d3, d3) / (2. * s2));
  float I = 2.2 * (halo + aux + b2);
  vec3 tint = mix(uP1.rgb, vec3(1.), clamp(core * 1.2 + b2 * 0.5, 0., 1.));
  frag = screen(tint * I * uP1.w);
}`,
    pack: (c, { t, w, h }) => {
      const asp = w / h;
      const pat = Math.round(c.pattern ?? 0);
      const [dx, dy] = leakDrift(pat, 0.11, c.speed, t);
      const [ax, ay] = pat === 1 ? [1.02, -0.04] : pat === 2 ? [-0.06, 0.5] : [-0.04, 0.45];
      const [r, g, b] = rgb(c.color ?? 0xff5a1e);
      const dual: [number, number, number] = pat === 2 ? [1.12 + dx, 0.5 + dy, 1] : [0, 0, 0];
      return [
        ax + dx, ay + dy, c.spread * 0.55, 0,
        r, g, b, (c.intensity / 100) * flickerEnv(c.flicker, 0.4 + 3 * c.speed, t),
        dual[0], dual[1], dual[2], asp,
      ];
    },
  },

  // ── God Rays ────────────────────────────────────────────────────────
  // uP0 = (px, py, angRad, N)   source uv, fan angle + sway, ray count
  // uP1 = (cr, cg, cb, gain)    warm tint + intensity
  // uP2 = (R0, powE, aspect, env)  reach, ray softness, breathe
  godRays: {
    frag: `${HEADER}
void main(){
  vec2 d = (vUv - uP0.xy) * vec2(uP2.z, 1.);
  float a = atan(d.y, d.x) - uP0.z;
  float comb = pow(max(0.5 + 0.5 * sin(a * uP0.w), 0.), uP2.y);
  float rad = exp(-length(d) / max(uP2.x, 0.02));
  frag = screen(uP1.rgb * comb * rad * uP1.w * uP2.w);
}`,
    pack: (c, { t, w, h }) => {
      const asp = w / h;
      return [
        c.x / 100, c.y / 100,
        (c.angle * Math.PI) / 180 + raysSwayRad(7, c.speed, t),
        c.density,
        1.0, 0.93, 0.75, (c.intensity / 100) * 1.9,
        c.length * 0.9, 2 + 10 * (1 - c.spread), asp,
        flickerEnv(0.25, 0.5 + 3 * c.speed, t),
      ];
    },
  },

  // ── Prism Refraction ────────────────────────────────────────────────
  // uP0 = (cx, cy, k, pattern)  centre uv, dispersion (H-units), 0/1/2
  // uP1 = (glintAmp, glintX, glintAng, glintW)
  // uP2 = (aspect, intensity, -, -)
  prismRefraction: {
    frag: `${HEADER}
void main(){
  vec2 asp = vec2(uP2.x, 1.);
  vec2 d = (vUv - uP0.xy) * asp;
  float k = uP0.z;
  vec3 c;
  if (uP0.w > 0.5 && uP0.w < 1.5) {
    // pattern 1: uniform diagonal split (export uses rgbashift)
    vec2 ou = vec2(k * 1.6, k * 0.7) / asp;
    c = vec3(src(vUv - ou).r, src(vUv).g, src(vUv + ou).b);
  } else {
    // patterns 0/2: planes diverge radially about the centre
    // (export scales/crops the real channel planes by the same k)
    vec2 o = d * k;
    vec2 ou = o / asp;
    c = vec3(src(vUv - ou).r, src(vUv).g, src(vUv + ou).b);
  }
  if (uP0.w < 1.5) {
    // spectral band sweeping the frame
    vec2 bd = vec2(cos(uP1.z), sin(uP1.z));
    vec2 n = vec2(-bd.y, bd.x);
    vec2 dg = (vUv - vec2(uP1.y, 0.5)) * asp;
    float q = dot(dg, n);
    float band = exp(-q * q / (2. * uP1.w * uP1.w));
    float coord = dot(dg, bd);
    vec3 spec = 0.5 + 0.5 * cos(6.2832 * (coord * 1.4 + vec3(0., 0.33, 0.67)));
    c = 1. - (1. - c) * (1. - clamp(spec * band * uP1.x, 0., 1.));
  } else {
    // spectral ring around the dispersion centre (Halo)
    float q = length(d) - 0.30;
    float ring = exp(-q * q / (2. * 0.05 * 0.05));
    vec3 spec = 0.5 + 0.5 * cos(atan(d.y, d.x) + vec3(0., 2.09, 4.19));
    c = 1. - (1. - c) * (1. - clamp(spec * ring * uP1.x, 0., 1.));
  }
  frag = vec4(mix(src(vUv), c, uP2.y), texture(uSrc, vUv).a);
}`,
    pack: (c, { t, w, h }) => {
      const asp = w / h;
      return [
        c.x / 100, c.y / 100, c.amount * 0.008, c.pattern,
        c.glint, glintSweep(c.speed, t), -0.55, 0.09,
        asp, c.intensity / 100, 0, 0,
      ];
    },
  },

  // ── Floating Dust ─────────────────────────────────────────────────
  // uP0 = (density, size, t, -)        cell fill prob, radius scale, time
  // uP1 = (cr, cg, cb, gain)          dust tint + intensity
  // uP2 = (aspect, twinkle, speed, -)
  // Cell-hash particles: same sin-hash layout as the geq field — each
  // cell owns ≤1 particle on a slow elliptical orbit; nearer particles
  // are bigger, softer, brighter (fake depth). 3×3 stencil catches
  // particles whose orbits cross cell borders.
  floatingDust: {
    frag: `${HEADER}
float dh(vec2 c, vec2 s){ return fract(sin(dot(c, s)) * 43758.5453); }
void main(){
  vec2 d = vec2(vUv.x * uP2.x, vUv.y);
  float cs = 0.075;
  vec2 cell = floor(d / cs);
  float tt = uP0.z * uP2.z;
  float f = 0.;
  for (int ix = -1; ix <= 1; ix++)
  for (int iy = -1; iy <= 1; iy++) {
    vec2 c = cell + vec2(float(ix), float(iy));
    float h1 = dh(c, vec2(127.1, 311.7));
    if (h1 >= uP0.x) continue;
    float h2 = dh(c, vec2(269.5, 183.3));
    float h3 = dh(c, vec2(419.2, 371.9));
    float h4 = dh(c, vec2(113.5, 271.9));
    float h5 = dh(c, vec2(213.9, 117.3));
    vec2 orb = vec2(
      0.13 * sin(6.2832 * (tt * (0.055 + 0.10 * h2) + h3)),
      0.09 * sin(6.2832 * (tt * (0.045 + 0.08 * h4) + h5)));
    vec2 p = (c + vec2(0.15 + 0.7 * h3, 0.15 + 0.7 * h5) + orb) * cs;
    float r2 = dot(d - p, d - p);
    float depth = 0.25 + 0.75 * pow(h4, 2.5);      // mostly distant, rare bokeh
    float sr = (0.0022 + 0.011 * depth * depth) * uP0.y;
    float tw = 1. - uP2.y * 0.6 *
      (0.5 + 0.5 * sin(6.2832 * tt * (0.09 + 0.2 * h3) + h4 * 6.2832));
    float patch = 0.35 + 0.65 * dh(floor(c / 3.), vec2(53.7, 141.3));
    float bri = (0.3 + 0.7 * depth) * tw * patch * 0.75;
    f += bri * exp(-r2 / (2. * sr * sr))
       + 0.45 * bri * exp(-r2 / (10. * sr * sr));
  }
  frag = screen(uP1.rgb * f * uP1.w);
}`,
    pack: (c, { t, w, h }) => [
      c.density, c.size, t, 0,
      c.cr, c.cg, c.cb, c.intensity / 100,
      w / h, c.twinkle, c.speed, 0,
    ],
  },

  // ── Star Glint ────────────────────────────────────────────────────
  // uP0 = (threshold, lobes, size, t)   luma cut, arms/2, radius, time
  // uP1 = (cr, cg, cb, gain)           tint + intensity
  // uP2 = (aspect, colMode, speed, -)  colMode 1 = rainbow spectral
  // Stars appear only where the SOURCE is bright: each cell samples the
  // input's luma at its centre — the same luminance gate the geq export
  // applies via r(x,y)/g(x,y)/b(x,y) input sampling.
  starGlint: {
    frag: `${HEADER}
float sh(vec2 c, vec2 s){ return fract(sin(dot(c, s)) * 43758.5453); }
void main(){
  vec2 asp = vec2(uP2.x, 1.);
  vec2 d = vUv * asp;
  float cs = 0.115;
  vec2 cell = floor(d / cs);
  vec3 acc = vec3(0.);
  for (int ix = -1; ix <= 1; ix++)
  for (int iy = -1; iy <= 1; iy++) {
    vec2 c = cell + vec2(float(ix), float(iy));
    vec2 cc = (c + 0.5) * cs;
    float L = 0.;
    for (int q = 0; q < 5; q++) {
      vec2 off = vec2(q == 1 ? 0.28 : q == 2 ? -0.28 : 0.,
                      q == 3 ? 0.28 : q == 4 ? -0.28 : 0.) * cs;
      vec3 sc = src((cc + off) / asp);
      L = max(L, dot(sc, vec3(0.299, 0.587, 0.114)));
    }
    float m = pow(clamp((L - uP0.x) / max(1. - uP0.x, 0.05), 0., 1.), 1.0);
    if (m <= 0.001) continue;
    float h1 = sh(c, vec2(127.1, 311.7));
    float h2 = sh(c, vec2(269.5, 183.3));
    if (sh(c, vec2(419.2, 371.9)) < 0.38) continue; // thin the field out
    float rot = (h1 - 0.5) * 0.9;
    vec2 lc = d - cc;
    float r = length(lc);
    float a = atan(lc.y, lc.x) + rot;
    float arms = pow(abs(cos(uP0.y * a)), 64.);
    float tw = 0.4 + 0.6 * (0.5 + 0.5 * sin(6.2832 * uP2.z * uP0.w + h2 * 6.2832));
    float sig = 0.012 * uP0.z;
    float core = exp(-r * r / (2. * sig * sig));
    float ray = arms * exp(-r / (0.07 * uP0.z));
    float star = (core * 1.3 + ray * 0.9) * m * tw;
    vec3 tint = uP1.rgb;
    if (uP2.y > 0.5)
      tint = 0.55 + 0.45 * cos(6.2832 * r * 2.6 + a + vec3(0., 2.09, 4.19));
    acc += tint * star;
  }
  frag = screen(acc * uP1.w * 2.2);
}`,
    pack: (c, { t, w, h }) => [
      c.threshold, c.rays * 0.5, c.size, t,
      c.cr, c.cg, c.cb, c.intensity / 100,
      w / h, c.colMode ?? 0, c.speed, 0,
    ],
  },

  // ── Neon Trails ───────────────────────────────────────────────────
  // uP0 = (rotAngle rad, pulse, K trails, -)
  // uP1 = (cr, cg, cb, gain)           tint + intensity
  // uP2 = (aspect, thickness, colMode, glow)
  // K closed Lissajous curves baked as a static field — the head is a
  // bright arc at parameter s≈1 fading into a tail; the whole field
  // ROTATES slowly so the bright arc travels around the loop: light
  // racing along organic paths. Export bakes the identical static
  // field and rotates the sprite — same model, same look.
  neonTrails: {
    frag: `${HEADER}
void main(){
  vec2 asp = vec2(uP2.x, 1.);
  vec2 c0 = vec2(0.5, 0.5) * asp;
  vec2 dr = vUv * asp - c0;
  float ca = cos(uP0.x), sa = sin(uP0.x);
  vec2 d = c0 + mat2(ca, -sa, sa, ca) * dr;
  const int M = 26;
  float sig = 0.008 * uP2.y;
  vec3 acc = vec3(0.);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    if (fi >= uP0.z) break;
    float ax = (0.50 + 0.26 * sin(fi * 2.13 + 0.7)) * asp.x;
    float bx = (0.30 + 0.14 * sin(fi * 1.37 + 0.2)) * asp.x;
    float kx = 1. + mod(fi, 2.);
    float ay = 0.50 + 0.24 * sin(fi * 1.71 + 2.1);
    float by = 0.24 + 0.12 * cos(fi * 2.41 + 0.5);
    float ky = 1. + mod(fi + 1., 3.);
    float off = fi * 0.331;                 // head position offset
    for (int j = 0; j < M; j++) {
      float sj = (float(j) + 0.5) / float(M) + off;
      float s1 = sj + 1.0 / float(M);
      vec2 A = vec2(
        ax + bx * sin(6.2832 * (kx * sj + fi * 0.37)),
        ay + by * sin(6.2832 * (ky * sj + fi * 0.61)));
      vec2 B = vec2(
        ax + bx * sin(6.2832 * (kx * s1 + fi * 0.37)),
        ay + by * sin(6.2832 * (ky * s1 + fi * 0.61)));
      vec2 pa = d - A, ba = B - A;
      float tj = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0., 1.);
      vec2 dp = pa - ba * tj;
      float r2 = dot(dp, dp);
      // comet weight: bright head at s≈1 fading backward along the loop
      float wj = exp(-(1. - fract(sj)) * 5.5) + 0.06;
      vec3 ncol = uP2.z > 0.5
        ? 0.55 + 0.45 * cos(6.2832 * fract(sj) * 1.4 + vec3(0., 2.09, 4.19))
        : uP1.rgb;
      acc += ncol * wj * (exp(-r2 / (2. * sig * sig))
                          + uP2.w * 0.5 * exp(-r2 / (14. * sig * sig)));
    }
  }
  frag = screen(acc * uP0.y * uP1.w * 1.4);
}`,
    pack: (c, { t, w, h }) => [
      6.2832 * c.speed * t, 0.8 + 0.2 * Math.sin(6.2832 * 0.9 * t), c.trails, 0,
      c.cr, c.cg, c.cb, c.intensity / 100,
      w / h, c.thickness, c.colMode ?? 0, c.glow,
    ],
  },

  // ── Golden Rays ───────────────────────────────────────────────────
  // uP0 = (px, py, angRad, N)   source uv, fan angle + sway, ray count
  // uP1 = (cr, cg, cb, gain)    gold tint + intensity
  // uP2 = (R0, powE, aspect, env)  reach, softness, breathe
  // uP3 = (haloAmp, -, -, -)
  goldenRays: {
    frag: `${HEADER}
void main(){
  vec2 d = (vUv - uP0.xy) * vec2(uP2.z, 1.);
  float a = atan(d.y, d.x) - uP0.z;
  float comb = pow(max(0.5 + 0.5 * sin(a * uP0.w), 0.), uP2.y);
  float rad = exp(-length(d) / max(uP2.x, 0.02));
  float halo = exp(-dot(d, d) / 0.16);
  float I = comb * rad + uP3.x * halo;
  frag = screen(uP1.rgb * I * uP1.w * uP2.w);
}`,
    pack: (c, { t, w, h }) => {
      const asp = w / h;
      return [
        c.x / 100, c.y / 100,
        (c.angle * Math.PI) / 180 + raysSwayRad(5, c.speed, t),
        c.density,
        1.0, 0.8, 0.45, (c.intensity / 100) * 1.5,
        c.length * 0.65, 3 + 14 * (1 - c.spread), asp,
        flickerEnv(0.18, 0.4 + 3 * c.speed, t),
        c.halo * 0.9, 0, 0, 0,
      ];
    },
  },
};
