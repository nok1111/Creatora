"""Live QA for Social S2 (composer): toggle keeps config, per-platform counters,
Mark-ready blocked by content errors, wired fix buttons, close after fixing.

Requires the app running with CDP on :9222. Cleans up the post it creates.
"""
import base64, json, sys, time
sys.path.insert(0, "qa")
from qa_common import connect, js

OUT = "qa/out"
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
    return js(c, f"""(() => {{ const el = ({finder}); if (!el) return null;
      el.scrollIntoView({{block: 'center'}}); const r = el.getBoundingClientRect();
      return {{x: r.x + r.width/2, y: r.y + r.height/2}}; }})()""", False)


def click(c, finder):
    p = pos(c, finder)
    assert p, f"not found: {finder}"
    c.click(p["x"], p["y"])
    time.sleep(0.4)


def setval(c, sel, v):
    js(c, f"""(() => {{ const el = document.querySelector({json.dumps(sel)});
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {json.dumps(v)});
      el.dispatchEvent(new Event('input', {{bubbles: true}})); }})()""", False)
    time.sleep(0.2)


BTN = lambda txt: f"[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === {json.dumps(txt)})"
TXT = lambda: js(c, "document.querySelector('[role=dialog]')?.innerText || ''", False)

c = connect(reload=True)
js(c, "window.__TAURI_INTERNALS__.invoke('set_setting', {key:'app.language', value:'en'})")
c.eval("location.hash = '#/social'; location.reload()")
time.sleep(4)
c = connect()
before = {p["id"] for p in inv(c, "list_social_posts", {})}

click(c, "[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'New post')")
check("composer opens", js(c, "!!document.querySelector('[role=dialog]')", False))

click(c, BTN("YouTube"))
check("platform card appears with title/caption/hashtags overrides",
      all(s in TXT() for s in ("Title override", "Caption override", "Hashtags override")))
check("per-platform counters from ruleset (YouTube title /100)", "/100" in TXT(), "")

# Toggle must preserve config.
ta = "[...document.querySelectorAll('[role=dialog] label')].find(l => l.textContent.includes('Caption override'))?.querySelector('textarea')"
js(c, f"({ta}).setAttribute('data-qa','cap-override')", False)
setval(c, "[data-qa=cap-override]", "yt only caption")
click(c, BTN("YouTube"))  # off
check("card removed when off", "Caption override" not in TXT())
click(c, BTN("YouTube"))  # on
kept = js(c, f"({ta})?.value", False)
check("toggle off/on keeps caption override", kept == "yt only caption", str(kept))

# Mark ready with a too-long shared title -> blocked, stays open.
setval(c, "#social-title", "x" * 130)
click(c, BTN("Mark ready"))
time.sleep(1.5)
check("Mark ready blocked: dialog stays open", js(c, "!!document.querySelector('[role=dialog]')", False))
t = TXT()
check("validation panel shown with title error", "Pre-flight" in t and "caps at 100" in t, "")
shot(c, "social_s2_blocked")

# Fix button focuses the title field.
click(c, "[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.includes('Shorten the title'))")
active = js(c, "document.activeElement?.id", False)
check("fix button focuses #social-title", active == "social-title", str(active))

# Correct and mark ready -> closes.
setval(c, "#social-title", "QA S2 composer")
click(c, BTN("Mark ready"))
time.sleep(1.5)
check("dialog closes after fixing", not js(c, "!!document.querySelector('[role=dialog]')", False))
new = [p for p in inv(c, "list_social_posts", {}) if p["id"] not in before and p["title"] == "QA S2 composer"]
check("exactly one post created", len(new) == 1, str(len(new)))
if new:
    p = new[0]
    tg = p["targets"][0]
    check("target ready + override persisted, hashtags inherit",
          tg["status"] == "ready" and tg["caption"] == "yt only caption" and tg["hashtags"] is None,
          f'{tg["status"]} / {tg["caption"]} / {tg["hashtags"]}')
    shot(c, "social_s2_after")
    inv(c, "delete_social_post", {"id": p["id"]})

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
