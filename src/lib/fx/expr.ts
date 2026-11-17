/**
 * ffmpeg-expression engine for transition recipes.
 *
 * The render consumes recipes verbatim (`xfade=transition=custom:expr=…`);
 * the preview needs the SAME math on the GPU. This module parses the
 * dialect once and offers two back-ends over one AST:
 *
 *  - `evaluate`  — CPU reference interpreter. Used by tests to prove the
 *                  dialect semantics match real ffmpeg frames (PSNR) and to
 *                  cross-check the GLSL output in the live app.
 *  - `toGlsl`    — GLSL ES 3.00 emitter for the WebGL2 preview.
 *
 * Semantics pinned against ffmpeg 9.0 (measured, see fx tests): sampling is
 * nearest-pixel with edge clamp, `mod` is floored, results truncate to an
 * 8-bit integer, Y=0 is the top row, and expressions are evaluated once per
 * plane/channel.
 */

export type Node =
  | { t: "num"; v: number }
  | { t: "var"; n: string }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { t: "call"; n: string; args: Node[] };

// ── parser ────────────────────────────────────────────────────────────

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "p"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(.))/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) out.push({ k: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ k: "id", v: m[2] });
    else if (m[3] !== undefined && m[3].trim()) out.push({ k: "p", v: m[3] });
  }
  return out;
}

/** Precedence (ffmpeg): `+ -` < `* /` < `^`; unary minus on primaries. */
export function parse(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const eat = (v?: string) => {
    const t = toks[i++];
    if (!t || (v !== undefined && !(t.k === "p" && t.v === v)))
      throw new Error(`expr: expected '${v ?? "token"}' at ${i} in: ${src.slice(0, 120)}`);
    return t;
  };
  const isP = (v: string) => peek()?.k === "p" && (peek() as { v: string }).v === v;

  function primary(): Node {
    const t = peek();
    if (!t) throw new Error("expr: unexpected end");
    if (t.k === "num") return (i++, { t: "num", v: t.v });
    if (t.k === "id") {
      i++;
      if (isP("(")) {
        eat("(");
        const args: Node[] = [];
        if (!isP(")")) {
          args.push(sum());
          while (isP(",")) (eat(","), args.push(sum()));
        }
        eat(")");
        return { t: "call", n: t.v, args };
      }
      return { t: "var", n: t.v };
    }
    if (t.v === "(") {
      eat("(");
      const e = sum();
      eat(")");
      return e;
    }
    if (t.v === "-") return (i++, { t: "neg", a: pow() });
    if (t.v === "+") return (i++, pow());
    throw new Error(`expr: unexpected '${t.v}'`);
  }
  function pow(): Node {
    let a = primary();
    while (isP("^")) (eat("^"), (a = { t: "bin", op: "^", a, b: primary() }));
    return a;
  }
  function term(): Node {
    let a = pow();
    while (isP("*") || isP("/")) {
      const op = (eat() as { v: "*" | "/" }).v;
      a = { t: "bin", op, a, b: pow() };
    }
    return a;
  }
  function sum(): Node {
    let a = term();
    while (isP("+") || isP("-")) {
      const op = (eat() as { v: "+" | "-" }).v;
      a = { t: "bin", op, a, b: term() };
    }
    return a;
  }
  const root = sum();
  if (i < toks.length) throw new Error(`expr: trailing tokens in: ${src.slice(0, 120)}`);
  return root;
}

// ── CPU reference interpreter ─────────────────────────────────────────

export interface EvalEnv {
  vars: Record<string, number>;
  /** nearest-pixel, edge-clamped samples of the current channel (0–255). */
  sa: (x: number, y: number) => number;
  sb: (x: number, y: number) => number;
}

const b2n = (b: boolean) => (b ? 1 : 0);
const fmod = (a: number, b: number) => a - b * Math.floor(a / b);

export function evaluate(n: Node, env: EvalEnv): number {
  switch (n.t) {
    case "num":
      return n.v;
    case "var": {
      if (n.n === "PI") return Math.PI;
      if (n.n === "E") return Math.E;
      if (n.n === "A") return env.sa(env.vars.X, env.vars.Y);
      if (n.n === "B") return env.sb(env.vars.X, env.vars.Y);
      const v = env.vars[n.n];
      if (v === undefined) throw new Error(`expr: unknown variable ${n.n}`);
      return v;
    }
    case "neg":
      return -evaluate(n.a, env);
    case "bin": {
      const a = evaluate(n.a, env);
      const b = evaluate(n.b, env);
      return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : n.op === "/" ? a / b : Math.pow(a, b);
    }
    case "call": {
      const a = n.args;
      const e = (k: number) => evaluate(a[k], env);
      switch (n.n) {
        case "if": return e(0) !== 0 ? e(1) : e(2);
        case "ifnot": return e(0) === 0 ? e(1) : e(2);
        case "SA": return env.sa(e(0), e(1));
        case "SB": return env.sb(e(0), e(1));
        case "lt": return b2n(e(0) < e(1));
        case "lte": return b2n(e(0) <= e(1));
        case "gt": return b2n(e(0) > e(1));
        case "gte": return b2n(e(0) >= e(1));
        case "eq": return b2n(e(0) === e(1));
        case "not": return b2n(e(0) === 0);
        case "between": { const x = e(0); return b2n(x >= e(1) && x <= e(2)); }
        case "sin": return Math.sin(e(0));
        case "cos": return Math.cos(e(0));
        case "tan": return Math.tan(e(0));
        case "atan": return Math.atan(e(0));
        case "atan2": return Math.atan2(e(0), e(1));
        case "exp": return Math.exp(e(0));
        case "log": return Math.log(e(0));
        case "sqrt": return Math.sqrt(e(0));
        case "abs": return Math.abs(e(0));
        case "floor": return Math.floor(e(0));
        case "ceil": return Math.ceil(e(0));
        case "pow": return Math.pow(e(0), e(1));
        case "min": return Math.min(e(0), e(1));
        case "max": return Math.max(e(0), e(1));
        case "clip": return Math.min(Math.max(e(0), e(1)), e(2));
        case "mod": return fmod(e(0), e(1));
        case "hypot": return Math.hypot(e(0), e(1));
        case "gauss": { const x = e(0); return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI); }
        default: throw new Error(`expr: unsupported function ${n.n}()`);
      }
    }
  }
}

/** Per-pixel result as the render stores it: truncated 8-bit. */
export const toByte = (v: number) => Math.max(0, Math.min(255, Math.floor(Number.isFinite(v) ? v : 0)));

// ── GLSL emitter ──────────────────────────────────────────────────────

const glNum = (v: number) => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + ".0";
};

export function toGlsl(n: Node): string {
  switch (n.t) {
    case "num":
      return glNum(n.v);
    case "var":
      if (n.n === "PI") return "3.14159265358979";
      if (n.n === "E") return "2.71828182845905";
      if (n.n === "A") return "sampA(X,Y)";
      if (n.n === "B") return "sampB(X,Y)";
      return n.n;
    case "neg":
      return `(-${toGlsl(n.a)})`;
    case "bin":
      return n.op === "^" ? `pow(${toGlsl(n.a)},${toGlsl(n.b)})` : `(${toGlsl(n.a)}${n.op}${toGlsl(n.b)})`;
    case "call": {
      const g = n.args.map(toGlsl);
      const c = (op: string) => `float(${g[0]}${op}${g[1]})`;
      switch (n.n) {
        case "if": return `((${g[0]})!=0.0?(${g[1]}):(${g[2]}))`;
        case "ifnot": return `((${g[0]})==0.0?(${g[1]}):(${g[2]}))`;
        case "SA": return `sampA(${g[0]},${g[1]})`;
        case "SB": return `sampB(${g[0]},${g[1]})`;
        case "lt": return c("<");
        case "lte": return c("<=");
        case "gt": return c(">");
        case "gte": return c(">=");
        case "eq": return c("==");
        case "not": return `float((${g[0]})==0.0)`;
        case "between": return `float((${g[0]})>=(${g[1]})&&(${g[0]})<=(${g[2]}))`;
        case "sin": case "cos": case "tan": case "atan": case "exp": case "log": case "sqrt": case "abs":
        case "floor": case "min": case "max": case "pow":
          return `${n.n}(${g.join(",")})`;
        case "ceil": return `ceil(${g[0]})`;
        case "atan2": return `atan(${g[0]},${g[1]})`;
        case "clip": return `min(max(${g[0]},${g[1]}),${g[2]})`;
        case "mod": return `fx_mod(${g[0]},${g[1]})`;
        case "hypot": return `length(vec2(${g[0]},${g[1]}))`;
        case "gauss": return `(exp(-(${g[0]})*(${g[0]})/2.0)/2.50662827463)`;
        default: throw new Error(`expr: unsupported function ${n.n}()`);
      }
    }
  }
}

/** Every identifier the recipe reads that is not a built-in — the shader
 *  declares these as float uniforms. */
export function freeVars(n: Node, acc = new Set<string>()): Set<string> {
  const builtin = new Set(["X", "Y", "W", "H", "u", "PLANE", "PI", "E", "A", "B"]);
  if (n.t === "var" && !builtin.has(n.n)) acc.add(n.n);
  else if (n.t === "neg") freeVars(n.a, acc);
  else if (n.t === "bin") (freeVars(n.a, acc), freeVars(n.b, acc));
  else if (n.t === "call") n.args.forEach((a) => freeVars(a, acc));
  return acc;
}
