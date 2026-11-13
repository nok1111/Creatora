/**
 * WebAudio preview graph (ADR-026): MediaElementSource → [EQ/HP/LP
 * biquads] → [DynamicsCompressor] → StereoPanner → Gain → destination.
 * Ducking uses an AnalyserNode on the SOURCE element → per-frame gain on
 * the target — the same detection model as the render's sidechaincompress
 * (preview tolerance ±3 dB; render is authoritative).
 *
 * If AudioContext is unavailable/fails we fall back to element.volume —
 * never break playback for processing.
 */

interface Chain {
  src: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  panner: StereoPannerNode;
  gain: GainNode;
  filters: (BiquadFilterNode | DynamicsCompressorNode)[];
}

let ctx: AudioContext | null = null;
const chains = new WeakMap<HTMLMediaElement, Chain>();

export function audioCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
  return ctx;
}

export function resumeAudio() {
  void audioCtx()?.resume().catch(() => {});
}

/** Attach (or fetch) the processing chain for a media element. */
export function chainFor(el: HTMLMediaElement): Chain | null {
  const c = audioCtx();
  if (!c) return null;
  const existing = chains.get(el);
  if (existing) return existing;
  try {
    const src = c.createMediaElementSource(el);
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;
    const panner = c.createStereoPanner();
    const gain = c.createGain();
    src.connect(analyser);
    src.connect(panner);
    panner.connect(gain);
    gain.connect(c.destination);
    const chain: Chain = { src, analyser, panner, gain, filters: [] };
    chains.set(el, chain);
    return chain;
  } catch {
    return null;
  }
}

/** RMS of a chain's element right now (0–1), or -1 if underrun. */
export function rmsOf(chain: Chain, buf: Uint8Array<ArrayBuffer>): number {
  chain.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

const EQ_BANDS = [200, 1000, 8000];

/** Rebuild the middle of the chain when the clip's audio fx list changes. */
export function applyFx(
  _el: HTMLMediaElement,
  chain: Chain,
  fx: { type: string; enabled: boolean; params: Record<string, number> }[],
) {
  const c = audioCtx();
  if (!c) return;
  // disconnect current mid-chain
  for (const f of chain.filters) f.disconnect();
  chain.filters = [];
  try {
    chain.panner.disconnect();
    chain.src.disconnect();
    chain.src.connect(chain.analyser);
  } catch {
    /* already disconnected */
  }
  let head: AudioNode = chain.src;
  for (const e of fx) {
    if (!e.enabled) continue;
    const p = (k: string, d: number) => e.params[k] ?? d;
    let node: AudioNode | null = null;
    switch (e.type) {
      case "highpass": {
        const b = c.createBiquadFilter();
        b.type = "highpass";
        b.frequency.value = p("freq", 80);
        node = b;
        break;
      }
      case "lowpass": {
        const b = c.createBiquadFilter();
        b.type = "lowpass";
        b.frequency.value = p("freq", 12000);
        node = b;
        break;
      }
      case "eq": {
        for (const [i, band] of EQ_BANDS.entries()) {
          const g = p(["low", "mid", "high"][i], 0);
          if (!g) continue;
          const b = c.createBiquadFilter();
          b.type = "peaking";
          b.frequency.value = band;
          b.gain.value = g;
          node && head.connect(node as AudioNode);
          node ? (node as AudioNode).connect(b) : head.connect(b);
          head = b;
          node = b;
          chain.filters.push(b);
        }
        break;
      }
      case "compressor": {
        const d = c.createDynamicsCompressor();
        d.threshold.value = p("thresholdDb", -18);
        d.ratio.value = p("ratio", 3);
        d.attack.value = p("attackMs", 20) / 1000;
        d.release.value = p("releaseMs", 250) / 1000;
        node = d;
        break;
      }
      default:
        break; // denoise/limiter/deesser/noisegate: render-only (documented)
    }
    if (node) {
      head.connect(node);
      head = node;
      chain.filters.push(node as BiquadFilterNode);
    }
  }
  head.connect(chain.panner);
}

export interface DuckState {
  /** smoothed gain 0–1 */
  g: number;
  /** hold countdown, s */
  hold: number;
}

/** One ducking evaluation step → target gain multiplier (attack/release/hold). */
export function duckStep(
  st: DuckState,
  srcRms: number,
  rule: { thresholdDb: number; reductionDb: number; attackMs: number; releaseMs: number; holdMs: number },
  dt: number,
): number {
  const thresh = Math.pow(10, rule.thresholdDb / 20);
  const target = srcRms > thresh ? Math.pow(10, rule.reductionDb / 20) : 1;
  if (target < 1) st.hold = rule.holdMs / 1000;
  else if (st.hold > 0) {
    st.hold -= dt;
  }
  const want = st.hold > 0 ? Math.pow(10, rule.reductionDb / 20) : target;
  const rate = want < st.g ? rule.attackMs / 1000 : rule.releaseMs / 1000;
  const k = Math.min(1, dt / Math.max(rate, 1e-3));
  st.g += (want - st.g) * k;
  return st.g;
}
