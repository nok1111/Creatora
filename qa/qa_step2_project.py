from qa_common import *
c = connect()
r = js(c, """(async () => {
  const q = window.__qa; const P = q.useProject, E = q.useEditor, eng = q.engine;
  const assets = await q.api.listAssets();
  const by = n => assets.find(a => a.name === n);
  const res = await q.api.createProject({name: "QA batch1", width: 1920, height: 1080, fpsNum: 30, fpsDen: 1});
  P.getState().applyOpenResult(res);
  let doc = P.getState().doc;
  // 3 clips on V1, back to back, plus clip audio comes with the videos
  let t = 0; const ids = [];
  for (const n of ["clipA.mp4","clipB.mp4","clipC.mp4"]) {
    const a = by(n);
    const out = eng.addClip(doc, {trackKind: "video", mediaRef: a.id, startMs: t, durationMs: a.durationMs, sourceDurationMs: a.durationMs});
    doc = out.doc; ids.push(out.clipId); t += a.durationMs;
  }
  E.getState().mutate(() => doc);
  location.hash = "#/editor";
  await new Promise(r => setTimeout(r, 2500));
  const d = P.getState().doc;
  return {filePath: P.getState().filePath, tracks: d.timeline.tracks.map(t => ({id:t.id, kind:t.kind, clips:t.clips.map(c=>({id:c.id,start:c.startMs,dur:c.durationMs}))})), ids,
          videos: [...document.querySelectorAll('video')].map(v => ({src: v.src.slice(0,90), ready: v.readyState, err: v.error && v.error.code, w: v.videoWidth}))};
})()""")
print(json.dumps(r, indent=1))
