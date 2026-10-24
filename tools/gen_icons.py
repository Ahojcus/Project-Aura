"""Generates Tauri icon assets: 32x32.png, 128x128.png, 128x128@2x.png and icon.ico.

Pure stdlib (zlib/struct) — no Pillow required. Run from project root:
    python tools/gen_icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

# Palette
BG_TOP = (18, 22, 38)
BG_BOTTOM = (10, 12, 24)
ACCENT_A = (99, 102, 241)   # indigo
ACCENT_B = (217, 70, 239)   # fuchsia
RING = (255, 255, 255)


def rounded_alpha(size):
    """Alpha mask for a rounded square with radius ~22% of size."""
    rad = size * 0.22
    mask = []
    for y in range(size):
        row = []
        for x in range(size):
            # corner distance
            cx = min(x, size - 1 - x)
            cy = min(y, size - 1 - y)
            if cx >= rad or cy >= rad:
                a = 255
            else:
                dx = rad - cx
                dy = rad - cy
                d = (dx * dx + dy * dy) ** 0.5 - rad
                a = 255 if d >= 0 else max(0, min(255, int(255 * (1 + d))))
            row.append(a)
        mask.append(row)
    return mask


def px(size):
    """Pixel buffer RGBA rows for the icon at given size."""
    mask = rounded_alpha(size)
    rows = []
    mid = size / 2
    ring_r = size * 0.34
    ring_w = max(2.0, size * 0.075)
    dot_r = size * 0.055
    dot_x, dot_y = size * 0.86, size * 0.147
    for y in range(size):
        row = bytearray()
        for x in range(size):
            t = (x + y) / (2 * size)
            r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
            g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
            b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
            # gradient arc (quarter ring)
            dx, dy = x - mid, y - mid
            dist = (dx * dx + dy * dy) ** 0.5
            ang = dy / (dist + 1e-9) if dist else 0.0
            grad = (1 - ang) if dist else 0.0
            if ring_r - ring_w / 2 <= dist <= ring_r + ring_w / 2:
                k = max(0.0, min(1.0, (dist - (ring_r - ring_w / 2)) / ring_w))
                aa = max(0.0, min(1.0, 1 - k))
                r = int(r * (1 - aa) + (ACCENT_A[0] * (1 - grad) + ACCENT_B[0] * grad) * aa)
                g = int(g * (1 - aa) + (ACCENT_A[1] * (1 - grad) + ACCENT_B[1] * grad) * aa)
                b = int(b * (1 - aa) + (ACCENT_A[2] * (1 - grad) + ACCENT_B[2] * grad) * aa)
            r = max(0, min(255, r)); g = max(0, min(255, g)); b = max(0, min(255, b))
            # center dot
            dd = ((x - mid) ** 2 + (y - mid) ** 2) ** 0.5
            if dd <= dot_r:
                r, g, b = RING
            # top-right small dot
            d2 = ((x - dot_x) ** 2 + (y - dot_y) ** 2) ** 0.5
            if d2 <= dot_r * 1.6:
                r, g, b = RING
            a = mask[y][x]
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    return rows


def png_bytes(size):
    raw = b"".join(b"\x00" + row for row in px(size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(sizes=(16, 32, 48, 64, 128, 256)):
    images = []
    for s in sizes:
        pixels = px(s)
        # BMP bottom-up BGRX rows
        bmp_body = bytearray()
        for row in reversed(pixels):
            i = 0
            while i < len(row):
                r, g, b, a = row[i], row[i + 1], row[i + 2], row[i + 3]
                bmp_body += bytes((b, g, r, a))
                i += 4
        stride = ((s + 31) // 32) * 4
        bmp_body += b"\x00" * (stride * s)  # AND mask (transparent handled by alpha)
        header = struct.pack(
            "<IiiHHIIiiII", 40, s, s * 2, 1, 32, 0, len(bmp_body), 0, 0, 0, 0
        )
        images.append((s, header + bytes(bmp_body)))

    total = len(images)
    out = struct.pack("<HHH", 0, 1, total)
    offset = 6 + 16 * total
    entries = b""
    for s, data in images:
        entries += struct.pack(
            "<BBBBHHII",
            s % 256,
            s % 256,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        offset += len(data)
    return out + entries + b"".join(d for _, d in images)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size in (
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
    ):
        path = os.path.join(OUT, name)
        with open(path, "wb") as f:
            f.write(png_bytes(size))
        print("wrote", os.path.normpath(path))
    path = os.path.join(OUT, "icon.ico")
    with open(path, "wb") as f:
        f.write(ico_bytes())
    print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
