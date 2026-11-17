from qa_common import *
import time
c = connect(); c.viewport(1600, 900)
rects = c.rects
def click_right(txt):
    rs = [r for r in rects("button") if r["x"] > 1050 and r["text"].lower().startswith(txt.lower())]
    assert rs, f"no right button {txt}: {[r['text'] for r in rects('button') if r['x']>1050]}"
    c.click(rs[0]["cx"], rs[0]["cy"]); time.sleep(0.6)
fx = lambda: js(c, "window.__qa.useProject.getState().doc.timeline.tracks[0].clips[0].effects")
click_right("Effects")
c.shot("qa_f2_inspector_fx")
# real click on Detect beats, wait for job
click_right("Detect beats"); time.sleep(6)
e = [x for x in fx() if x["type"] == "beatImpact"][0]
print("beats detected:", len(e.get("times") or []), (e.get("times") or [])[:12])
c.shot("qa_f2_after_beats")
