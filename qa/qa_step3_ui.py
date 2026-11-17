from qa_common import *
import time
c = connect()
c.viewport(1600, 900)
S = "window.__qa.useEditor.getState()"
def rects(tag): return c.rects(tag)
def click_text(txt, tag="button", nth=0):
    rs = [r for r in rects(tag) if r["text"].lower().startswith(txt.lower())]
    assert rs, f"no {tag} starting with {txt!r}"
    r = rs[nth]; c.click(r["cx"], r["cy"]); time.sleep(0.4); return r
def apply_tile(label):
    # hover the tile to reveal its Apply button, then click it
    tiles = [r for r in rects("div[draggable=true]") if label.lower() in r["text"].lower()]
    assert tiles, f"tile {label} not found"
    t = tiles[0]; c.move(t["cx"], t["cy"]); time.sleep(0.3)
    b = [r for r in rects("div[draggable=true] button") if r["w"] > 0 and abs(r["cy"] - t["y"]) < t["h"]]
    assert b, "Apply button not revealed on hover"
    c.click(b[0]["cx"], b[0]["cy"]); time.sleep(0.6)
doc = lambda: js(c, "(()=>{const d=window.__qa.useProject.getState().doc; return d.timeline.tracks[0]})()")
ids = [x["id"] for x in doc()["clips"]]
js(c, f"{S}.select([{json.dumps(ids[0])}])")
click_text("EFFECTS")
click_text("VFX"); apply_tile("RGB Displacement")
t = doc(); print("A.effects:", [(e["type"], e["params"]) for e in t["clips"][0]["effects"]])
click_text("Intro"); apply_tile("Hero Entrance")
click_text("Audio Reactive"); apply_tile("Beat Impact")
t = doc(); print("A.effects:", [e["type"] for e in t["clips"][0]["effects"]])
click_text("Transitions"); c.shot("qa_transitions_chip")
apply_tile("Velocity Swipe")
t = doc(); print("transitions:", t["transitions"])
js(c, f"{S}.select([{json.dumps(ids[1])}])")
apply_tile("Liquid Melt")
t = doc(); print("transitions:", [(x["type"], x["durationMs"], x.get("ease"), x.get("params")) for x in t["transitions"]])
print("clip starts:", [(x["startMs"], x["durationMs"]) for x in t["clips"]])
c.shot("qa_after_apply")
