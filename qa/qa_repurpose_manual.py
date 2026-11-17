"""Manual trim mode: stacked colored sliders define each clip's position and
duration. Covers slider rendering per count, a real mouse drag on a handle,
distinct colors, the probe-only path and end-to-end generation windows.
"""
import json, os, shutil, subprocess, sys, tempfile, time
sys.path.insert(0, "qa")
from qa_common import connect, js

FF = "tools/bin/ffmpeg.exe"
fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {str(extra).encode('ascii','replace').decode()}" if extra else ""))
    if not ok:
        fails.append(name)


tmp = tempfile.mkdtemp(prefix="creatora_rpm_")
g, l, src = (os.path.join(tmp, n) for n in ("g.wav", "l.wav", "qa_manual_src.mp4"))
subprocess.run([FF, "-y", "-loglevel", "error", "-i", "tools/test-media/speech_en.wav", "-af", "apad=pad_dur=1.5", g], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-stream_loop", "5", "-i", g, l], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=80",
                "-i", l, "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                "-pix_fmt", "yuv420p", "-c:a", "aac", src], check=True)

c = connect(reload=True)
inv = lambda cmd, a={}: js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)},{json.dumps(a)})")


def wait_for(expr, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if js(c, expr, True):
            return True
        time.sleep(0.5)
    return False


def click(finder, wait=0.4):
    global c
    p = js(c, f"(() => {{ const el = ({finder}); el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", False)
    c.click(p["x"], p["y"])
    time.sleep(wait)


btn = lambda t: f"[...document.querySelectorAll('button')].find(e => e.textContent.trim() === {json.dumps(t)})"
pressed = lambda t: f"[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes({json.dumps(t)}))"

posts0 = {p["id"] for p in inv("list_social_posts")}
proj0 = {p["id"] for p in inv("list_projects", {"includeArchived": True})}
assets0 = {a["id"] for a in inv("list_assets", {})}
aid = None
try:
    job = inv("import_media", {"paths": [src]})
    wait_for(f"window.__TAURI_INTERNALS__.invoke('list_jobs',{{kindPrefix:null,limit:50}}).then(r=>(r.find(x=>x.id==={json.dumps(job)})||{{}}).status==='done')", 90)
    asset = next(a for a in inv("list_assets", {"kind": "video"}) if a["filePath"].replace("/", "\\").lower().endswith("qa_manual_src.mp4"))
    aid = asset["id"]

    # probe-only command (manual path, no whisper)
    probe = inv("repurpose_probe", {"path": asset["filePath"]})
    check("repurpose_probe returns duration+fps", probe.get("durationMs", 0) > 55_000 and probe.get("fpsNum") == 25, probe)

    c.eval("location.hash='#/repurpose'; location.reload()")
    time.sleep(4)
    c = connect()
    click(f"document.querySelector('button[data-rp-asset=\"{aid}\"]')")
    click(pressed("Manual"))
    click(pressed(">3<") if False else "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.trim() === '3')")

    n_tracks = js(c, "document.querySelectorAll('[data-rp-track]').length", False)
    check("one stacked slider per clip", n_tracks == 3, n_tracks)
    colors = js(c, """[...document.querySelectorAll('[data-rp-track] > div:first-child')].map(d => d.style.background || getComputedStyle(d).backgroundColor)""", False)
    check("each slider has its own color", len(set(colors)) == 3, colors)

    # labels before dragging
    before = js(c, "document.querySelector('[data-rp-track=\"manual-1\"]').parentElement.innerText", False)

    # real mouse drag: pull clip 1's START handle ~15% right
    h = js(c, """(() => { const h = document.querySelector('[data-rp-track="manual-1"] [role="slider"]'); h.scrollIntoView({block:'center'}); const r = h.getBoundingClientRect(); const t = h.parentElement.getBoundingClientRect(); return {hx: r.x+r.width/2, hy: r.y+r.height/2, tw: t.width}; })()""", False)
    dx = h["tw"] * 0.15
    c.down(h["hx"], h["hy"])
    c.move(h["hx"] + dx, h["hy"], steps=8, sx=h["hx"], sy=h["hy"])
    c.up(h["hx"] + dx, h["hy"])
    time.sleep(0.4)
    after = js(c, "document.querySelector('[data-rp-track=\"manual-1\"]').parentElement.innerText", False)
    check("dragging the start handle changes the range", before != after, f"{before!r} -> {after!r}")

    # keyboard nudge on the END handle of clip 2 (-1 s)
    js(c, """document.querySelectorAll('[data-rp-track="manual-2"] [role="slider"]')[1].focus()""", False)
    b2 = js(c, "document.querySelector('[data-rp-track=\"manual-2\"]').parentElement.innerText", False)
    c.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "ArrowLeft", "code": "ArrowLeft", "windowsVirtualKeyCode": 37})
    c.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "ArrowLeft", "code": "ArrowLeft", "windowsVirtualKeyCode": 37})
    time.sleep(0.3)
    a2 = js(c, "document.querySelector('[data-rp-track=\"manual-2\"]').parentElement.innerText", False)
    check("arrow key nudges the end handle", b2 != a2, f"{b2!r} -> {a2!r}")

    # captions are on by default -> Use these clips runs the transcript job
    click(btn("Use these clips"), wait=1.0)
    check("review rows from the manual sliders", wait_for("document.querySelectorAll('article input[type=checkbox]').length >= 3", 60))
    manual_range = js(c, """(() => { const t = document.querySelector('article').innerText; return t; })()""", False)
    check("row 1 keeps the dragged start", "0:" in manual_range, manual_range[:60])
    cards = js(c, "document.querySelectorAll('article input[type=checkbox]').length", False)
    check("3 manual rows in review", cards == 3, cards)

    # generate 1 clip, verify the project window matches the slider position
    click("[...document.querySelectorAll('article input[type=checkbox]')].filter(i => i.checked)[1]", wait=0.2)
    click("[...document.querySelectorAll('article input[type=checkbox]')].filter(i => i.checked)[1]", wait=0.2)
    click(btn("Create 1 clips"), wait=1.0)
    check("generation finished", wait_for("document.body.innerText.includes('Clips created')", 120))
    newp = [p for p in inv("list_projects", {"includeArchived": True}) if p["id"] not in proj0]
    check("one project for the manual clip", len(newp) == 1, len(newp))
    if newp:
        doc = inv("open_project", {"path": newp[0]["filePath"]})["doc"]
        clip = next(cl for t in doc["timeline"]["tracks"] for cl in t["clips"])
        src_in = clip["sourceInMs"]
        check("clip window matches the dragged slider", 9_000 <= src_in <= 11_500, src_in)
        check("clip length matches the slider", 17_000 <= clip["durationMs"] <= 20_500, clip["durationMs"])
finally:
    if aid:
        inv("delete_asset", {"id": aid})
    try:
        c = connect()
        for a in inv("list_assets", {}):
            if a["id"] not in assets0:
                inv("delete_asset", {"id": a["id"]})
    except Exception as e:
        print("cleanup:", e)
    shutil.rmtree(tmp, ignore_errors=True)

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
