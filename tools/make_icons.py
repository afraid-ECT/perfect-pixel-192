"""生成扩展图标：深色圆角底 + 3x3 像素格（一格高亮）。"""
from PIL import Image, ImageDraw

ACCENT = (110, 231, 183, 255)
ACCENT2 = (125, 211, 252, 255)
DIM = (43, 58, 76, 255)
BG = (11, 14, 19, 255)


def make(size: int) -> Image.Image:
    s = 8  # 超采样倍数
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = round(n * 0.06)
    radius = round(n * 0.22)
    d.rounded_rectangle([pad, pad, n - pad, n - pad], radius=radius, fill=BG,
                        outline=(51, 59, 77, 255), width=max(1, round(n * 0.012)))

    inner = n - 2 * pad
    gap = max(1, round(inner * 0.055))
    cell = (inner - 2 * gap - 2 * round(inner * 0.10)) / 3
    start = pad + round(inner * 0.10)

    hot = (0, 1), (1, 1), (2, 0)
    for y in range(3):
        for x in range(3):
            x0 = start + x * (cell + gap)
            y0 = start + y * (cell + gap)
            box = [round(x0), round(y0), round(x0 + cell), round(y0 + cell)]
            r = max(1, round(cell * 0.18))
            if (x, y) == (1, 1):
                d.rounded_rectangle(box, radius=r, fill=ACCENT)
            elif (x, y) == (2, 0):
                d.rounded_rectangle(box, radius=r, fill=ACCENT2)
            else:
                d.rounded_rectangle(box, radius=r, fill=DIM)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "icons")
    os.makedirs(out, exist_ok=True)
    for sz in (16, 32, 48, 128):
        make(sz).save(os.path.join(out, f"icon{sz}.png"))
        print("wrote", f"icons/icon{sz}.png")
