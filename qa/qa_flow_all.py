from qa_common import *
import time
c = connect(reload=True); c.viewport(1600, 900)
S = "window.__qa.useEditor.getState()"; rects = c.rects
track = lambda: js(c, "window.__qa.useProject.getState().doc.timeline.tracks[0]")
def click_text(txt, tag="button", exact=False, right=False):
    rs = [r for r in rects(tag) if (r["text"].lower()==txt.lower() if exact else r["text"].lower().startswith(txt.lower())) and (r["x"]>1050)==right]
    assert rs, f"no {txt}"; c.click(rs[0]["cx"], rs[0]["cy"]); time.sleep(0.5)
def apply_tile(label):
    t = [r for r in rects("div[draggable=true]") if label.lower() in r["text"].lower()][0]
    c.move(t["cx"], t["cy"]); time.sleep(0.3)
    b = [r for r in rects("div[draggable=true] button") if r["w"]>0 and t["y"]<=r["cy"]<=t["y"]+t["h"]][0]
    c.click(b["cx"], b["cy"]); time.sleep(0.6)
select = lambda i: js(c, f"{S}.select([{json.dumps(ids[i])}])")

js(c, """(async () => {
  const q = window.__qa, P = q.useProject, E = q.useEditor, eng = q.engine;
  const assets = await q.api.listAssets(); const by = n => assets.find(a => a.name === n);
  P.getState().applyOpenResult(await q.api.createProject({name: "QA flow " + Date.now(), width: 1920, height: 1080, fpsNum: 30, fpsDen: 1}));
  let doc = P.getState().doc, t = 0;
  for (const n of ["clipA.mp4","clipB.mp4","clipC.mp4"]) { const a = by(n);
    doc = eng.addClip(doc, {trackKind: "video", mediaRef: a.id, startMs: t, durationMs: a.durationMs, sourceDurationMs: a.durationMs}).doc; t += a.durationMs; }
  doc.mediaRefs = [...new Set(doc.timeline.tracks.flatMap(t=>t.clips.map(c=>c.mediaRef)))].map(id=>({assetId:id, path: assets.find(a=>a.id===id).filePath, hash:null})); E.getState().mutate(() => doc); location.hash = "#/editor"; })()""")
time.sleep(2.5)
ids = [x["id"] for x in track()["clips"]]
# --- effects on clip A through the bin
select(0); click_text("EFFECTS", exact=True)
click_text("VFX"); apply_tile("RGB Displacement")
click_text("Intro"); apply_tile("Hero Entrance")
click_text("Audio Reactive"); apply_tile("Beat Impact")
click_text("Effects", right=True)
js(c, "[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Detect beats').scrollIntoView({block:'center'})", await_promise=False); time.sleep(0.4)
r = [x for x in rects("button") if x["text"]=="Detect beats"][0]; c.click(r["cx"], r["cy"]); time.sleep(5)
print("beats:", len(track()["clips"][0]["effects"][2].get("times") or []))
# --- transitions: B→C first? chain A→B then B→C (ripple keeps them adjacent)
click_text("Transitions")
select(1); apply_tile("Velocity Swipe")
select(2); apply_tile("Liquid Melt")
t = track(); print("transitions:", [(x["type"], x["durationMs"], x["ease"]) for x in t["transitions"]], "starts:", [x["startMs"] for x in t["clips"]])
# --- edit duration / ease / params of A→B through the Inspector UI
select(1); time.sleep(0.4); click_text("Animation", right=True); time.sleep(0.4)
res = js(c, """(()=>{ const set = %s; const out = {};
  const dur = [...document.querySelectorAll('input[type=number][title]')].find(n=>n.value==='500'); out.found = !!dur; if (dur) set(dur, 800);
  const ease = [...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='easeOutExpo')); if (ease) set(ease, 'easeOutExpo');
  const lab=[...document.querySelectorAll('span')].find(s=>s.textContent==='Motion blur'); if (lab) set(lab.parentElement.querySelector('input[type=range]'), 0.3);
  const dir=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.text==='Down')); if (dir) set(dir, 3);
  return out; })()""" % SET_VAL, await_promise=False)
time.sleep(0.7)
t = track(); print(res); print("after edit:", [(x["type"], x["durationMs"], x.get("ease"), x.get("params")) for x in t["transitions"]], [x["startMs"] for x in t["clips"]])
c.shot("qa_flow_inspector_transition")
