"""Live GL parity probe: real WebView2 WebGL2 vs the CPU interpreter.

Requires the app running with --remote-debugging-port=9222 and `npm run dev`
(the probe is installed only in dev builds).
"""
import json, sys
sys.path.insert(0, "qa")
from cdp import CDP

CASES = [
    ("velocitySwipe", None, None, 0.5),
    ("velocitySwipe", {"direction": 3, "blur": 0.3}, "linear", 0.3),
    ("velocitySwipe", {"direction": 1}, "easeInOutCubic", 0.7),
    ("liquidMelt", None, None, 0.3),
    ("liquidMelt", {"drip": 1, "wave": 0.1, "freq": 6, "wobble": 1}, "easeOut", 0.6),
]

c = CDP()
c.eval("location.reload()")
import time; time.sleep(4)
ok = True
for id_, params, ease, u in CASES:
    r = c.eval(f"window.__fxProbe({json.dumps(id_)}, {json.dumps(params)}, {json.dumps(ease)}, {u})")
    good = r["ok"] and r["fracBad"] < 0.01
    ok &= good
    print(("OK  " if good else "FAIL"), id_, params or "", ease or "", f"u={u}",
          f"psnr={r['psnr']:.1f}dB maxd={r['maxDiff']} bad={r['fracBad']*100:.2f}% gl={r['glMs']:.0f}ms status={r['status']}")
sys.exit(0 if ok else 1)
