"""Regression: the source video disappears from the library between analysis
and generation. Must show a friendly message, create nothing, and leave no
orphan project/post (used to surface as "FOREIGN KEY constraint failed").
"""
import json, os, shutil, subprocess, sys, tempfile, time
sys.path.insert(0, "qa")
from qa_common import connect, js

FF = "tools/bin/ffmpeg.exe"
fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        fails.append(name)


tmp = tempfile.mkdtemp(prefix="creatora_rpg_")
g, l, src = (os.path.join(tmp, n) for n in ("g.wav", "l.wav", "qa_gone_src.mp4"))
subprocess.run([FF, "-y", "-loglevel", "error", "-i", "tools/test-media/speech_en.wav", "-af", "apad=pad_dur=1.5", g], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-stream_loop", "5", "-i", g, l], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", l, "-shortest",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", src], check=True)

c = connect(reload=True)
inv = lambda cmd, a={}: js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)},{json.dumps(a)})")


def wait_for(expr, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if js(c, expr, True):
            return True
        time.sleep(1)
    return False


def click(finder, wait=0.5):
    global c
    p = js(c, f"(() => {{ const el = ({finder}); el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", False)
    c.click(p["x"], p["y"])
    time.sleep(wait)


btn = lambda t: f"[...document.querySelectorAll('button')].find(e => e.textContent.trim() === {json.dumps(t)})"
posts0 = {p["id"] for p in inv("list_social_posts")}
proj0 = {p["id"] for p in inv("list_projects", {"includeArchived": True})}
aid = None
try:
    job = inv("import_media", {"paths": [src]})
    wait_for(f"window.__TAURI_INTERNALS__.invoke('list_jobs',{{kindPrefix:null,limit:50}}).then(r=>(r.find(x=>x.id==={json.dumps(job)})||{{}}).status==='done')")
    aid = next(a for a in inv("list_assets", {"kind": "video"}) if a["filePath"].lower().endswith("qa_gone_src.mp4"))["id"]
    c.eval("location.hash='#/repurpose'; location.reload()")
    time.sleep(4)
    c = connect()
    js(c, f"""(() => {{ const s = document.querySelector('select[aria-label="Choose a video"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, {json.dumps(aid)});
      s.dispatchEvent(new Event('change',{{bubbles:true}})); }})()""", False)
    time.sleep(0.4)
    click("[...document.querySelectorAll('button[aria-pressed]')].find(e=>e.textContent.includes('Short'))")
    click(btn("Find the best clips"), 1.0)
    check("analysis finished", wait_for("document.body.innerText.includes('suggested clips') && !document.body.innerText.includes('Analyzing…')", 120))

    # The source vanishes from the library while the review screen is open.
    inv("delete_asset", {"id": aid})
    aid = None
    n = js(c, "[...document.querySelectorAll('article input[type=checkbox]')].filter(i => i.checked).length", False)
    click(btn(f"Create {n} clips"), 1.5)
    time.sleep(2)
    toast = js(c, "[...document.querySelectorAll('[data-sonner-toast]')].map(t => t.innerText).join(' | ')", False)
    check("friendly message instead of a raw DB error", "no longer in your library" in toast and "FOREIGN KEY" not in toast, toast[:120])
    check("no 'Clips created' screen", not js(c, "document.body.innerText.includes('Clips created')", False))
    check("no orphan projects", not [p for p in inv("list_projects", {"includeArchived": True}) if p["id"] not in proj0])
    check("no stray post drafts", not [p for p in inv("list_social_posts") if p["id"] not in posts0])
finally:
    if aid:
        inv("delete_asset", {"id": aid})
    shutil.rmtree(tmp, ignore_errors=True)

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
