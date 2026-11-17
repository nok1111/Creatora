"""Live QA for Repurpose edge cases (real whisper / FFmpeg / FFprobe):

1. video without audio  -> clear error, wizard stays usable
2. portrait 25 fps source -> project keeps 25 fps, 9:16 -> 9:16 needs no zoom
3. real transcription progress (monotonic, not stuck at the start)
4. cancel mid-transcription -> job ends fast and whisper-cli is really killed
5. export of the generated targets -> per-post folder, distinct file names,
   correct resolution/duration/audio verified with ffprobe

The native folder picker cannot be driven over CDP, so step 5 calls the same
`export_for_target` command the "Export all" button uses.
"""
import base64, json, os, shutil, subprocess, sys, tempfile, time
sys.path.insert(0, "qa")
from qa_common import connect, js

OUT = "qa/out"
FFMPEG, FFPROBE = "tools/bin/ffmpeg.exe", "tools/bin/ffprobe.exe"
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


def wait_for(c, expr, timeout=240, step=1.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if js(c, expr, True):
            return True
        time.sleep(step)
    return False


def ff(*args):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], check=True)


def probe(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def whisper_running():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq whisper-cli.exe"], capture_output=True, text=True).stdout
    return "whisper-cli.exe" in out


tmp = tempfile.mkdtemp(prefix="creatora_rpe_")
gapped = os.path.join(tmp, "g.wav")
ff("-i", SPEECH, "-af", "apad=pad_dur=1.5", gapped)
loop = os.path.join(tmp, "l.wav")
ff("-stream_loop", "11", "-i", gapped, loop)
V = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p"]
SRC_SILENT = os.path.join(tmp, "qa_rpe_silent.mp4")
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=20", *V, "-an", SRC_SILENT)
SRC_PORTRAIT = os.path.join(tmp, "qa_rpe_portrait.mp4")
ff("-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=25", "-i", loop, "-shortest", *V, "-c:a", "aac", SRC_PORTRAIT)

c = connect(reload=True)
js(c, "window.__TAURI_INTERNALS__.invoke('set_setting', {key:'app.language', value:'en'})")
assets_before = {a["id"] for a in inv(c, "list_assets", {})}
posts_before = {p["id"] for p in inv(c, "list_social_posts", {})}
projects_before = {p["id"] for p in inv(c, "list_projects", {"includeArchived": True})}
assets = []
export_dir = os.path.join(tmp, "exports")
os.makedirs(export_dir)


def import_asset(path):
    job = inv(c, "import_media", {"paths": [path]})
    assert wait_for(c, f"window.__TAURI_INTERNALS__.invoke('list_jobs', {{kindPrefix: null, limit: 50}}).then(r => (r.find(x => x.id === {json.dumps(job)}) || {{}}).status === 'done')", 90)
    a = next(a for a in inv(c, "list_assets", {"kind": "video"}) if a["filePath"].replace("/", "\\").lower().endswith(os.path.basename(path).lower()))
    assets.append(a["id"])
    return a


def open_wizard():
    global c
    c.eval("location.hash = '#/repurpose'; location.reload()")
    time.sleep(4)
    c = connect()


def pick(asset_id):
    click(c, f"document.querySelector('button[data-rp-asset=\"{asset_id}\"]')")
    time.sleep(0.4)


try:
    # ---------- 1. no audio ----------
    silent = import_asset(SRC_SILENT)
    open_wizard()
    pick(silent["id"])
    click(c, btn("Find the best clips"), wait=1.5)
    toast = wait_for(c, "[...document.querySelectorAll('[data-sonner-toast]')].some(t => t.innerText.includes('no audio track'))", 10)
    check("no-audio video: clear error toast", toast)
    check("no-audio video: wizard stays usable", js(c, f"!({btn('Find the best clips')}).disabled", False))
    check("no-audio video: no cards created", js(c, "document.querySelectorAll('article').length", False) == 0)
    shot(c, "repurpose_edge_noaudio")

    # ---------- 2 + 3 + 4. portrait 25 fps ----------
    port = import_asset(SRC_PORTRAIT)
    open_wizard()
    pick(port["id"])
    click(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Short'))")
    click(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.trim() === '3')")

    # 4. cancel first: start, wait until whisper is really running, cancel.
    click(c, btn("Find the best clips"), wait=0.5)
    t0 = time.time()
    up = False
    while time.time() - t0 < 30:
        if whisper_running():
            up = True
            break
        time.sleep(0.3)
    check("whisper-cli is running during analysis", up)
    t_cancel = time.time()
    click(c, btn("Cancel"), wait=0.2)
    dead = False
    while time.time() - t_cancel < 8:
        if not whisper_running():
            dead = True
            break
        time.sleep(0.25)
    check("cancel kills whisper-cli quickly", dead, f"{time.time() - t_cancel:.1f}s")
    check("cancel returns the wizard to a usable state",
          wait_for(c, f"!!({btn('Find the best clips')}) && !({btn('Find the best clips')}).disabled", 10))
    check("cancel leaves no results behind", js(c, "document.querySelectorAll('article').length", False) == 0)

    # 3. real run with progress sampling
    click(c, btn("Find the best clips"), wait=0.8)
    widths = []
    labels = set()
    t0 = time.time()
    while time.time() - t0 < 240:
        done = js(c, "document.body.innerText.includes('suggested clips') && !document.body.innerText.includes('Analyzing…')", False)
        w = js(c, "(() => { const b = document.querySelector('.h-1\\\\.5 > .bg-primary'); return b ? parseInt(b.style.width) : null; })()", False)
        lab = js(c, "document.querySelector('.h-1\\\\.5')?.parentElement?.querySelector('p')?.textContent || ''", False)
        if w is not None:
            widths.append(w)
        if lab:
            labels.add(lab)
        if done:
            break
        time.sleep(0.7)
    check("analysis finished", done)
    check("progress is monotonic", all(b >= a for a, b in zip(widths, widths[1:])), str(widths[:30]))
    check("progress moved past the first step (real whisper %)", len({w for w in widths}) >= 4 and max(widths or [0]) >= 60, str(sorted(set(widths))))
    check("stage labels are translated", "Transcribing" in labels, str(labels))
    shot(c, "repurpose_edge_review")

    # 2. generate: single target (TikTok) keeps source aspect
    click(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Reels'))")   # off
    click(c, "[...document.querySelectorAll('button[aria-pressed]')].find(e => e.textContent.includes('Shorts'))")  # off
    sel = js(c, "[...document.querySelectorAll('article input[type=checkbox]')].filter(i => i.checked).length", False)
    click(c, btn(f"Create {sel} clips"), wait=1.0)
    check("generation finished", wait_for(c, "document.body.innerText.includes('Clips created')", 240))
    new_projects = [p for p in inv(c, "list_projects", {"includeArchived": True}) if p["id"] not in projects_before]
    doc = inv(c, "open_project", {"path": new_projects[0]["filePath"]})["doc"]
    clip = doc["timeline"]["tracks"][0]["clips"][0]
    check("project keeps the 25 fps of the source", (doc["canvas"]["fpsNum"], doc["canvas"]["fpsDen"]) == (25, 1), str(doc["canvas"]))
    check("9:16 source -> 9:16 master needs no zoom", abs(clip["transform"]["scaleX"] - 1.0) < 0.02, str(clip["transform"]["scaleX"]))
    check("no versions for a single target", doc["versions"] == [])

    # ---------- 5. export real files ----------
    new_posts = [p for p in inv(c, "list_social_posts", {}) if p["id"] not in posts_before]
    tgt = new_posts[0]["targets"][0]
    job = inv(c, "export_for_target", {"targetId": tgt["id"], "outDir": export_dir})
    ok = wait_for(c, f"window.__TAURI_INTERNALS__.invoke('list_jobs', {{kindPrefix: null, limit: 50}}).then(r => ['done','failed'].includes((r.find(x => x.id === {json.dumps(job)}) || {{}}).status))", 240)
    folders = [d for d in os.listdir(export_dir) if os.path.isdir(os.path.join(export_dir, d))]
    check("export wrote into a per-post subfolder", ok and len(folders) == 1 and folders[0].rsplit("-", 1)[-1] == new_posts[0]["id"].replace("-", "")[:6], str(folders))
    if folders:
        files = os.listdir(os.path.join(export_dir, folders[0]))
        check("file is named after the platform", files == ["tiktok.mp4"], str(files))
        info = probe(os.path.join(export_dir, folders[0], files[0]))
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        a = [s for s in info["streams"] if s["codec_type"] == "audio"]
        check("export is 1080x1920 H.264 with audio", (v["width"], v["height"]) == (1080, 1920) and v["codec_name"] == "h264" and len(a) == 1, f'{v["width"]}x{v["height"]} {v["codec_name"]}')
        want = clip["durationMs"] / 1000
        got = float(info["format"]["duration"])
        check("exported duration matches the clip", abs(got - want) < 0.6, f"{got:.2f}s vs {want:.2f}s")
        check("25 fps preserved in the export", v["r_frame_rate"] == "25/1", v["r_frame_rate"])
finally:
    try:
        c = connect()
        for p in inv(c, "list_social_posts", {}):
            if p["id"] not in posts_before:
                inv(c, "delete_social_post", {"id": p["id"]})
        for p in inv(c, "list_projects", {"includeArchived": True}):
            if p["id"] not in projects_before:
                inv(c, "delete_project", {"id": p["id"], "deleteFile": True})
        for aid in assets:
            inv(c, "delete_asset", {"id": aid})
    except Exception as e:
        print("cleanup:", e)
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
