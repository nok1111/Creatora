from qa_common import *
import time, subprocess
c = connect(reload=True); c.viewport(1600, 900)
FF = "src-tauri/target/debug/tools/bin/"
def build(name, w, h, clips, fx, trans):
    return js(c, """(async (name,w,h,clips,fx,trans) => {
      const q = window.__qa, P = q.useProject, E = q.useEditor, eng = q.engine;
      const assets = await q.api.listAssets(); const by = n => assets.find(a => a.name === n);
      P.getState().applyOpenResult(await q.api.createProject({name, width: w, height: h, fpsNum: 30, fpsDen: 1}));
      let doc = P.getState().doc, t = 0; const ids = [];
      for (const n of clips) { const a = by(n); const r = eng.addClip(doc, {trackKind:"video", mediaRef:a.id, startMs:t, durationMs:Math.min(a.durationMs,4000), sourceDurationMs:a.durationMs}); doc=r.doc; ids.push(r.clipId); t += Math.min(a.durationMs,4000); }
      doc.mediaRefs = [...new Set(doc.timeline.tracks.flatMap(x=>x.clips.map(c=>c.mediaRef)))].map(id=>({assetId:id,path:assets.find(a=>a.id===id).filePath,hash:null}));
      const tid = doc.timeline.tracks[0].id;
      for (const [i, type, dur] of trans) doc = eng.addTransition(doc, tid, ids[i], ids[i+1], dur, type).doc;
      for (const [i, type, params] of fx) doc = eng.addEffect(doc, ids[i], {id: crypto.randomUUID(), type, enabled:true, params, times: type==='beatImpact'?[500,1000,1500,2000,2500,3000]:undefined});
      E.getState().mutate(() => doc); location.hash = "#/editor";
      await new Promise(r=>setTimeout(r,1500));
      await P.getState().save(); return P.getState().filePath; })(%s,%d,%d,%s,%s,%s)""" % (json.dumps(name), w, h, json.dumps(clips), json.dumps(fx), json.dumps(trans)))
def export(path, out):
    t0=time.time()
    r = js(c, f"""(async()=>{{const q=window.__qa; const id=await q.api.exportProject({json.dumps(path)},{json.dumps(out)},undefined,null); return await q.jobs.awaitJob(id);}})()""")
    return r["status"], r.get("error"), round(time.time()-t0,1)
cases = {
 "big4k_portrait_on_1080": (1920,1080,["clip4k.mp4","clipPortrait.mp4"],
    [(0,"rgbDisplacement",{"mode":0}),(0,"heroEntrance",{}),(0,"beatImpact",{}),(1,"heroEntrance",{}),(1,"rgbDisplacement",{"mode":2})],[(0,"velocitySwipe",600)]),
 "wide_on_9x16": (1080,1920,["clipA.mp4","clipB.mp4"],
    [(0,"heroEntrance",{}),(1,"rgbDisplacement",{"mode":1})],[(0,"liquidMelt",900)]),
 "square_1x1": (1080,1080,["clipA.mp4","clipPortrait.mp4"],[(0,"beatImpact",{})],[(0,"velocitySwipe",500)]),
}
for k,(w,h,clips,fx,tr) in cases.items():
    p = build("QA "+k, w, h, clips, fx, tr)
    out = os.path.abspath(f"qa/out/{k}.mp4").replace("\\","/")
    print(k, export(p, out))
