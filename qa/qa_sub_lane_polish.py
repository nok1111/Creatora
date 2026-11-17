"""Caption lane polish: sticky under deep vertical scroll, arrow-key nudge,
active-cue highlight, overlap dot, scrub-while-dragging.
"""
import json, sys, time
sys.path.insert(0, "qa")
from qa_common import connect, js

fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {str(extra).encode('ascii','replace').decode()}" if extra else ""))
    if not ok:
        fails.append(name)


def scroll_h(px):
    js(c, """(() => {
      const lane = document.querySelector('[data-sublane]');
      let sc = lane.parentElement;
      while (sc && sc.scrollWidth <= sc.clientWidth) sc = sc.parentElement;
      if (sc) sc.scrollLeft = %d;
    })()""" % px, False)
    time.sleep(0.3)


def scroll_v(px):
    js(c, """(() => {
      const lane = document.querySelector('[data-sublane]');
      let sc = lane.parentElement;
      while (sc && sc.scrollWidth <= sc.clientWidth) sc = sc.parentElement;
      if (sc) sc.scrollTop = %d;
    })()""" % px, False)
    time.sleep(0.3)


c = connect(reload=True)
js(c, """window.__qa.useProject.getState().openFromPath(
  "C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora")""", True)
time.sleep(2)
js(c, """(() => { const b = [...document.querySelectorAll('button')]
  .find(e => /timeline/i.test(e.textContent)); if (b) b.click(); })()""", False)
time.sleep(1)

subs = lambda: js(c, "window.__qa.useProject.getState().doc.subtitles", False)
pps = js(c, "window.__qa.useEditor.getState().pxPerSec", False)

js(c, "window.__qa.useEditor.getState().mutate(d => ({ ...d, subtitles: [] }))", False)
time.sleep(0.3)
js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => {
    let n = d;
    n = window.__qa.engine.addCue(n, { startMs: 2000, endMs: 4200, text: "one", words: [] }).doc;
    n = window.__qa.engine.addCue(n, { startMs: 4000, endMs: 6000, text: "two", words: [] }).doc;
    n = window.__qa.engine.addCue(n, { startMs: 8000, endMs: 10000, text: "three", words: [] }).doc;
    return n;
  });
})()""", False)
time.sleep(0.5)

# --- arrow-key nudge: 1 frame, Shift = 500ms ---
b1 = next(b for b in c.rects("[data-cue]") if b["text"] == "one")
c.click(b1["cx"], b1["cy"])
time.sleep(0.3)
c.key("ArrowRight", "ArrowRight", 39)
time.sleep(0.3)
s1 = next(s for s in subs() if s["text"] == "one")
frame_ms = 1000 / 30  # QA project is 30fps
check("ArrowRight nudges 1 frame", abs(s1["startMs"] - (2000 + frame_ms)) < 20, s1["startMs"])
check("nudge kept duration", abs((s1["endMs"] - s1["startMs"]) - 2200) < 20)
c.key("ArrowRight", "ArrowRight", 39, modifiers=8)  # Shift
time.sleep(0.3)
s1 = next(s for s in subs() if s["text"] == "one")
check("Shift+ArrowRight nudges 500ms", abs(s1["startMs"] - (2000 + frame_ms + 500)) < 20, s1["startMs"])
c.key("ArrowLeft", "ArrowLeft", 37)
time.sleep(0.3)

# --- overlap cue gets the warning dot ---
check("overlap dot rendered", bool(js(c, "!!document.querySelector('[data-cue] .bg-amber-400')", False)))

# --- active cue highlight follows the playhead ---
cue_cls = lambda text: js(c, """(() => {
  const el = [...document.querySelectorAll('[data-cue]')].find(e => e.textContent.includes(%s));
  return el ? el.className : '';
})()""" % json.dumps(text), False)
js(c, "window.__qa.useEditor.getState().setPlayhead(8500)", False)
time.sleep(0.5)
cls = cue_cls("three")
check("active cue highlighted", "emerald-200" in cls, cls)
js(c, "window.__qa.useEditor.getState().setPlayhead(11000)", False)
time.sleep(0.5)
cls = cue_cls("three")
check("highlight clears off cue", "emerald-200" not in cls, cls)

# --- scrub while dragging: playhead follows the dragged edge ---
b3 = next(b for b in c.rects("[data-cue]") if b["text"] == "three")
js(c, "window.__qa.useEditor.getState().setPlayhead(0)", False)
c.down(b3["cx"], b3["cy"])
c.move(b3["cx"] - 2.0 * pps, b3["cy"], steps=8, sx=b3["cx"], sy=b3["cy"])
c.up(b3["cx"] - 2.0 * pps, b3["cy"])
time.sleep(0.4)
ph = js(c, "window.__qa.useEditor.getState().playheadMs", False)
s3 = next(s for s in subs() if s["text"] == "three")
check("drag scrubs playhead to cue", abs(ph - s3["startMs"]) < 100, f"ph={ph} start={s3['startMs']}")

# --- sticky lane: 5 extra tracks + deep scroll → lane pins under ruler ---
js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => {
    let n = d;
    for (let i = 0; i < 5; i++) n = window.__qa.engine.addTrack(n, "video").doc;
    return n;
  });
})()""", False)
time.sleep(0.6)
sc_top = js(c, """(() => {
  const lane = document.querySelector('[data-sublane]');
  let sc = lane.parentElement;
  while (sc && sc.scrollWidth <= sc.clientWidth) sc = sc.parentElement;
  return sc ? sc.getBoundingClientRect().y : 0;
})()""", False)
scroll_v(600)
lane = c.rect("[data-sublane]")
expected = sc_top + 24
check("lane sticky under ruler on deep scroll", lane and abs(lane["y"] - expected) < 6,
      f"y={lane['y'] if lane else None} expected~{expected:.0f}")
hdr = js(c, """(() => {
  const el = [...document.querySelectorAll('div')].find(d => d.textContent.trim() === 'captions' || /^captions\\s*\\d+$/.test(d.textContent.trim()));
  if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x, y:r.y};
})()""", False)
check("lane header sticky too", hdr is not None and abs(hdr["y"] - expected) < 6, hdr)
scroll_v(0)

# --- undo still single-step for a full drag gesture ---
# (undo #1 reverts the addTrack mutate above, #2 reverts the drag)
js(c, "window.__qa.useEditor.getState().undo(); window.__qa.useEditor.getState().undo()", False)
time.sleep(0.4)
s3 = next(s for s in subs() if s["text"] == "three")
check("one undo reverts whole drag", abs(s3["startMs"] - 8000) < 100, s3["startMs"])

c.shot("sub_lane_polish")

js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => ({
    ...d,
    subtitles: [],
    timeline: { ...d.timeline, tracks: d.timeline.tracks.filter(t => t.clips.length > 0) },
  }));
})()""", False)
time.sleep(0.3)
check("cleanup", len(subs() or []) == 0)

print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
