"""Live QA for Social S6: translated validator findings, post detail (preview,
Edit, i18n), publication history (localized times, Retry only on the newest
failed attempt, confirm dialog). Seeds attempt rows straight into SQLite
(there is no API to fabricate a failed upload) and removes everything after.
"""
import base64, json, os, sqlite3, sys, time
sys.path.insert(0, "qa")
from qa_common import connect, js

OUT = "qa/out"
PROJECT = "ec64a475-dadc-4473-9909-8da0f0018e67"
DB = os.path.join(os.environ["APPDATA"], "com.creatora.app", "creatora.db")
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


def click_xy(c, finder):
    p = js(c, f"""(() => {{ const el = ({finder}); if (!el) return null; el.scrollIntoView({{block:'center'}});
      const r = el.getBoundingClientRect(); return {{x: r.x + r.width/2, y: r.y + r.height/2}}; }})()""", False)
    assert p, finder
    c.click(p["x"], p["y"])
    time.sleep(0.6)


def tgt(platform):
    return {"platform": platform, "scheduledAt": None, "autoPublish": False, "platformMeta": {}}


c = connect(reload=True)
js(c, "window.__TAURI_INTERNALS__.invoke('set_setting', {key:'app.language', value:'es'})")
posts = []
try:
    p1 = inv(c, "save_social_post", {"id": None, "markReady": False, "input": {
        "projectId": PROJECT, "title": "T" * 130, "caption": "", "hashtags": [], "targets": [tgt("youtube"), tgt("tiktok")]}})
    posts.append(p1["id"])
    p2 = inv(c, "save_social_post", {"id": None, "markReady": False, "input": {
        "projectId": PROJECT, "title": "QA S6 historial", "caption": "", "hashtags": [], "targets": [tgt("youtube"), tgt("facebook")]}})
    posts.append(p2["id"])

    # ---- validator params from Rust ----
    v = inv(c, "validate_social_post", {"postId": p1["id"]})
    f = next(x for t in v["targets"] for x in t["findings"] if x["code"] == "title_too_long")
    check("finding carries params", f["params"].get("n") == 130 and f["params"].get("max") == 100, str(f["params"]))

    # ---- detail in Spanish ----
    c = reload(c, "#/social")
    click_xy(c, f"[...document.querySelectorAll('[role=button]')].find(e => e.textContent.includes('{'T' * 20}'))")
    txt = js(c, "document.querySelector('[role=dialog]')?.innerText || ''", False)
    check("detail: validator message translated", "El título tiene 130 caracteres — YouTube permite 100" in txt, txt[txt.find('El t'):][:90])
    check("detail: fix label translated", "Acorta el título" in txt)
    check("detail: no raw English chrome", all(s not in txt for s in ("Export for platform", "Publish now", "Link file")))
    check("detail: Spanish actions present", "Exportar para la plataforma" in txt and "Publicar ahora" in txt)
    check("detail: preview image rendered",
          js(c, "(() => { const i = document.querySelector('[role=dialog] img'); return !!i && i.naturalWidth > 0; })()", False))
    check("detail: Edit button present", "Editar" in txt)
    shot(c, "social_s6_detail_es")

    # Edit from detail -> composer.
    click_xy(c, "[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === 'Editar')")
    t2 = js(c, "document.querySelector('[role=dialog]')?.innerText || ''", False)
    check("Edit opens the composer", "Editar post" in t2, t2[:40])
    c.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    c.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    time.sleep(0.6)

    # ---- history: seed attempts ----
    t_by_platform = {t["platform"]: t["id"] for t in inv(c, "get_social_post", {"id": p2["id"]})["targets"]}
    fb, yt = t_by_platform["facebook"], t_by_platform["youtube"]
    con = sqlite3.connect(DB, timeout=10)
    rows = [
        ("qa6-a1", yt, "failed", 1, "2026-11-10 15:00:00", "boom 1"),
        ("qa6-a2", yt, "failed", 2, "2026-11-11 16:30:00", "boom 2"),
        ("qa6-b1", fb, "failed", 1, "2026-11-10 15:00:00", "old failure"),
        ("qa6-b2", fb, "published", 2, "2026-11-12 09:00:00", None),
    ]
    for rid, tid, st, no, started, err in rows:
        con.execute("INSERT INTO publication_attempts(id,target_id,status,attempt_no,started_at,finished_at,error,platform_post_id) VALUES(?,?,?,?,?,?,?,?)",
                    (rid, tid, st, no, started, started, err, "x" if st == "published" else None))
    con.commit()
    con.close()

    c = reload(c, "#/social?tab=history")
    btns = js(c, """[...document.querySelectorAll('tbody tr')].filter(r => r.textContent.includes('QA S6 historial')).map(r =>
      ({txt: r.textContent, retry: [...r.querySelectorAll('button')].some(b => b.textContent.trim() === 'Reintentar')}))""", False)
    check("history rows for the post seeded", len(btns) == 4, str(len(btns)))
    retry_rows = [b for b in btns if b["retry"]]
    check("exactly one Retry (newest failed attempt of the unresolved target)", len(retry_rows) == 1, str(len(retry_rows)))
    expect = js(c, "new Date('2026-11-11T16:30:00Z').toLocaleString('es')", False)
    check("history times localized (not raw SQL stamps)", expect in js(c, "document.body.innerText", False) and "2026-11-11 16:30:00" not in js(c, "document.body.innerText", False), expect)
    shot(c, "social_s6_history_es")

    click_xy(c, "[...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes('boom 2'))?.querySelectorAll('button')[1]")
    dlg = js(c, "document.querySelector('[role=alertdialog]')?.innerText || null", False)
    check("Retry asks for confirmation", dlg is not None and "Reintentar la publicación en YouTube" in dlg, str(dlg)[:80])
    click_xy(c, "[...document.querySelectorAll('[role=alertdialog] button')].find(e => e.textContent.trim() === 'Cancel' || e.textContent.trim() === 'Cancelar')")
    n_attempts = len(inv(c, "list_publication_attempts", {"targetId": yt}))
    check("cancelling the dialog starts no upload", n_attempts == 2, str(n_attempts))
finally:
    try:
        con = sqlite3.connect(DB, timeout=10)
        con.execute("DELETE FROM publication_attempts WHERE id LIKE 'qa6-%'")
        con.commit()
        con.close()
    except Exception as e:
        print("cleanup db:", e)
    for pid in posts:
        try:
            inv(c, "delete_social_post", {"id": pid})
        except Exception as e:
            print("cleanup:", e)
    try:
        js(c, "window.__TAURI_INTERNALS__.invoke('set_setting', {key:'app.language', value:'en'})")
    except Exception:
        pass

print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
