from qa_common import *
import time
c = connect(); c.viewport(1600, 900)
S = "window.__qa.useEditor.getState()"; rects = c.rects
doc = lambda: js(c, "window.__qa.useProject.getState().doc.timeline.tracks[0]")
def click_text(txt, tag="button", exact=False, right=False):
    rs = [r for r in rects(tag) if (r["text"].lower()==txt.lower() if exact else r["text"].lower().startswith(txt.lower())) and (r["x"]>1050)==right]
    assert rs, f"no {txt}"; c.click(rs[0]["cx"], rs[0]["cy"]); time.sleep(0.5)
def apply_tile(label):
    t = [r for r in rects("div[draggable=true]") if label.lower() in r["text"].lower()][0]
    c.move(t["cx"], t["cy"]); time.sleep(0.3)
    b = [r for r in rects("div[draggable=true] button") if r["w"]>0 and t["y"]<=r["cy"]<=t["y"]+t["h"]][0]
    c.click(b["cx"], b["cy"]); time.sleep(0.6)
ids = [x["id"] for x in doc()["clips"]]
click_text("EFFECTS", exact=True); click_text("Transitions")
js(c, f"{S}.select([{json.dumps(ids[1])}])"); apply_tile("Velocity Swipe")
js(c, f"{S}.select([{json.dumps(ids[2])}])"); apply_tile("Liquid Melt")
t = doc(); print("transitions:", [(x["type"], x["durationMs"]) for x in t["transitions"]], [(x["startMs"]) for x in t["clips"]])
# Edit via Inspector (select B → Animation tab shows its transitions)
js(c, f"{S}.select([{json.dumps(ids[1])}])"); time.sleep(0.5)
click_text("Animation", right=True)
c.shot("qa_f3_transition_inspector")
# duration input: number input showing 500
res = js(c, """(()=>{ const set = %s; const out = {};
  const nums=[...document.querySelectorAll('input[type=number]')]; const dur = nums.find(n=>n.title && /duration/i.test(n.title)) || nums[0];
  out.durBefore = dur.value; set(dur, 800);
  const sels=[...document.querySelectorAll('select')]; const ease = sels.find(s=>[...s.options].some(o=>o.value==='easeOutExpo')); out.easeBefore = ease && ease.value; if (ease) set(ease, 'easeOutExpo');
  return out; })()""" % SET_VAL, await_promise=False)
time.sleep(0.6)
t = doc(); print(res); print("after edit:", [(x["type"], x["durationMs"], x.get("ease")) for x in t["transitions"]], [x["startMs"] for x in t["clips"]])
# param slider (blur) of the swipe
res = js(c, """(()=>{ const set=%s; const r=[...document.querySelectorAll('input[type=range]')]; const labels=[...document.querySelectorAll('span')].filter(s=>s.textContent==='Motion blur');
  const row=labels[0].parentElement; const slider=row.querySelector('input[type=range]'); set(slider, 0.3); return slider.value; })()""" % SET_VAL, await_promise=False)
time.sleep(0.5); t = doc(); print("swipe params:", t["transitions"][0]["params"] if t["transitions"][0]["type"]=="velocitySwipe" else [x["params"] for x in t["transitions"]])
c.shot("qa_f3_after_edit")
