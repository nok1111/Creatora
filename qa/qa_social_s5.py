"""Live QA: card preview from the linked project, brand icons, and Social
calendar (S5) — locale week start, chip time+icon, drag highlight/reschedule,
click-a-day to create, list mode. Cleans up the post it creates.
"""
import base64, json, sys, time
sys.path.insert(0, "qa")
from qa_common import connect, js

OUT = "qa/out"
PROJECT = "ec64a475-dadc-4473-9909-8da0f0018e67"  # QA flow 1794793478466 (3 clips with thumbs)
fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        fails.append(name)


def inv(c, cmd, args=None):
    return js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)}, {json.dumps(args or {})})")


def shot(c, name):
    open(f"{OUT}/{name}.png", "wb").write(base64.b64decode(c.send("Page.captureScreenshot", {"format": "png"})["data"]))


def reload(c, hash_):
    c.eval(f"location.hash = '{hash_}'")
    time.sleep(0.3)
    c.eval("location.reload()")
    time.sleep(4)
    return connect()


def set_lang(c, lang):
    js(c, f"window.__TAURI_INTERNALS__.invoke('set_setting', {{key:'app.language', value:'{lang}'}})")


c = connect(reload=True)
set_lang(c, "en")
now = js(c, "(() => { const d = new Date(); return {y: d.getFullYear(), m: d.getMonth() + 1}; })()", False)
ym = f"{now['y']}-{now['m']:02d}"

post = inv(c, "save_social_post", {
    "id": None, "markReady": False,
    "input": {"projectId": PROJECT, "title": "QA S5 post", "caption": "", "hashtags": [], "targets": [
        {"platform": "youtube", "scheduledAt": f"{ym}-15T10:00", "autoPublish": False, "platformMeta": {}},
        {"platform": "tiktok", "scheduledAt": None, "autoPublish": False, "platformMeta": {}}]}})
pid = post["id"]
yt = next(t for t in post["targets"] if t["platform"] == "youtube")

try:
    # ---- preview + icons on the list ----
    previews = inv(c, "social_post_previews")
    check("preview resolved from project's first clip", pid in previews, str(previews.get(pid))[:90])
    c = reload(c, "#/social")
    card = "[...document.querySelectorAll('[role=button]')].find(e => e.textContent.includes('QA S5 post'))"
    info = js(c, f"""(() => {{ const img = ({card})?.querySelector('img');
      return img ? {{w: img.naturalWidth, h: img.naturalHeight, ok: img.complete}} : null; }})()""", False)
    check("card renders the video thumbnail (real pixels)", bool(info) and info["w"] > 0, str(info))
    chips = js(c, f"[...({card}).querySelectorAll('span.flex')].filter(s => s.querySelector('svg') && /YouTube|TikTok/.test(s.textContent)).length", False)
    check("platform chips carry brand icons", chips >= 2, str(chips))
    shot(c, "social_s5_list")

    # ---- calendar: week start by locale ----
    for lang, first in (("es", "lun"), ("en", "sun")):
        set_lang(c, lang)
        c = reload(c, "#/social?tab=calendar")
        hdr = js(c, "[...document.querySelectorAll('.grid-cols-7 > div')].slice(0,7).map(e => e.textContent.trim().toLowerCase())", False)
        check(f"{lang}: week starts on {first}", hdr and hdr[0].startswith(first), str(hdr))
    # English now: month view
    chip = js(c, """(() => { const b = [...document.querySelectorAll('[data-day] button')].find(e => e.textContent.includes('QA S5 post'));
      return b ? {t: b.textContent.trim(), svg: !!b.querySelector('svg'), drag: b.draggable} : null; })()""", False)
    check("chip shows time + icon + draggable", bool(chip) and "10:00" in chip["t"] and chip["svg"] and chip["drag"], str(chip))
    shot(c, "social_s5_month")

    # ---- drag: highlight + reschedule (synthetic DnD with a real DataTransfer) ----
    res = js(c, f"""(async () => {{
      const q = d => document.querySelector(`[data-day="${{d}}"]`);
      const chip = [...q('{ym}-15').querySelectorAll('button')].find(e => e.textContent.includes('QA S5 post'));
      const dt = new DataTransfer();
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, {{bubbles: true, cancelable: true, dataTransfer: dt}}));
      fire(chip, 'dragstart');
      const dest = q('{ym}-16');
      fire(dest, 'dragover');
      await new Promise(r => setTimeout(r, 80));
      const highlighted = dest.className.includes('bg-primary/15');
      fire(dest, 'drop');
      return highlighted;
    }})()""")
    check("drag-over highlights the destination day", res is True)
    time.sleep(1.0)
    moved = next(t for t in inv(c, "get_social_post", {"id": pid})["targets"] if t["id"] == yt["id"])
    check("drop reschedules, keeping time", moved["scheduledAt"] == f"{ym}-16T10:00", str(moved["scheduledAt"]))
    check("drop keeps status scheduled", moved["status"] == "scheduled", moved["status"])

    # ---- click an empty day -> composer pre-scheduled ----
    p = js(c, f"""(() => {{ const el = document.querySelector('[data-day="{ym}-20"]'); el.scrollIntoView({{block:'center'}});
      const r = el.getBoundingClientRect(); return {{x: r.x + r.width/2, y: r.y + r.height - 8}}; }})()""", False)
    c.click(p["x"], p["y"])
    time.sleep(0.8)
    check("click on a day opens composer", js(c, "!!document.querySelector('[role=dialog]')", False))
    yb = js(c, """(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === 'YouTube');
      const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()""", False)
    c.click(yb["x"], yb["y"])
    time.sleep(0.5)
    val = js(c, "document.querySelector('[role=dialog] input[type=datetime-local]')?.value", False)
    check("enabled platform pre-filled with the clicked day at 12:00", val == f"{ym}-20T12:00", str(val))
    shot(c, "social_s5_compose_from_day")
    c.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    c.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    time.sleep(0.5)

    # ---- list mode ----
    lb = js(c, """(() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'List');
      const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()""", False)
    c.click(lb["x"], lb["y"])
    time.sleep(0.8)
    label = js(c, "document.querySelector('span.min-w-44')?.textContent", False)
    check("list header shows a 3-month range", label and "–" in label, str(label))
    body = js(c, "document.body.innerText", False)
    check("list shows the scheduled item", "QA S5 post" in body)
    shot(c, "social_s5_list_mode")
finally:
    try:
        inv(c, "delete_social_post", {"id": pid})
    except Exception as e:
        print("cleanup:", e)
    try:
        set_lang(c, "en")
    except Exception:
        pass

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
