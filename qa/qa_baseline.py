from qa_common import *
import time
c = connect(reload=True); c.viewport(1600, 900)
path = "C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora"
js(c, f"""(async()=>{{const q=window.__qa; await q.useProject.getState().openFromPath({json.dumps(path)}); location.hash='#/editor'; await new Promise(r=>setTimeout(r,2000));}})()""")
# baseline export: same project but effects disabled + transitions removed
r = js(c, """(async()=>{const q=window.__qa; const P=q.useProject; const doc=JSON.parse(JSON.stringify(P.getState().doc));
 for (const t of doc.timeline.tracks){ t.transitions=[]; for (const c of t.clips) for (const e of c.effects) e.enabled=false; }
 const base = doc; P.getState().setDoc(base); await P.getState().save();
 const id=await q.api.exportProject(P.getState().filePath,'%s',undefined,null); const f=await q.jobs.awaitJob(id); return f.status;})()""" % os.path.abspath("qa/out/export_base.mp4").replace("\\","/"))
t0=time.time(); print("baseline:", r)
# reload doc with effects (reopen to get real doc back) then measure param-edit → preview change
js(c, f"""window.__qa.useProject.getState().openFromPath({json.dumps(path)})"""); time.sleep(2)
js(c,"window.__qa.useEditor.getState().setPlayhead(5600)",await_promise=False); time.sleep(1.5)
def grab(name):
    d = js(c,"document.querySelector('canvas[style*=inset]').toDataURL('image/png')",await_promise=False)
    open(f"qa/out/{name}.png","wb").write(base64.b64decode(d.split(",")[1]))
import base64
grab("gl_swipe_down")
js(c,"""(()=>{const q=window.__qa; const tr=q.useProject.getState().doc.timeline.tracks[0].transitions[0];
 q.useEditor.getState().mutate(d=>{const n=JSON.parse(JSON.stringify(d)); const t2=n.timeline.tracks[0].transitions.find(x=>x.id===tr.id); t2.params.direction=0; return n;});})()""",await_promise=False)
time.sleep(1.2)
grab("gl_swipe_right")
