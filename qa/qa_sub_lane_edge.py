"""Caption lane edge cases: overlapping cues, word-timing shift on move,
zoom stability, narrow cues, undo, vertical scroll visibility, cues past
the timeline end, drag during playback, preview sync, context menu.
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


def dblclick(x, y):
    for cc in (1, 2):
        c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": cc})
        c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": cc})


c = connect(reload=True)
js(c, """window.__qa.useProject.getState().openFromPath(
  "C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora")""", True)
time.sleep(2)
js(c, """(() => { const b = [...document.querySelectorAll('button')]
  .find(e => /timeline/i.test(e.textContent)); if (b) b.click(); })()""", False)
time.sleep(1)

subs = lambda: js(c, "window.__qa.useProject.getState().doc.subtitles", False)
pps0 = js(c, "window.__qa.useEditor.getState().pxPerSec", False)

js(c, "window.__qa.useEditor.getState().mutate(d => ({ ...d, subtitles: [] }))", False)
time.sleep(0.3)

# Seed: overlap pair, a karaoke cue with word timings, a narrow cue.
js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => {
    let n = d;
    n = window.__qa.engine.addCue(n, { startMs: 1000, endMs: 3000, text: "alpha", words: [] }).doc;
    n = window.__qa.engine.addCue(n, { startMs: 2200, endMs: 4000, text: "beta", words: [] }).doc;
    n = window.__qa.engine.addCue(n, { startMs: 6000, endMs: 10000, text: "karaoke line", words: [
      { word: "karaoke ", startMs: 6000, endMs: 7000 },
      { word: "line", startMs: 7000, endMs: 8000 },
    ] }).doc;
    n = window.__qa.engine.addCue(n, { startMs: 13000, endMs: 13400, text: "tiny", words: [] }).doc;
    return n;
  });
})()""", False)
time.sleep(0.5)
check("4 cues seeded", len(subs() or []) == 4)

# --- overlapping cues both render; top one clickable ---
blocks = c.rects("[data-cue]")
check("4 cue blocks rendered", len(blocks) == 4)
beta = next(b for b in blocks if b["text"] == "beta")
c.click(beta["x"] + 20, beta["cy"])
time.sleep(0.3)
ph = js(c, "window.__qa.useEditor.getState().playheadMs", False)
check("overlap cue clickable", abs(ph - 2200) < 300, ph)

# --- karaoke cue move: word timings must shift with the cue ---
bk = next(b for b in c.rects("[data-cue]") if "karaoke" in b["text"])
c.down(bk["cx"], bk["cy"])
c.move(bk["cx"] + 2.0 * pps0, bk["cy"], steps=8, sx=bk["cx"], sy=bk["cy"])
c.up(bk["cx"] + 2.0 * pps0, bk["cy"])
time.sleep(0.4)
k = next(s for s in subs() if "karaoke" in s["text"])
w0 = k["words"][0]
check("cue moved +2s", abs(k["startMs"] - 8000) < 400, k["startMs"])
check("word timings shifted too", abs(w0["startMs"] - 8000) < 400,
      f"cue.start={k['startMs']} word.start={w0['startMs']}")

# --- edge resize: word timings clamp inside the new range ---
bk = next(b for b in c.rects("[data-cue]") if "karaoke" in b["text"])
c.down(bk["x"] + 3, bk["cy"])
c.move(bk["x"] + 3 + 1.5 * pps0, bk["cy"], steps=8, sx=bk["x"] + 3, sy=bk["cy"])
c.up(bk["x"] + 3 + 1.5 * pps0, bk["cy"])
time.sleep(0.4)
k = next(s for s in subs() if "karaoke" in s["text"])
check("words clamped inside resized cue",
      all(w["startMs"] >= k["startMs"] and w["endMs"] <= k["endMs"] for w in k["words"]),
      [(w["startMs"], w["endMs"]) for w in k["words"]])

# --- undo restores the cue position ---
js(c, "window.__qa.useEditor.getState().undo()", False)
time.sleep(0.3)
js(c, "window.__qa.useEditor.getState().undo()", False)
time.sleep(0.3)
k = next(s for s in subs() if "karaoke" in s["text"])
check("undo restores cue", abs(k["startMs"] - 6000) < 100, k["startMs"])
js(c, "window.__qa.useEditor.getState().redo(); window.__qa.useEditor.getState().redo()", False)
time.sleep(0.3)

# --- zoom stability: block geometry tracks pxPerSec ---
for pps in (40, 240):
    js(c, "window.__qa.useEditor.getState().setZoom(%d)" % pps, False)
    time.sleep(0.5)
    k = next(s for s in subs() if "karaoke" in s["text"])
    bk = next(b for b in c.rects("[data-cue]") if "karaoke" in b["text"])
    lane = c.rect("[data-sublane]")
    exp = lane["x"] + k["startMs"] / 1000 * pps
    check("zoom %d px/s geometry" % pps, abs(exp - bk["x"]) < 4 and
          abs((k["endMs"] - k["startMs"]) / 1000 * pps - bk["w"]) < 4,
          f"x={bk['x']:.0f} exp={exp:.0f} w={bk['w']:.0f}")

# --- narrow cue: at 40px/s a 400ms cue is ~16px; body still grabbable ---
js(c, "window.__qa.useEditor.getState().setZoom(40)", False)
time.sleep(0.5)
bt = next(b for b in c.rects("[data-cue]") if b["text"] == "tiny")
t0 = next(s for s in subs() if s["text"] == "tiny")
c.down(bt["cx"], bt["cy"])
c.move(bt["cx"] + 4.0 * 40, bt["cy"], steps=8, sx=bt["cx"], sy=bt["cy"])
c.up(bt["cx"] + 4.0 * 40, bt["cy"])
time.sleep(0.4)
t1 = next(s for s in subs() if s["text"] == "tiny")
check("narrow cue body draggable", abs(t1["startMs"] - t0["startMs"]) > 3000,
      f"{t0['startMs']} -> {t1['startMs']}")
js(c, "window.__qa.useEditor.getState().setZoom(%d)" % pps0, False)
time.sleep(0.4)

# --- many tracks: lane must stay pinned under the ruler on vertical scroll ---
js(c, """(() => {
  const ed = window.__qa.useEditor.getState();
  ed.mutate(d => {
    let n = d;
    for (let i = 0; i < 3; i++) n = window.__qa.engine.addTrack(n, "video").doc;
    return n;
  });
})()""", False)
time.sleep(0.6)
scroll_v(500)
lane = c.rect("[data-sublane]")
check("lane stays pinned on vertical scroll", lane and lane["y"] < 700 and lane["y"] > 0,
      lane["y"] if lane else None)
scroll_v(0)

# --- cue past the end is reachable: lane width covers it ---
js(c, """window.__qa.useEditor.getState().mutate(d =>
  window.__qa.engine.addCue(d, { startMs: 18000, endMs: 20000, text: "tail", words: [] }).doc)""", False)
time.sleep(0.5)
sw = js(c, """(() => {
  const lane = document.querySelector('[data-sublane]');
  let sc = lane.parentElement;
  while (sc && sc.scrollWidth <= sc.clientWidth) sc = sc.parentElement;
  return sc ? sc.scrollWidth : 0;
})()""", False)
need = 176 + (20000 / 1000) * js(c, "window.__qa.useEditor.getState().pxPerSec", False)
check("cue past end reachable", sw >= need, f"scrollWidth={sw} need={need:.0f}")
scroll_h(18.0 * js(c, "window.__qa.useEditor.getState().pxPerSec", False) - 200)
bb = [b for b in c.rects("[data-cue]") if b["text"] == "tail"]
check("tail cue block visible", len(bb) == 1, len(bb))
scroll_h(0)

# --- drag during playback (keep alpha onscreen: seek home first, the
#     auto-scroller follows the playhead) ---
scroll_h(0)
js(c, "window.__qa.useEditor.getState().setPlayhead(0)", False)
js(c, "window.__qa.useEditor.getState().setPlaying(true)", False)
time.sleep(0.5)
ba = next(b for b in c.rects("[data-cue]") if b["text"] == "alpha")
a0 = next(s for s in subs() if s["text"] == "alpha")
c.down(ba["cx"], ba["cy"])
c.move(ba["cx"] - 0.5 * js(c, "window.__qa.useEditor.getState().pxPerSec", False), ba["cy"], steps=6, sx=ba["cx"], sy=ba["cy"])
c.up(ba["cx"] - 0.5 * js(c, "window.__qa.useEditor.getState().pxPerSec", False), ba["cy"])
time.sleep(0.4)
a1 = next(s for s in subs() if s["text"] == "alpha")
js(c, "window.__qa.useEditor.getState().setPlaying(false)", False)
check("drag works during playback", abs(a1["startMs"] - a0["startMs"]) > 200,
      f"{a0['startMs']} -> {a1['startMs']}")

# --- preview shows the caption under the playhead ---
js(c, "window.__qa.useEditor.getState().setPlayhead(%d)" % (a1["startMs"] + 200), False)
time.sleep(0.6)
pv = js(c, """(() => {
  const el = [...document.querySelectorAll('span')].find(e => e.textContent.trim() === 'alpha');
  return !!el;
})()""", False)
check("preview shows active caption", pv)

# --- right-click context menu on a cue ---
scroll_h(0)
ba = next(b for b in c.rects("[data-cue]") if b["text"] == "alpha")
c.rclick(ba["cx"], ba["cy"])
time.sleep(0.5)
menu_items = js(c, """(() => {
  const m = document.querySelector('[role="menu"], [data-anchored-menu]');
  return m ? [...m.querySelectorAll('button,[role=menuitem]')].map(e => e.textContent.trim()) : null;
})()""", False)
check("cue context menu opens", menu_items is not None and len(menu_items) >= 3, menu_items)
if menu_items:
    js(c, """(() => { const b = [...document.querySelectorAll('[role=menuitem],button')]
      .find(e => /delete|eliminar/i.test(e.textContent)); if (b) b.click(); })()""", False)
    time.sleep(0.4)
    check("context delete removes cue", not any(s["text"] == "alpha" for s in subs()),
          [s["text"] for s in subs()])
else:
    c.esc()

# --- Escape cancels inline edit without committing ---
bb2 = next(b for b in c.rects("[data-cue]") if b["text"] == "beta")
dblclick(bb2["cx"], bb2["cy"])
time.sleep(0.4)
js(c, "document.execCommand('selectAll'); document.execCommand('insertText', false, 'CANCELLED')", False)
c.esc()
time.sleep(0.3)
check("Escape cancels edit", any(s["text"] == "beta" for s in subs()) and
      not any(s["text"] == "CANCELLED" for s in subs()))

c.shot("sub_lane_edge")

# cleanup: restore tracks/cues
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
