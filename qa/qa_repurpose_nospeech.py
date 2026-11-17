"""A transcript that is all non-verbal markup ([Music], (laughter)) must not
crash nor fake candidates: analyze reports noSpeech and the UI says so.
A mixed transcript (music + real sentences) still yields candidates built
only from speech — '[Music]' never leaks into a clip's text or captions.
Cache files are seeded with the same sha256 key as cache_key() so whisper
doesn't run.
"""
import hashlib, json, os, shutil, struct, subprocess, sys, tempfile, time
sys.path.insert(0, "qa")
from qa_common import connect, js

FF = "tools/bin/ffmpeg.exe"
MODEL = "ggml-base.bin"
CACHE = os.path.join(os.environ["APPDATA"], "com.creatora.app", "repurpose")
fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        fails.append(name)


def cache_key(path, model, lang):
    h = hashlib.sha256()
    h.update(path.encode())
    h.update(struct.pack("<Q", os.path.getsize(path)))
    h.update(struct.pack("<Q", int(os.path.getmtime(path))))
    h.update(model.encode())
    h.update(lang.encode())
    return h.hexdigest()[:24]


def seed(path, cues, model=MODEL, lang="auto"):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"{cache_key(path, model, lang)}.json")
    json.dump(cues, open(f, "w"))
    return f


def cue(i, s, e, text):
    return {"id": f"cue-{i}", "startMs": s, "endMs": e, "text": text,
            "styleId": None, "words": []}


tmp = tempfile.mkdtemp(prefix="creatora_rpn_")
a = os.path.join(tmp, "music_only.mp4")
b = os.path.join(tmp, "mixed.mp4")
for out, dur in ((a, 50), (b, 70)):
    subprocess.run([FF, "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", f"testsrc2=size=640x360:rate=25:duration={dur}",
                    "-i", "tools/test-media/speech_en.wav", "-shortest",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", out], check=True)

seed(a, [cue(i, i * 10_000, i * 10_000 + 9_000, "[Music]") for i in range(1, 6)])
seed(b, [cue(1, 0, 9_000, "[Music]"), cue(2, 10_000, 18_000, "(crowd cheering)")] +
        [cue(3 + k, 20_000 + k * 12_000, 20_000 + k * 12_000 + 9_000, t)
         for k, t in enumerate([
             "This is the first real sentence about the topic.",
             "And here is a second sentence that continues it nicely.",
             "Finally the third sentence wraps the moment up.",
             "One more sentence to close the whole segment.",
         ])])

c = connect(reload=True)
inv = lambda cmd, o={}: js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)},{json.dumps(o)})")


def analyze(path):
    jid = inv("repurpose_analyze", {"opts": {
        "path": path, "model": MODEL, "language": "auto",
        "minMs": 15_000, "idealMs": 22_000, "maxMs": 30_000, "count": 3}})
    return js(c, f"window.__qa.jobs.awaitJob({json.dumps(jid)})")


ra, rb = analyze(a), analyze(b)
check("music-only analysis finished", ra and ra["status"] == "done", ra and ra.get("status"))
res_a = ra["result"] if ra else {}
check("music-only reports noSpeech", res_a.get("noSpeech") is True)
check("music-only yields no candidates", res_a.get("candidates") == [])
check("music-only used the seeded cache", res_a.get("cached") is True)

check("mixed analysis finished", rb and rb["status"] == "done", rb and rb.get("status"))
res_b = rb["result"] if rb else {}
cands_b = res_b.get("candidates", [])
check("mixed still yields candidates", len(cands_b) >= 1, len(cands_b))
check("mixed: no [Music] leaks into a candidate", all("[Music]" not in x["text"] and "(crowd" not in x["text"] for x in cands_b),
      [x["text"][:60] for x in cands_b])
check("mixed: candidate spans the spoken run",
      any(15_000 <= x["endMs"] - x["startMs"] <= 30_000 and x["startMs"] >= 15_000 for x in cands_b),
      [(x["startMs"], x["endMs"]) for x in cands_b])

# UI: the empty state tells the truth for the music-only video.
aid = None
try:
    job = inv("import_media", {"paths": [a]})
    for _ in range(60):
        st = js(c, f"window.__TAURI_INTERNALS__.invoke('list_jobs',{{kindPrefix:null,limit:50}}).then(r=>(r.find(x=>x.id==={json.dumps(job)})||{{}}).status)")
        if st == "done":
            break
        time.sleep(1)
    asset = next(x for x in inv("list_assets", {"kind": "video"}) if x["filePath"].replace("/", "\\").lower().endswith("music_only.mp4"))
    aid = asset["id"]
    c.eval("location.hash='#/repurpose'; location.reload()")
    time.sleep(4)
    c = connect()
    sel = f"button[data-rp-asset=\"{aid}\"]"
    p = js(c, f"(() => {{ const el = document.querySelector('{sel}'); el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", False)
    c.click(p["x"], p["y"])
    time.sleep(0.5)
    p = js(c, """(() => { const el = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Find the best clips'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()""", False)
    c.click(p["x"], p["y"])
    for _ in range(60):
        if js(c, "document.body.innerText.includes('suggested clips') && !document.body.innerText.includes('Analyzing')", False):
            break
        time.sleep(0.5)
    check("UI says no speech was detected", js(c, "document.body.innerText.includes('No speech was detected')", False))
    check("UI does not blame the language", not js(c, "document.body.innerText.includes('check the spoken language')", False))
finally:
    if aid:
        inv("delete_asset", {"id": aid})
    shutil.rmtree(tmp, ignore_errors=True)

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
