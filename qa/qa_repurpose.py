"""Live QA for Repurpose: real whisper + real FFmpeg + real project/social creation.

Builds a ~2.5 min 16:9 source from tools/test-media/speech_en.wav (looped, with
1.5 s gaps) over a moving test pattern, imports it, runs the whole wizard with
real mouse input, then inspects the generated projects and post drafts.
Cleans up everything it creates.
"""
import base64, json, os, subprocess, sys, tempfile, time
sys.path.insert(0, "qa")
from qa_common import connect, js

OUT = "qa/out"
FFMPEG = "tools/bin/ffmpeg.exe"
FFPROBE = "tools/bin/ffprobe.exe"
SPEECH = "tools/test-media/speech_en.wav"
fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        fails.append(name)


def inv(c, cmd, args=None):
    return js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)}, {json.dumps(args or {})})")


def shot(c, name):
    open(f"{OUT}/{name}.png", "wb").write(base64.b64decode(c.send("Page.captureScreenshot", {"format": "png"})["data"]))


def pos(c, finder):
    return js(c, f"""(() => {{ const el = ({finder}); if (!el) return null; el.scrollIntoView({{block:'center'}});
      const r = el.getBoundingClientRect(); return {{x: r.x + r.width/2, y: r.y + r.height/2}}; }})()""", False)


def click(c, finder, wait=0.5):
    p = pos(c, finder)
    assert p, f"not found: {finder}"
    c.click(p["x"], p["y"])
    time.sleep(wait)


def btn(text):
    return f"[...document.querySelectorAll('button')].find(e => e.textContent.trim() === {json.dumps(text)})"


def wait_for(c, expr, timeout=240, step=1.5):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if js(c, expr, True):
            return True
        time.sleep(step)
    return False


tmp = tempfile.mkdtemp(prefix="creatora_rp_")
SRC = os.path.join(tmp, "qa_repurpose_src.mp4")
# 12 × (speech + 1.5 s gap) over a moving test pattern.
GAPPED = os.path.join(tmp, "speech_gapped.wav")
subprocess.run(
    [FFMPEG, "-y", "-loglevel", "error", "-i", SPEECH, "-af", "apad=pad_dur=1.5", GAPPED], check=True)
LOOPED = os.path.join(tmp, "speech_loop.wav")
subprocess.run(
    [FFMPEG, "-y", "-loglevel", "error", "-stream_loop", "11", "-i", GAPPED, LOOPED], check=True)
subprocess.run(
    [FFMPEG, "-y", "-loglevel", "error",
     "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", LOOPED,
     "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", SRC],
    check=True,
)

c = connect(reload=True)
js(c, "window.__TAURI_INTERNALS__.invoke('set_setting', {key:'app.language', value:'en'})")
assets_before = {a["id"] for a in inv(c, "list_assets", {})}
posts_before = {p["id"] for p in inv(c, "list_social_posts", {})}
projects_before = {p["id"] for p in inv(c, "list_projects", {"includeArchived": True})}
asset_id = None
try:
    # ---- import the source through the real import job ----
    job = inv(c, "import_media", {"paths": [SRC]})
    assert wait_for(c, f"window.__TAURI_INTERNALS__.invoke('list_jobs', {{kindPrefix: null, limit: 50}}).then(r => (r.find(x => x.id === {json.dumps(job)}) || {{}}).status === 'done')", 60)
    assets = inv(c, "list_assets", {"kind": "video"})
    asset = next(a for a in assets if a["filePath"].replace("/", "\\").endswith("qa_repurpose_src.mp4"))
    asset_id = asset["id"]
    check("source imported", asset["durationMs"] and asset["durationMs"] > 120_000, str(asset["durationMs"]))

    c.eval("location.hash = '#/repurpose'; location.reload()")
    time.sleep(4)
    c = connect()

    # ---- nav ----
    nav_ok = js(c, "[...document.querySelectorAll('header nav a')].some(a => a.textContent.trim() === 'Repurpose' && a.className.includes('bg-primary'))", False)
    check("top menu has an active 'Repurpose' entry", nav_ok)

    # ---- configure ----
    sel = f"button[data-rp-asset=\"{asset_id}\"]"
    check("library tile is rendered", wait_for(c, f"!!document.querySelector('{sel}')", 20))
    click(c, f"document.querySelector('{sel}')")
    check("tile click selects the video",
          wait_for(c, f"document.querySelector('{sel}')?.getAttribute('aria-pressed') === 'true'", 10))
    # drag a library tile onto the drop zone (internal DnD path)
    dropped = js(c, f"""(() => {{
      const tile = document.querySelector('{sel}');
      const zone = document.querySelector('[aria-label="Drop a video file here"]');
      if (!tile || !zone) return "missing";
      const dt = new DataTransfer();
      tile.dispatchEvent(new DragEvent('dragstart', {{bubbles: true, dataTransfer: dt}}));
      zone.dispatchEvent(new DragEvent('dragover', {{bubbles: true, dataTransfer: dt}}));
      zone.dispatchEvent(new DragEvent('drop', {{bubbles: true, dataTransfer: dt}}));
      tile.dispatchEvent(new DragEvent('dragend', {{bubbles: true, dataTransfer: dt}}));
      return "ok";
    }})()""", False)
    check("library tile drag+drop onto the zone keeps the selection",
          dropped == "ok" and js(c, f"document.querySelector('{sel}')?.getAttribute('aria-pressed') === 'true'", False))
    time.sleep(0.4)
    click(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Short'))")
    click(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.trim() === '3')")
    shot(c, "repurpose_setup")
    click(c, btn("Find the best clips"), wait=1.0)
    check("analysis shows progress", js(c, "document.body.innerText.includes('Analyzing')", False))

    ok = wait_for(c, "document.body.innerText.includes('suggested clips') && !document.body.innerText.includes('Analyzing…')", 240)
    check("analysis finished with ranked clips", ok)
    n = js(c, "document.querySelectorAll('article').length", False)
    check("clip cards rendered", n >= 1, str(n))
    shot(c, "repurpose_review")
    cards = js(c, """[...document.querySelectorAll('article')].map(a => ({
        video: !!a.querySelector('video'), chips: a.querySelectorAll('span.rounded.border').length,
        title: a.querySelector('input[type=text], input:not([type])')?.value, checked: a.querySelector('input[type=checkbox]').checked,
        text: a.innerText.slice(0, 160)}))""", False)
    check("every card has preview, reasons and a title", all(x["video"] and x["chips"] >= 1 and x["title"] for x in cards), str(cards[:1]))

    # ---- trim: +1 s on End of the first card ----
    before = js(c, "document.querySelector('article').innerText.match(/(\\d+) s/)?.[1]", False)
    click(c, "document.querySelector('article button[aria-label=\"End +1s\"]')")
    time.sleep(0.4)
    after = js(c, "document.querySelector('article').innerText.match(/(\\d+) s/)?.[1]", False)
    check("End +1s lengthens the clip by a second", before and after and int(after) == int(before) + 1, f"{before}->{after}")

    # ---- generate (keep 2 selected when possible) ----
    if n >= 2:
        click(c, f"document.querySelectorAll('article input[type=checkbox]')[{n - 1}]")
    sel = js(c, "[...document.querySelectorAll('article input[type=checkbox]')].filter(i => i.checked).length", False)
    check("Create button counts the selection", js(c, f"!!({btn(f'Create {sel} clips')})", False), str(sel))
    click(c, btn(f"Create {sel} clips"), wait=1.0)
    done = wait_for(c, "document.body.innerText.includes('Clips created')", 240)
    check("generation finished", done)
    shot(c, "repurpose_done")
    body = js(c, "document.body.innerText", False)
    check("all clips succeeded", "failed" not in body.split("Clips created")[-1].lower().split("open social")[0], "")

    # ---- inspect what was really created ----
    new_posts = [p for p in inv(c, "list_social_posts", {}) if p["id"] not in posts_before]
    new_projects = [p for p in inv(c, "list_projects", {"includeArchived": True}) if p["id"] not in projects_before]
    check("one project and one post draft per clip", len(new_projects) == sel and len(new_posts) == sel, f"{len(new_projects)}/{len(new_posts)} sel={sel}")
    if new_projects:
        pr = new_projects[0]
        doc = inv(c, "open_project", {"path": pr["filePath"]})["doc"]
        clip = doc["timeline"]["tracks"][0]["clips"][0]
        check("master canvas is 9:16", doc["canvas"]["width"] == 1080 and doc["canvas"]["height"] == 1920, str(doc["canvas"]))
        check("clip points at the source window", clip["mediaRef"] == asset_id and clip["sourceInMs"] >= 0, str((clip["sourceInMs"], clip["durationMs"])))
        check("clip is 15–32 s", 15_000 <= clip["durationMs"] <= 32_000, str(clip["durationMs"]))
        check("2 extra format versions (Reels, Shorts)", [v["presetId"] for v in doc["versions"]] == ["ig-reels-9x16-1080", "shorts-9x16-1080"], str([v["presetId"] for v in doc["versions"]]))
        check("captions re-timed inside the clip", len(doc["subtitles"]) >= 1 and all(0 <= s["startMs"] < clip["durationMs"] + 50 for s in doc["subtitles"]), str(len(doc["subtitles"])))
        check("subject-following keyframes baked", "transform.x" in clip["keyframes"], str(list(clip["keyframes"])))
        check("pop caption style applied", doc["subtitleStyle"]["mode"] == "pop", doc["subtitleStyle"]["mode"])
    if new_posts:
        p = new_posts[0]
        plats = sorted(t["platform"] + ("*" if t["versionId"] else "") for t in p["targets"])
        check("post draft targets TikTok + Instagram + YouTube", sorted({t["platform"] for t in p["targets"]}) == ["instagram", "tiktok", "youtube"], str(plats))
        check("post linked to the new project and captioned", p["projectId"] in {x["id"] for x in new_projects} and len(p["caption"]) > 0 and p["status"] == "draft", p["status"])

    # ---- export every target of the first post: distinct files, real specs ----
    if new_posts:
        outdir = os.path.join(tmp, "exports")
        os.makedirs(outdir)
        for tg in new_posts[0]["targets"]:
            job = inv(c, "export_for_target", {"targetId": tg["id"], "outDir": outdir})
            wait_for(c, f"window.__TAURI_INTERNALS__.invoke('list_jobs', {{kindPrefix: null, limit: 50}}).then(r => ['done','failed'].includes((r.find(x => x.id === {json.dumps(job)}) || {{}}).status))", 240)
        folders = os.listdir(outdir)
        files = sorted(os.listdir(os.path.join(outdir, folders[0]))) if len(folders) == 1 else []
        check("3 targets -> 3 distinct files in one post folder", len(files) == 3, str(files))
        check("master + versioned names", "tiktok.mp4" in files and any(f.startswith("instagram_") for f in files) and any(f.startswith("youtube_") for f in files), str(files))
        for f in files:
            info = json.loads(subprocess.run([FFPROBE, "-v", "error", "-show_streams", "-of", "json", os.path.join(outdir, folders[0], f)], capture_output=True, text=True).stdout)
            v = next(x for x in info["streams"] if x["codec_type"] == "video")
            check(f"{f}: 1080x1920 h264", (v["width"], v["height"], v["codec_name"]) == (1080, 1920, "h264"), f'{v["width"]}x{v["height"]}')

finally:
    try:
        c = connect()
        for p in inv(c, "list_social_posts", {}):
            if p["id"] not in posts_before:
                inv(c, "delete_social_post", {"id": p["id"]})
        for p in inv(c, "list_projects", {"includeArchived": True}):
            if p["id"] not in projects_before:
                inv(c, "delete_project", {"id": p["id"], "deleteFile": True})
        if asset_id:
            inv(c, "delete_asset", {"id": asset_id})
    except Exception as e:
        print("cleanup:", e)
    import shutil
    try:
        c = connect()
        for a in inv(c, "list_assets", {}):
            if a["id"] not in assets_before:
                inv(c, "delete_asset", {"id": a["id"]})
    except Exception as e:
        print("cleanup assets:", e)
    shutil.rmtree(tmp, ignore_errors=True)

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
