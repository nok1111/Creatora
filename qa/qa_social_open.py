"""Live QA: "open publication in browser" from every Social entry point.

`api.openExternalUrl` is intercepted in the page (so no real browser opens during
QA) and each entry point must call it with the published URL. The Rust-side
scheme validation is exercised for real with invalid URLs. Seeds one
published target in SQLite; removes it afterwards.
"""
import base64, json, os, sqlite3, sys, time
sys.path.insert(0, "qa")
from qa_common import connect, js

OUT = "qa/out"
DB = os.path.join(os.environ["APPDATA"], "com.creatora.app", "creatora.db")
URL = "https://www.youtube.com/watch?v=qa-open-1"
fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        fails.append(name)


def inv(c, cmd, args=None):
    return js(c, f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)}, {json.dumps(args or {})})")


def shot(c, name):
    open(f"{OUT}/{name}.png", "wb").write(base64.b64decode(c.send("Page.captureScreenshot", {"format": "png"})["data"]))


def click_xy(c, finder):
    p = js(c, f"""(() => {{ const el = ({finder}); if (!el) return null; el.scrollIntoView({{block:'center'}});
      const r = el.getBoundingClientRect(); return {{x: r.x + r.width/2, y: r.y + r.height/2}}; }})()""", False)
    assert p, finder
    c.click(p["x"], p["y"])
    time.sleep(0.6)


def opened(c):
    return js(c, "window.__QA_OPENED.splice(0)", False)


c = connect(reload=True)
js(c, "window.__TAURI_INTERNALS__.invoke('set_setting', {key:'app.language', value:'en'})")
pid = None
try:
    post = inv(c, "save_social_post", {"id": None, "markReady": False, "input": {
        "title": "QA open publication", "caption": "", "hashtags": [],
        "targets": [{"platform": "youtube", "scheduledAt": None, "autoPublish": False, "platformMeta": {}}]}})
    pid = post["id"]
    tid = post["targets"][0]["id"]
    con = sqlite3.connect(DB, timeout=10)
    con.execute("UPDATE social_post_targets SET status='published', platform_post_id='qa-open-1', platform_url=? WHERE id=?", (URL, tid))
    con.execute("INSERT INTO publication_attempts(id,target_id,status,attempt_no,platform_post_id,platform_url,finished_at) VALUES('qaopen-1',?,'published',1,'qa-open-1',?,datetime('now'))", (tid, URL))
    con.commit()
    con.close()

    # Real backend validation: non-http(s) must be rejected.
    for bad in ("file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "C:\\Windows\\notepad.exe"):
        try:
            inv(c, "open_external_url", {"url": bad})
            check(f"rejects {bad[:24]}", False)
        except Exception as e:
            check(f"rejects {bad[:24]}", "http(s)" in str(e), str(e)[:80])

    c.eval("location.reload()")
    time.sleep(4)
    c = connect()
    # `invoke` is read-only, so spy on the api object the UI calls through.
    js(c, "(() => { window.__QA_OPENED = []; window.__qa.api.openExternalUrl = (u) => { window.__QA_OPENED.push(u); return Promise.resolve(); }; })()", False)

    CARD = "[...document.querySelectorAll('[role=button]')].find(e => e.textContent.includes('QA open publication'))"

    # 1) chip icon on the post card
    click_xy(c, f"({CARD}).querySelector('button[aria-label=\"Open in browser\"]')")
    got = opened(c)
    check("card chip icon opens the publication", got == [URL], str(got))
    check("chip click does not open the post dialog", not js(c, "!!document.querySelector('[role=dialog]')", False))

    # 2) ⋯ menu entry
    click_xy(c, f"({CARD}).querySelector('button[aria-haspopup=menu]')")
    items = js(c, "[...document.querySelectorAll('[role=menuitem]')].map(e => e.textContent.trim())", False)
    check("menu lists 'Open on YouTube' first", items and items[0] == "Open on YouTube", str(items))
    shot(c, "social_open_menu")
    click_xy(c, "[...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.includes('Open on YouTube'))")
    got = opened(c)
    check("menu entry opens the publication", got == [URL], str(got))

    # 3) post detail
    click_xy(c, f"({CARD})")
    click_xy(c, "[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === 'Open in browser')")
    got = opened(c)
    check("detail button opens the publication", got == [URL], str(got))
    shot(c, "social_open_detail")
    c.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    c.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    time.sleep(0.6)

    # 4) history row (SPA tab switch keeps the interceptor)
    click_xy(c, "[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'History')")
    time.sleep(0.8)
    click_xy(c, "[...document.querySelectorAll('tbody button')].find(e => e.textContent.includes('qa-open-1'))")
    got = opened(c)
    check("history link opens the publication", got == [URL], str(got))
finally:
    try:
        con = sqlite3.connect(DB, timeout=10)
        con.execute("DELETE FROM publication_attempts WHERE id='qaopen-1'")
        con.commit()
        con.close()
    except Exception as e:
        print("cleanup db:", e)
    if pid:
        try:
            c = connect()
            inv(c, "delete_social_post", {"id": pid})
        except Exception as e:
            print("cleanup:", e)

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
