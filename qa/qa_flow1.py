from qa_common import *
import time
c = connect(reload=True)
c.viewport(1600, 900)
S = "window.__qa.useEditor.getState()"
rects = c.rects
def click_text(txt, tag="button", nth=0, exact=False):
    rs = [r for r in rects(tag) if (r["text"].lower() == txt.lower() if exact else r["text"].lower().startswith(txt.lower()))]
    assert rs, f"no {tag} {txt!r}: {[r['text'] for r in rects(tag)][:30]}"
    r = rs[nth]; c.click(r["cx"], r["cy"]); time.sleep(0.5); return r
def apply_tile(label):
    tiles = [r for r in rects("div[draggable=true]") if label.lower() in r["text"].lower()]
    assert tiles, f"tile {label} missing"
    t = tiles[0]; c.move(t["cx"], t["cy"]); time.sleep(0.3)
    b = [r for r in rects("div[draggable=true] button") if r["w"] > 0 and t["y"] <= r["cy"] <= t["y"] + t["h"]]
    assert b, "Apply not revealed"
    c.click(b[0]["cx"], b[0]["cy"]); time.sleep(0.6)
track = lambda: js(c, "window.__qa.useProject.getState().doc.timeline.tracks[0]")

# fresh project with 3 clips
js(c, """(async () => {
  const q = window.__qa, P = q.useProject, E = q.useEditor, eng = q.engine;
  const assets = await q.api.listAssets(); const by = n => assets.find(a => a.name === n);
  P.getState().applyOpenResult(await q.api.createProject({name: "QA flow " + Date.now(), width: 1920, height: 1080, fpsNum: 30, fpsDen: 1}));
  let doc = P.getState().doc, t = 0;
  for (const n of ["clipA.mp4","clipB.mp4","clipC.mp4"]) { const a = by(n);
    doc = eng.addClip(doc, {trackKind: "video", mediaRef: a.id, startMs: t, durationMs: a.durationMs, sourceDurationMs: a.durationMs}).doc; t += a.durationMs; }
  E.getState().mutate(() => doc); location.hash = "#/editor"; })()""")
time.sleep(2.5)
ids = [x["id"] for x in track()["clips"]]
js(c, f"{S}.select([{json.dumps(ids[0])}])")
click_text("EFFECTS", exact=True)
click_text("VFX"); apply_tile("RGB Displacement")
click_text("Intro"); apply_tile("Hero Entrance")
click_text("Audio Reactive"); apply_tile("Beat Impact")
# Inspector → Effects tab
c.shot("qa_f1_inspector_before")
print([r["text"] for r in rects("button") if r["x"] > 1050][:30])
