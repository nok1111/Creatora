"""Caption lane in the main timeline: cues render as draggable blocks,
body-drag moves, edge-drag retimes, double-click adds/edits text, Delete
removes, S splits at the playhead — all on the same timebase as clips.
"""
import json, sys, time
sys.path.insert(0, "qa")
from qa_common import connect, js

fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {str(extra).encode('ascii','replace').decode()}" if extra else ""))
    if not ok:
        fails.append(name)


c = connect(reload=True)

# Open the multi-clip QA project and switch to the timeline tab.
js(c, """window.__qa.useProject.getState().openFromPath(
  "C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora")""", True)
time.sleep(2)
js(c, """(() => { const b = [...document.querySelectorAll('button')]
  .find(e => /timeline/i.test(e.textContent)); if (b) b.click(); })()""", False)
time.sleep(1)

check("sublane rendered", bool(js(c, "!!document.querySelector('[data-sublane]')", False)))

# Clear leftover cues from previous runs, then seed three fresh ones.
js(c, "window.__qa.useEditor.getState().mutate(d => ({ ...d, subtitles: [] }))", False)
time.sleep(0.3)

# Seed three cues via the undo-safe engine mutation.
js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => {
    let n = d;
    for (const [s, e, t] of [[2000, 4500, "first caption"], [5000, 8000, "second caption"], [9500, 12000, "third caption"]]) {
      n = window.__qa.engine.addCue(n, { startMs: s, endMs: e, text: t, words: [] }).doc;
    }
    return n;
  });
})()""", False)
time.sleep(0.5)

subs = lambda: js(c, "window.__qa.useProject.getState().doc.subtitles", False)
check("3 cues seeded", len(subs() or []) == 3, len(subs() or []))
blocks = c.rects("[data-cue]")
check("3 cue blocks rendered", len(blocks) == 3, len(blocks))

# Geometry: block x/width must match msToPx(start/duration).
pps = js(c, "window.__qa.useEditor.getState().pxPerSec", False)
lane = c.rect("[data-sublane]")
c1 = js(c, "window.__qa.useProject.getState().doc.subtitles.find(c=>c.text==='first caption')", False)
b1 = next(b for b in c.rects("[data-cue]") if "first caption" in b["text"])
check("block position matches cue times",
      abs((lane["x"] + c1["startMs"] / 1000 * pps) - b1["x"]) < 3 and
      abs(((c1["endMs"] - c1["startMs"]) / 1000 * pps) - b1["w"]) < 3,
      f"x={b1['x']:.0f} w={b1['w']:.0f}")

# --- drag body: move keeps duration ---
dur0 = c1["endMs"] - c1["startMs"]
c.down(b1["cx"], b1["cy"])
c.move(b1["cx"] + 3.0 * pps, b1["cy"], steps=8, sx=b1["cx"], sy=b1["cy"])
c.up(b1["cx"] + 3.0 * pps, b1["cy"])
time.sleep(0.4)
c1 = js(c, "window.__qa.useProject.getState().doc.subtitles.find(c=>c.text==='first caption')", False)
check("body drag moved cue ~3s", abs(c1["startMs"] - 5000) < 400, c1["startMs"])
check("body drag kept duration", abs((c1["endMs"] - c1["startMs"]) - dur0) < 50, c1["endMs"] - c1["startMs"])

# --- drag right edge: retime end only ---
b1 = next(b for b in c.rects("[data-cue]") if "first caption" in b["text"])
c.down(b1["x"] + b1["w"] - 3, b1["cy"])
c.move(b1["x"] + b1["w"] - 3 + 2.0 * pps, b1["cy"], steps=8, sx=b1["x"] + b1["w"] - 3, sy=b1["cy"])
c.up(b1["x"] + b1["w"] - 3 + 2.0 * pps, b1["cy"])
time.sleep(0.4)
c1 = js(c, "window.__qa.useProject.getState().doc.subtitles.find(c=>c.text==='first caption')", False)
check("right edge grew end ~2s", c1["endMs"] - 7500 > 1500, c1["endMs"])
check("right edge kept start", abs(c1["startMs"] - 5000) < 400, c1["startMs"])

# --- drag left edge past end clamps to MIN_CUE_MS ---
b1 = next(b for b in c.rects("[data-cue]") if "first caption" in b["text"])
c.down(b1["x"] + 3, b1["cy"])
c.move(b1["x"] + b1["w"] + 2.0 * pps, b1["cy"], steps=10, sx=b1["x"] + 3, sy=b1["cy"])
c.up(b1["x"] + b1["w"] + 2.0 * pps, b1["cy"])
time.sleep(0.4)
c1 = js(c, "window.__qa.useProject.getState().doc.subtitles.find(c=>c.text==='first caption')", False)
check("left edge clamped to min duration", c1["endMs"] - c1["startMs"] >= 200 and c1["startMs"] < c1["endMs"],
      f"{c1['startMs']}-{c1['endMs']}")

# --- double-click cue: inline text edit ---
b2 = next(b for b in c.rects("[data-cue]") if "second caption" in b["text"])
x, y = b2["cx"], b2["cy"]
for cc in (1, 2):
    c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": cc})
    c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": cc})
time.sleep(0.4)
check("inline edit input opens", bool(js(c, "!!document.querySelector('[data-cue] input')", False)))
js(c, "document.execCommand('selectAll'); document.execCommand('insertText', false, 'EDITED caption')", False)
c.key("Enter", "Enter", 13)
time.sleep(0.4)
edited = [s for s in subs() if s["text"] == "EDITED caption"]
check("text edit committed", len(edited) == 1, [s["text"] for s in subs()])

# --- double-click empty lane: creates a cue at that ms ---
# Project is ~16.3s; 14s is inside the lane and clear of seeded cues.
# Scroll the timeline so 14s is inside the viewport before clicking.
js(c, """(() => {
  const lane = document.querySelector('[data-sublane]');
  let sc = lane.parentElement;
  while (sc && sc.scrollWidth <= sc.clientWidth) sc = sc.parentElement;
  if (sc) sc.scrollLeft = 14.0 * %f - 200;
})()""" % pps, False)
time.sleep(0.3)
lane = c.rect("[data-sublane]")
x = lane["x"] + 14.0 * pps
for cc in (1, 2):
    c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": lane["cy"], "button": "left", "clickCount": cc})
    c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": lane["cy"], "button": "left", "clickCount": cc})
time.sleep(0.4)
newc = [s for s in subs() if abs(s["startMs"] - 14000) < 500]
check("dblclick empty lane adds cue at 14s", len(newc) == 1, [s["startMs"] for s in subs()])
js(c, "document.execCommand('insertText', false, 'new lane cue')", False)
c.key("Enter", "Enter", 13)
time.sleep(0.3)
check("new cue text entered", any(s["text"] == "new lane cue" for s in subs()))

# --- S splits selected cue at playhead; Delete removes it ---
nc = next(s for s in subs() if s["text"] == "new lane cue")
b = next(b for b in c.rects("[data-cue]") if "new lane cue" in b["text"])
c.click(b["cx"], b["cy"])
time.sleep(0.3)
js(c, "window.__qa.useEditor.getState().setPlayhead(%d)" % (nc["startMs"] + 1000), False)
time.sleep(0.2)
n_before = len(subs())
c.key("s", "KeyS", 83)
time.sleep(0.4)
check("S split cue at playhead", len(subs()) == n_before + 1, len(subs()))
c.key("Delete", "Delete", 46)
time.sleep(0.4)
check("Delete removed selected cue", len(subs()) == n_before, len(subs()))

# --- header + button adds cue at playhead ---
js(c, "window.__qa.useEditor.getState().setPlayhead(30000)", False)
click = js(c, """(() => { const el = document.querySelector('[data-sublane]');
  const hdr = [...document.querySelectorAll('button')].find(b => b.title === 'Add caption at playhead' || b.title === 'Añadir subtítulo en el cursor');
  if (!hdr) return null; const r = hdr.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()""", False)
check("header + button exists", click is not None)
if click:
    c.click(click["x"], click["y"])
    time.sleep(0.4)
    check("+ adds cue at playhead", any(abs(s["startMs"] - 30000) < 200 for s in subs()), [s["startMs"] for s in subs()])

# --- clicking a cue seeks the playhead to it ---
js(c, """(() => {
  const lane = document.querySelector('[data-sublane]');
  let sc = lane.parentElement;
  while (sc && sc.scrollWidth <= sc.clientWidth) sc = sc.parentElement;
  if (sc) sc.scrollLeft = 9.5 * %f - 300;
})()""" % js(c, "window.__qa.useEditor.getState().pxPerSec", False), False)
time.sleep(0.3)
b3 = next(b for b in c.rects("[data-cue]") if "third caption" in b["text"])
c.click(b3["cx"], b3["cy"])
time.sleep(0.3)
ph = js(c, "window.__qa.useEditor.getState().playheadMs", False)
check("cue click seeks playhead", abs(ph - 9500) < 300, ph)

c.shot("sub_lane")

# Cleanup: remove every cue created in this run.
js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => ({ ...d, subtitles: [] }));
})()""", False)
time.sleep(0.3)
check("cleanup leaves 0 cues", len(subs() or []) == 0)

print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
