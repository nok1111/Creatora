"""Regenerate src-tauri/icons from the Creatora mark.

Draws the same geometry as src/assets/brand/creatora-mark.svg at 2048px
(4x supersample) and emits every size Tauri references. Run:
    python qa/gen_icons.py
"""
import math
import os
from PIL import Image, ImageDraw

ICONS = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
S = 4  # supersample factor
VB = 512


def px(v):
    return v * S


def render(size_px=2048):
    """Render the mark at `size_px` (assumed 512 * scale)."""
    sc = size_px / VB
    img = Image.new("RGBA", (size_px, size_px), (0, 0, 0, 0))

    # diagonal gradient tile  #FF8A70 -> #F0522F
    c0 = (0xFF, 0x8A, 0x70)
    c1 = (0xF0, 0x52, 0x2F)
    grad = Image.new("RGBA", (size_px, size_px))
    px_ = grad.load()
    diag = size_px * 2
    for y in range(size_px):
        for x in range(0, size_px, 4):
            t = (x + y) / diag
            col = tuple(round(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (255,)
            for dx in range(4):
                if x + dx < size_px:
                    px_[x + dx, y] = col
    mask = Image.new("L", (size_px, size_px), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size_px - 1, size_px - 1], radius=112 * sc, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    dark = (36, 31, 26, 255)      # #241F1A
    cream = (244, 240, 232, 255)  # #F4F0E8

    # "C" arc: center (250,256), r=140, stroke 66, gap +-46 deg around 3 o'clock
    cx, cy, r, w = 250 * sc, 256 * sc, 140 * sc, 66 * sc
    box = [cx - r, cy - r, cx + r, cy + r]
    d.arc(box, start=46, end=314, fill=dark, width=round(w))

    # play triangle (310,214)-(310,298)-(392,256), stroke join ~14
    tri = [(310 * sc, 214 * sc), (310 * sc, 298 * sc), (392 * sc, 256 * sc)]
    jr = 7 * sc
    d.line([tri[0], tri[1]], fill=cream, width=round(jr * 2))
    d.line([tri[1], tri[2]], fill=cream, width=round(jr * 2))
    d.line([tri[2], tri[0]], fill=cream, width=round(jr * 2))
    d.polygon(tri, fill=cream)
    for p in tri:
        d.ellipse([p[0] - jr, p[1] - jr, p[0] + jr, p[1] + jr], fill=cream)
    return img


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(ICONS, name))


def main():
    master = render(2048)
    save(master, "icon.png", 1024)
    save(master, "32x32.png", 32)
    save(master, "128x128.png", 128)
    save(master, "128x128@2x.png", 256)
    for n in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save(master, f"Square{n}x{n}Logo.png", n)
    save(master, "StoreLogo.png", 50)
    # Windows .ico — PIL resamples `sizes` internally from the source
    master.resize((256, 256), Image.LANCZOS).save(
        os.path.join(ICONS, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote", os.listdir(ICONS))


if __name__ == "__main__":
    main()
