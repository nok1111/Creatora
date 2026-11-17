"""Live QA for Social S1 (transactional save), S3 (post list) and S4 (accounts).

Requires `npm run tauri dev` running with CDP on :9222. Uses the real
commands + real mouse input; cleans up the posts it creates.
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


def target(platform, sched=None):
    return {"platform": platform, "accountId": None, "versionId": None, "title": None,
            "caption": None, "hashtags": None, "platformMeta": {}, "scheduledAt": sched, "autoPublish": False}


def save(c, pid, targets, ready=False):
    return inv(c, "save_social_post", {
        "id": pid, "markReady": ready,
        "input": {"title": "QA S3 post", "caption": "c", "hashtags": [], "targets": targets}})


c = connect(reload=True)
c.eval("location.hash = '#/social'")
time.sleep(1.5)

# ---- S1: transactional save over the real backend ----
try:
    post = save(c, None, [target("youtube"), target("tiktok"), target("youtube")])
except Exception as e:
    check("save_social_post command exists (rebuild tauri dev?)", False, str(e)[:200])
    sys.exit(1)
pid = post["id"]
check("S1 duplicate platform inputs collapse", len(post["targets"]) == 2, str([t["platform"] for t in post["targets"]]))
again = save(c, pid, [target("youtube")], ready=True)
check("S1 removed platform pruned", [t["platform"] for t in again["targets"]] == ["youtube"])
check("S1 markReady promotes draft", again["targets"][0]["status"] == "ready", again["targets"][0]["status"])
again = save(c, pid, [target("youtube")])
check("S1 plain edit keeps ready", again["targets"][0]["status"] == "ready", again["targets"][0]["status"])

CARD = "[...document.querySelectorAll('[role=button]')].find(e => e.textContent.includes('QA S3 post'))"

# ---- S3: list card, menu, confirm delete ----
c.eval("location.reload()")
time.sleep(3.5)
c = connect()
c.eval("location.hash = '#/social'")
time.sleep(1.5)
check("S3 card rendered", js(c, f"!!({CARD})", False))
check("S3 thumbnail slot present", js(c, f"!!({CARD})?.querySelector('.aspect-video')", False))

pos = js(c, f"""(() => {{ const b = ({CARD}).querySelector('button[aria-haspopup=menu]');
  const r = b.getBoundingClientRect(); return {{x: r.x + r.width/2, y: r.y + r.height/2}}; }})()""", False)
c.click(pos["x"], pos["y"])
time.sleep(0.6)
items = js(c, """[...document.querySelectorAll('[role=menuitem]')].map(e => {
  const r = e.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height/2;
  const top = document.elementFromPoint(x, y);
  return {t: e.textContent.trim(), x, y, hit: top === e || e.contains(top)}; })""", False)
check("S3 menu opens with Duplicate+Delete reachable", len(items) == 2 and all(i["hit"] for i in items), str(items))
check("S3 opening menu does not open the post", not js(c, "!!document.querySelector('[role=dialog]')", False))
shot(c, "social_s3_menu")

c.click(items[1]["x"], items[1]["y"])
time.sleep(0.6)
dlg = js(c, "document.querySelector('[role=alertdialog]')?.textContent || null", False)
check("S3 delete asks for confirmation", dlg is not None and "QA S3 post" in dlg, str(dlg)[:140])
check("S3 post not deleted before confirming", inv(c, "get_social_post", {"id": pid})["id"] == pid)
shot(c, "social_s3_confirm")

cancel = js(c, """(() => { const b = [...document.querySelectorAll('[role=alertdialog] button')].find(e => /cancel/i.test(e.textContent));
  const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()""", False)
c.click(cancel["x"], cancel["y"])
time.sleep(0.5)
check("S3 cancel keeps post", inv(c, "get_social_post", {"id": pid})["id"] == pid)

# Confirm path: reopen menu, delete, confirm.
c.click(pos["x"], pos["y"])
time.sleep(0.5)
items = js(c, """[...document.querySelectorAll('[role=menuitem]')].map(e => {
  const r = e.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })""", False)
c.click(items[1]["x"], items[1]["y"])
time.sleep(0.5)
ok_btn = js(c, """(() => { const bs = [...document.querySelectorAll('[role=alertdialog] button')];
  const b = bs[bs.length - 1]; const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()""", False)
c.click(ok_btn["x"], ok_btn["y"])
time.sleep(1.2)
gone = False
try:
    inv(c, "get_social_post", {"id": pid})
except Exception:
    gone = True
check("S3 confirm deletes post", gone)
check("S3 card disappears from list", not js(c, f"!!({CARD})", False))

# ---- S4: accounts tab ----
c.eval("location.hash = '#/social?tab=accounts'")
time.sleep(0.5)
c.eval("location.reload()")
time.sleep(3.5)
c = connect()
txt = js(c, "document.body.innerText", False)
check("S4 accounts tab renders connect buttons", "Connect YouTube" in txt or "Conectar YouTube" in txt)
shot(c, "social_s4_accounts")

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
