"""Manual trim across source formats and stacked/non-stacked slider ranges.

Three sources (16:9@25, 9:16@60, 1:1@30). For each: manual sliders are dragged
with a real mouse into overlapping (stacked) and separated positions, then
generated projects are checked against the slider's aria-valuenow ms values.
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


tmp = tempfile.mkdtemp(prefix="creatora_rpmm_")
g = os.path.join(tmp, "g.wav"); l = os.path.join(tmp, "l.wav")
subprocess.run([FF, "-y", "-loglevel", "error", "-i", "tools/test-media/speech_en.wav", "-af", "apad=pad_dur=1.5", g], check=True)
subprocess.run([FF, "-y", "-loglevel", "error", "-stream_loop", "8", "-i", g, l], check=True)

SPECS = [
    # name, size, fps, dur, count, targets toggled OFF (leave 1..2 on)
    ("qa_mm_16x9_25.mp4", "1280x720", 25, 75, 3, []),
    ("qa_mm_9x16_60.mp4", "720x1280", 60, 120, 3, []),
    ("qa_mm_1x1_30.mp4", "960x960", 30, 55, 3, []),
]
paths = []
for name, size, fps, dur, count, _ in SPECS:
    p = os.path.join(tmp, name)
    subprocess.run([FF, "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"testsrc2=size={size}:rate={fps}:duration={dur}",
                    "-i", l, "-shortest", "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", p], check=True)
    paths.append(p)

c = connect(reload=True)
inv = lambda cmd, a={}: js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)},{json.dumps(a)})")


def wait_for(expr, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if js(c, expr, True):
            return True
        time.sleep(0.5)
    return False


def click(finder, wait=0.4):
    global c
    p = js(c, f"(() => {{ const el = ({finder}); if(!el) return null; el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", False)
    if p is None:
        return False
    c.click(p["x"], p["y"])
    time.sleep(wait)
    return True


def drag(finder, dx):
    """Real mouse drag of a handle/body found by `finder`."""
    p = js(c, f"""(() => {{ const el = ({finder}); el.scrollIntoView({{block:'center'}});
      const r = el.getBoundingClientRect(); const t = el.closest('[data-rp-track]').getBoundingClientRect();
      return {{x: r.x + r.width/2, y: r.y + r.height/2, tw: t.width}}; }})()""", False)
    c.down(p["x"], p["y"])
    c.move(p["x"] + p["tw"] * dx, p["y"], steps=10, sx=p["x"], sy=p["y"])
    c.up(p["x"] + p["tw"] * dx, p["y"])
    time.sleep(0.3)


btn = lambda t: f"[...document.querySelectorAll('button')].find(e => e.textContent.trim() === {json.dumps(t)})"
track = lambda i: f"document.querySelectorAll('[data-rp-track]')[{i}]"
seg = lambda i: f"{track(i)}.querySelector('div')"
handles = lambda i: f"{track(i)}.querySelectorAll('[role=slider]')"

assets0 = {a["id"] for a in inv("list_assets", {})}
proj0 = {p["id"] for p in inv("list_projects", {"includeArchived": True})}
posts0 = {p["id"] for p in inv("list_social_posts")}
new_assets = []
try:
    for idx, (name, size, fps, dur, count, _off) in enumerate(SPECS):
        print(f"\n== {name} ({size}@{fps}, {dur}s, {count} sliders)")
        job = inv("import_media", {"paths": [paths[idx]]})
        wait_for(f"window.__TAURI_INTERNALS__.invoke('list_jobs',{{kindPrefix:null,limit:50}}).then(r=>(r.find(x=>x.id==={json.dumps(job)})||{{}}).status==='done')", 90)
        asset = next(a for a in inv("list_assets", {"kind": "video"}) if a["filePath"].replace("/", "\\").lower().endswith(name.lower()))
        new_assets.append(asset["id"])
        aid = asset["id"]

        c.eval("location.hash='#/repurpose'; location.reload()")
        time.sleep(4)
        c = connect()
        click(f"document.querySelector('button[data-rp-asset=\"{aid}\"]')")
        for _ in range(4):
            click("[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Manual'))")
            if js(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Manual'))?.getAttribute('aria-pressed') === 'true'", False):
                break
        check(f"{name}: manual mode on", js(c, "document.querySelector('[data-rp-manual]') !== null", False))
        for _ in range(4):
            click(f"[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.trim() === '{count}')")
            if js(c, f"[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.trim() === '{count}')?.getAttribute('aria-pressed') === 'true'", False):
                break
        if idx == 1:
            click("[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Short'))")
            time.sleep(0.6)
        check(f"{name}: {count} sliders", wait_for(f"document.querySelectorAll('[data-rp-track]').length === {count}", 10))

        def ranges_now():
            return js(c, """[...document.querySelectorAll('[data-rp-track]')].map(t => {
              const h = t.querySelectorAll('[role=slider]');
              return [Number(h[0].getAttribute('aria-valuenow')), Number(h[1].getAttribute('aria-valuenow'))];
            })""", False)

        if idx == 0:
            # STACKED: drag clip1's body right so it overlaps clip2's window.
            drag(f"{seg(0)}", 0.30)
            # and stretch clip2's end to swallow the rest
            drag(f"{handles(1)}[1]", 0.20)
        elif idx == 1:
            # NON-STACKED: shorten each clip first so they can actually fit
            # apart, then spread them across the video.
            for k in range(3):
                drag(f"{handles(k)}[1]", -0.18)   # end handle left -> ~16 s clips
            drag(f"{seg(0)}", -0.30)
            drag(f"{seg(2)}", 0.30)
        # idx == 2: keep the seeded (evenly spread) ranges as-is.

        rs = ranges_now()
        if idx == 0:
            overlap = rs[0][1] > rs[1][0]
            check("stacked ranges overlap", overlap, rs)
        elif idx == 1:
            sep = all(rs[k][1] < rs[k+1][0] for k in range(len(rs)-1)) if rs == sorted(rs) else all(
                not (a[0] < b[1] and b[0] < a[1]) for i,a in enumerate(rs) for b in rs[i+1:])
            check("ranges are separated", sep, rs)

        click(btn("Use these clips"), wait=1.0)
        check(f"{name}: review rows", wait_for(f"document.querySelectorAll('article input[type=checkbox]').length === {count}", 90))

        # keep the default target set; create all clips
        click(btn(f"Create {count} clips"), wait=1.0)
        check(f"{name}: generation finished", wait_for("document.body.innerText.includes('Clips created')", 120))
        body = js(c, "document.body.innerText", False)
        check(f"{name}: all clips succeeded", "Clips created" in body and "failed" not in body.split("Clips created")[-1].lower().split("Export all")[0])

        newp = [p for p in inv("list_projects", {"includeArchived": True}) if p["id"] not in proj0]
        check(f"{name}: {count} projects created", len(newp) == count, len(newp))
        got = []
        for p in newp[-count:]:
            doc = inv("open_project", {"path": p["filePath"]})["doc"]
            clip = next(cl for t in doc["timeline"]["tracks"] for cl in t["clips"])
            got.append((clip["sourceInMs"], clip["durationMs"], doc["canvas"]["fpsNum"], doc["canvas"]["fpsDen"]))
        exp_fps = {"qa_mm_16x9_25.mp4": 25, "qa_mm_9x16_60.mp4": 60, "qa_mm_1x1_30.mp4": 30}[name]
        check(f"{name}: projects keep {exp_fps} fps", all(g[2] == exp_fps for g in got), [g[2] for g in got])
        # match each generated clip to a slider range within 300 ms
        matched = []
        for g_s, g_d, _n, _d in got:
            hit = next((r for r in rs if abs(r[0] - g_s) <= 300 and abs((r[1] - r[0]) - g_d) <= 300), None)
            matched.append(hit)
        check(f"{name}: every project matches a slider range", all(matched), f"got={[(g[0],g[1]) for g in got]} want={rs}")
        proj0 = {p["id"] for p in inv("list_projects", {"includeArchived": True})}
finally:
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
