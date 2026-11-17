from qa_common import *
import time
c = connect(); c.viewport(1600, 900)
r = js(c, """(async () => {
  const P = window.__qa.useProject; const before = JSON.stringify(P.getState().doc);
  await P.getState().save(); const path = P.getState().filePath;
  P.getState().close(); await new Promise(r=>setTimeout(r,300));
  await P.getState().openFromPath(path); location.hash = '#/editor'; await new Promise(r=>setTimeout(r,1500));
  const after = JSON.stringify(P.getState().doc);
  const a = JSON.parse(before), b = JSON.parse(after);
  const strip = d => { delete d.meta; return d; };
  return {path, same: JSON.stringify(strip(a)) === JSON.stringify(strip(b)), trs: b.timeline.tracks[0].transitions.map(t=>[t.type,t.durationMs,t.ease,t.params]), fx: b.timeline.tracks[0].clips[0].effects.map(e=>[e.type,e.params,(e.times||[]).length])};
})()""")
print(json.dumps(r, indent=1))
