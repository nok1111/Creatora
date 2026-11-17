from qa_common import *
import base64, time, subprocess
c = connect(); c.viewport(1600, 900)
TIMES = {"hero_t100": 100, "beat_t1020": 1020, "rgb_t1400": 1400, "swipe_mid": 5600, "melt_mid": 10750, "melt_25": 10525, "swipe_25": 5400}
def stage_rect():
    return js(c, """(()=>{const e=document.querySelector('div[style*="aspect-ratio"]'); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}})()""", await_promise=False)
js(c, "window.__qa.useEditor.getState().setPlaying(false)", await_promise=False)
for name, ms in TIMES.items():
    js(c, f"window.__qa.useEditor.getState().setPlayhead({ms})", await_promise=False)
    time.sleep(1.6)
    r = stage_rect()
    d = c.send("Page.captureScreenshot", {"format":"png","clip":{"x":r["x"],"y":r["y"],"width":r["w"],"height":r["h"],"scale":1}})["data"]
    open(f"qa/out/prev_{name}.png","wb").write(base64.b64decode(d))
    st = js(c, """(()=>({gl: !!document.querySelector('canvas[style*="inset"]'), videos:[...document.querySelectorAll('video')].map(v=>[v.readyState, Math.round(v.currentTime*1000), v.style.opacity])}))()""", await_promise=False)
    print(name, ms, round(r["w"]), round(r["h"]), st)
