from qa_common import *
import time
c = connect(reload=True); c.viewport(1600, 900)
path = "C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora"
js(c, f"""(async()=>{{const q=window.__qa; await q.useProject.getState().openFromPath({json.dumps(path)}); location.hash='#/editor'; await new Promise(r=>setTimeout(r,2500));}})()""")
def play(start, dur, label):
    return js(c, f"""(async()=>{{ const E=window.__qa.useEditor.getState(); E.setPlaying(false); E.setPlayhead({start}); await new Promise(r=>setTimeout(r,1200));
      const dts=[]; let last=performance.now(); let run=true; const loop=(n)=>{{ dts.push(n-last); last=n; if(run) requestAnimationFrame(loop); }}; requestAnimationFrame(loop);
      E.setPlaying(true); await new Promise(r=>setTimeout(r,{dur})); window.__qa.useEditor.getState().setPlaying(false); run=false;
      dts.shift(); dts.sort((a,b)=>a-b); const avg=dts.reduce((a,b)=>a+b,0)/dts.length;
      return {{label:{json.dumps(label)}, frames:dts.length, fps:+(1000/avg).toFixed(1), p95ms:+dts[Math.floor(dts.length*0.95)].toFixed(1), maxms:+dts[dts.length-1].toFixed(1), q: window.__qa.useEditor.getState().previewQuality}}; }})()""")
print(play(2000, 3000, "clip A (3 library effects, no transition)"))
print(play(4800, 2500, "through Velocity Swipe (GL)"))
print(play(10000, 2000, "through Liquid Melt (GL)"))
print(play(12500, 2500, "clip C plain"))
# GL cost + heap
print(js(c, """(()=>{ const m = performance.memory; return m? {jsHeapMB: Math.round(m.usedJSHeapSize/1048576)} : null })()""", await_promise=False))
