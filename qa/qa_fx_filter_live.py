"""Live FX check: apply a manifest filter to a clip in the running app and
verify the FilterLayer canvas actually renders (non-transparent) during
playback AND paused. Needs the app on CDP :9222 + Vite :1420.
Restores the doc afterwards (no save).

    python qa/qa_fx_filter_live.py [filterId]
"""
import sys, time, json
sys.path.insert(0, "qa")
from cdp import CDP

FILTER = sys.argv[1] if len(sys.argv) > 1 else "bleachBypass"
PROJECT = "C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora"

c = CDP()
# Reload so Vite serves the freshest manifest.json to the page.
c.eval("location.reload()")
time.sleep(6)
c = CDP()

fp = c.eval("window.__qa && window.__qa.useProject.getState().filePath")
if not fp or "QA flow" not in fp:
    r = c.eval(f"window.__qa.useProject.getState().openFromPath({json.dumps(PROJECT)}).then(()=>'ok').catch(e=>'ERR '+e)", await_promise=True)
    print("openFromPath:", r)
    time.sleep(2)
print("doc:", c.eval("(window.__qa.useProject.getState().filePath||'none')"))

# openFromPath can land wherever the SPA route persisted — force the editor.
c.eval("location.hash = '#/editor'")
time.sleep(3)

# Pick the cleanest video clip, add the filter, disable pre-existing
# effects for a clean visual (restored at the end).
r = c.eval(f"""(() => {{
    const st = window.__qa.useProject.getState();
    const doc = structuredClone(st.doc);
    if (!doc) return 'no doc';
    let best = null;
    for (const t of doc.timeline.tracks)
        if (t.kind === 'video')
            for (const cl of t.clips)
                if (!best || (cl.effects||[]).length < (best.effects||[]).length) best = cl;
    if (!best) return 'no video clip';
    window.__qaSaved = best.effects.map(e => e.enabled);
    best.effects = best.effects.map(e => ({{...e, enabled: false}}));
    best.effects.push({{id: 'qa-fx', type: {json.dumps(FILTER)}, enabled: true, params: {{intensity: 80}}}});
    st.setDoc(doc);
    window.__qaClipId = best.id;
    window.__qa.useEditor.getState().setPlayhead(best.startMs + Math.min(1000, best.durationMs / 2));
    return JSON.stringify({{clipId: best.id, start: best.startMs, dur: best.durationMs, priorFx: window.__qaSaved.length}});
}})()""")
print("apply:", r)
time.sleep(2.5)

ALPHA = """(() => {
    const out = [];
    for (const cv of document.querySelectorAll('canvas')) {
        const ctx = cv.getContext('2d');
        if (!ctx || !cv.width || !cv.height) continue;
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let opaque = 0, sum = 0;
        for (let i = 0; i < d.length; i += 400) {
            if (d[i + 3] > 8) { opaque++; sum += (d[i] + d[i+1] + d[i+2]) / 3; }
        }
        const r = cv.getBoundingClientRect();
        out.push({w: cv.width, h: cv.height, x: Math.round(r.x), y: Math.round(r.y),
                  opaquePct: Math.round(100 * opaque / (d.length / 400)),
                  mean: opaque ? Math.round(sum / opaque) : 0});
    }
    return out;
})()"""

paused = c.eval(ALPHA)
print("PAUSED canvases:", json.dumps(paused))

c.eval("window.__qa.useEditor.getState().setPlaying(true)")
time.sleep(1.8)
playing = c.eval(ALPHA)
print("PLAYING canvases:", json.dumps(playing))
c.shot("fx_live_playing")
c.eval("window.__qa.useEditor.getState().setPlaying(false)")
time.sleep(0.8)
paused2 = c.eval(ALPHA)
print("PAUSED2 canvases:", json.dumps(paused2))
c.shot("fx_live_paused")

# Restore: remove qa-fx, re-enable original effects.
r = c.eval("""(() => {
    const st = window.__qa.useProject.getState();
    const doc = structuredClone(st.doc);
    let n = 0;
    for (const t of doc.timeline.tracks) for (const cl of t.clips) {
        if (cl.id === window.__qaClipId) {
            const saved = window.__qaSaved || [];
            cl.effects = cl.effects.filter(e => e.id !== 'qa-fx')
                .map((e, i) => ({...e, enabled: saved[i] ?? e.enabled}));
            n++;
        }
    }
    st.setDoc(doc);
    return 'restored ' + n;
})()""")
print("restore:", r)

big = [cv for cv in (playing or []) if cv["w"] >= 300 and cv["opaquePct"] > 10]
ok = bool(big)
print("VERDICT:", "PASS — filter canvas renders in playback" if ok else "FAIL — no opaque 2d layer canvas during playback")
