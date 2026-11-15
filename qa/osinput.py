"""OS-level input via Win32 SendInput — treated by WebView2 as real user
input (generates native HTML5 drag&drop, unlike CDP Input.dispatch*).

Coordinates: DOM viewport px -> screen px via the WebView2 client rect.
"""
import ctypes
import ctypes.wintypes as w
import time

u32 = ctypes.windll.user32

# ---- window geometry ----
def _enum_windows():
    out = []
    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def cb(hwnd, lp):
        if u32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            u32.GetWindowTextW(hwnd, buf, 256)
            if buf.value:
                out.append((hwnd, buf.value))
        return True
    u32.EnumWindows(cb, 0)
    return out


def find_window(title_substr="reatora"):
    for hwnd, t in _enum_windows():
        if title_substr.lower() in t.lower():
            return hwnd, t
    return None, None


def client_origin(hwnd):
    """Screen coords of the top-left of the client area."""
    pt = w.POINT(0, 0)
    u32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y


def client_size(hwnd):
    r = w.RECT()
    u32.GetClientRect(hwnd, ctypes.byref(r))
    return r.right - r.left, r.bottom - r.top


# ---- SendInput ----
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", w.LONG), ("dy", w.LONG),
                ("mouseData", w.DWORD), ("dwFlags", w.DWORD),
                ("time", w.DWORD), ("dwExtraInfo", ctypes.POINTER(w.ULONG))]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", w.WORD), ("wScan", w.WORD), ("dwFlags", w.DWORD),
                ("time", w.DWORD), ("dwExtraInfo", ctypes.POINTER(w.ULONG))]


class _INP_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", w.DWORD), ("u", _INP_UNION)]


_VW = u32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
_VH = u32.GetSystemMetrics(77)
_VWW = u32.GetSystemMetrics(78)
_VWH = u32.GetSystemMetrics(79)


def _abs_norm(sx, sy):
    nx = int((sx - _VW) * 65535 / (_VWW - 1))
    ny = int((sy - _VH) * 65535 / (_VWH - 1))
    return nx, ny


def _send(inp_list):
    arr = (INPUT * len(inp_list))(*inp_list)
    sent = u32.SendInput(len(inp_list), arr, ctypes.sizeof(INPUT))
    if sent != len(inp_list):
        raise ctypes.WinError()


def _mi(sx, sy, flags, data=0):
    nx, ny = _abs_norm(sx, sy)
    return INPUT(type=0, u=_INP_UNION(mi=MOUSEINPUT(
        nx, ny, data, flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        0, None)))


def move_abs(sx, sy):
    _send([_mi(sx, sy, MOUSEEVENTF_MOVE)])


def drag_abs(x0, y0, x1, y1, steps=24, settle=0.012):
    """Real OS drag: press at (x0,y0), move in steps, release at (x1,y1).
    Small initial moves first so drag detection registers."""
    move_abs(x0, y0)
    time.sleep(0.05)
    _send([_mi(x0, y0, MOUSEEVENTF_LEFTDOWN)])
    time.sleep(0.08)
    # a couple of micro-moves to trigger dragstart
    for f in (0.03, 0.06, 0.10):
        move_abs(int(x0 + (x1 - x0) * f), int(y0 + (y1 - y0) * f))
        time.sleep(settle)
    for i in range(1, steps + 1):
        f = i / steps
        move_abs(int(x0 + (x1 - x0) * f), int(y0 + (y1 - y0) * f))
        time.sleep(settle)
    time.sleep(0.06)
    _send([_mi(x1, y1, MOUSEEVENTF_LEFTUP)])
    time.sleep(0.08)


def click_abs(sx, sy, button="left"):
    move_abs(sx, sy)
    time.sleep(0.04)
    d, u = (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) if button == "left" \
        else (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    _send([_mi(sx, sy, d)])
    time.sleep(0.03)
    _send([_mi(sx, sy, u)])
    time.sleep(0.05)


def wheel_abs(sx, sy, delta, modifiers=()):
    """delta in wheel units (+/-120). modifiers: 'shift','ctrl' held."""
    move_abs(sx, sy)
    time.sleep(0.03)
    downs = []
    for m in modifiers:
        vk = {"shift": 0x10, "ctrl": 0x11, "alt": 0x12}[m]
        downs.append(INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(vk, 0, 0, 0, None))))
    ups = [INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(
        {"shift": 0x10, "ctrl": 0x11, "alt": 0x12}[m], 0, KEYEVENTF_KEYUP, 0, None)))
        for m in modifiers]
    _send(downs + [_mi(sx, sy, MOUSEEVENTF_WHEEL, delta & 0xFFFFFFFF)] + ups)
    time.sleep(0.05)


def key(vk, scan=None, modifiers=()):
    seq = []
    for m in modifiers:
        seq.append(INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(m, 0, 0, 0, None))))
    seq.append(INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(vk, 0, 0, 0, None))))
    seq.append(INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None))))
    for m in reversed(modifiers):
        seq.append(INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(m, 0, KEYEVENTF_KEYUP, 0, None))))
    _send(seq)
    time.sleep(0.04)


def type_text(s):
    for ch in s:
        inp = INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(
            0, ord(ch), 0x0004, 0, None)))  # KEYEVENTF_UNICODE
        up = INPUT(type=1, u=_INP_UNION(ki=KEYBDINPUT(
            0, ord(ch), 0x0004 | KEYEVENTF_KEYUP, 0, None)))
        _send([inp, up])
        time.sleep(0.01)


class OSMouse:
    """DOM-viewport-px -> screen-px mapper for the app window."""
    def __init__(self, hwnd, dpr=1.0):
        self.hwnd = hwnd
        self.dpr = dpr
        self.ox, self.oy = client_origin(hwnd)

    def refresh(self):
        self.ox, self.oy = client_origin(self.hwnd)

    def sx(self, x):
        return int(self.ox + x * self.dpr)

    def sy(self, y):
        return int(self.oy + y * self.dpr)

    def move(self, x, y): move_abs(self.sx(x), self.sy(y))
    def click(self, x, y, button="left"): click_abs(self.sx(x), self.sy(y), button)
    def drag(self, x0, y0, x1, y1, **kw):
        drag_abs(self.sx(x0), self.sy(y0), self.sx(x1), self.sy(y1), **kw)
    def wheel(self, x, y, delta, modifiers=()):
        wheel_abs(self.sx(x), self.sy(y), delta, modifiers)
