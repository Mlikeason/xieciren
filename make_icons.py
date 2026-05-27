"""Render the 写词人 logo to multiple PNG sizes for apple-touch-icon use.
Black plate, white serif text, gold dot — matches the in-app .brand element.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "icons"
OUT.mkdir(exist_ok=True)
SIZES = [180, 192, 512]
TEXT = "写词人"
BG = (26, 26, 26)
FG = (255, 255, 255)
GOLD = (184, 151, 95)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
]


def get_font(px: int):
    for fp in FONT_CANDIDATES:
        try:
            # Songti.ttc has multiple faces; index 4 = SongtiSC-Bold typically
            f = ImageFont.truetype(fp, px, index=4)
            f.getlength(TEXT)
            return f
        except Exception:
            try:
                return ImageFont.truetype(fp, px)
            except Exception:
                continue
    raise RuntimeError("no usable Chinese font")


def render(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)

    # iterate font size down until text + gap + dot fit comfortably (~64% of icon)
    target_w = int(size * 0.64)
    px = int(size * 0.22)
    while px > 8:
        font = get_font(px)
        bbox = d.textbbox((0, 0), TEXT, font=font)
        tw = bbox[2] - bbox[0]
        gap = max(int(size * 0.04), 4)
        dot = max(int(size * 0.045), 5)
        total_w = tw + gap + dot
        if total_w <= target_w:
            break
        px -= 4
    th = bbox[3] - bbox[1]

    x = (size - total_w) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]

    d.text((x, y), TEXT, fill=FG, font=font)

    dx = x + bbox[0] + tw + gap
    dy = (size - dot) // 2
    d.ellipse((dx, dy, dx + dot, dy + dot), fill=GOLD)
    return img


def main() -> None:
    for s in SIZES:
        img = render(s)
        path = OUT / f"icon-{s}.png"
        img.save(path, optimize=True)
        print(f"  {path.name}  {path.stat().st_size/1024:.1f} KB")


if __name__ == "__main__":
    main()
