"""Minimal CDP driver for Creatora WebView2 QA (port 9222)."""
import json, base64, time, urllib.request
import websocket


class CDP:
    def __init__(self, port=9222, url_substr="localhost:1420"):
        targets = json.load(urllib.request.urlopen(f"http://localhost:{port}/json"))
        page = next(t for t in targets if t["type"] == "page" and url_substr in t["url"])
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], max_size=200 * 1024 * 1024,
                                              suppress_origin=True)
        self.ws.settimeout(60)
        self.mid = 0
        for dom in ("Page", "Runtime", "DOM"):
            self.send(dom + ".enable")

    def send(self, method, params=None):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True,
            "awaitPromise": await_promise, "userGesture": True})
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:800])
        return r.get("result", {}).get("value")

    # ---- real input ----
    def click(self, x, y, button="left", count=1):
        for _ in range(count):
            self.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": button, "clickCount": count})
            self.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": button, "clickCount": count})

    def rclick(self, x, y):
        self.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "right", "clickCount": 1})
        self.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "right", "clickCount": 1})

    def move(self, x, y, steps=1, sx=None, sy=None):
        if steps > 1 and sx is not None:
            for i in range(1, steps + 1):
                self.send("Input.dispatchMouseEvent", {"type": "mouseMoved",
                          "x": sx + (x - sx) * i / steps, "y": sy + (y - sy) * i / steps})
                time.sleep(0.01)
        else:
            self.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})

    def down(self, x, y, button="left"):
        self.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": button, "clickCount": 1})

    def up(self, x, y, button="left"):
        self.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": button, "clickCount": 1})

    def wheel(self, x, y, dy, dx=0, modifiers=0):
        self.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y,
                  "deltaX": dx, "deltaY": dy, "modifiers": modifiers})

    def key(self, key, code, vk, modifiers=0, text=None):
        p = {"type": "keyDown", "key": key, "code": code, "windowsVirtualKeyCode": vk, "modifiers": modifiers}
        if text:
            p["text"] = text
        self.send("Input.dispatchKeyEvent", p)
        self.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": code,
                  "windowsVirtualKeyCode": vk, "modifiers": modifiers})

    def esc(self):
        self.key("Escape", "Escape", 27)

    # ---- helpers ----
    def rect(self, selector):
        return self.eval(f"""(() => {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {{x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2}};
        }})()""")

    def rects(self, selector):
        return self.eval(f"""(() => {{
            return [...document.querySelectorAll({json.dumps(selector)})].map(el => {{
                const r = el.getBoundingClientRect();
                return {{x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2,
                         text: (el.textContent||'').trim().slice(0,60), cls: (el.className||'').toString().slice(0,80)}};
            }});
        }})()""")

    def hit(self, x, y):
        return self.eval(f"""(() => {{
            const el = document.elementFromPoint({x}, {y});
            if (!el) return null;
            return {{tag: el.tagName, cls: (el.className||'').toString().slice(0,100),
                    text: (el.textContent||'').trim().slice(0,60)}};
        }})()""")

    def shot(self, name):
        data = self.send("Page.captureScreenshot", {"format": "png"})["data"]
        path = f"qa/shots/{name}.png"
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return path

    def viewport(self, w, h):
        self.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        time.sleep(0.4)

    def clear_viewport(self):
        self.send("Emulation.clearDeviceMetricsOverride")


def connect():
    return CDP()
