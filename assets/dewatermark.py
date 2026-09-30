#!/usr/bin/env python3
"""Remove a fixed-position watermark/logo by OpenCV inpainting (free, local, no API key).

Good for corner/edge watermarks (e.g. the pollinations.ai corner logo). Not for
watermarks smeared across complex central content -- that needs AI inpainting.

Examples:
  # auto bottom-right corner (default), tuned for a small corner logo
  python dewatermark.py in.jpg out.png

  # explicit corner + size as a fraction of the image
  python dewatermark.py in.jpg out.png --corner br --fw 0.30 --fh 0.07

  # exact pixel box (x y w h)
  python dewatermark.py in.jpg out.png --box 360 470 150 40

  # process a whole folder in place-ish (writes next to each input)
  python dewatermark.py ./imgs ./clean --corner br
"""
import argparse
import os
import sys

import cv2
import numpy as np


def resolve_box(w, h, args):
    """Return (x, y, bw, bh) for the region to inpaint, clamped to the image."""
    if args.box:
        x, y, bw, bh = args.box
    else:
        bw = int(args.fw * w)
        bh = int(args.fh * h)
        corner = args.corner
        if corner == "br":
            x, y = w - bw, h - bh
        elif corner == "bl":
            x, y = 0, h - bh
        elif corner == "tr":
            x, y = w - bw, 0
        else:  # tl
            x, y = 0, 0
    pad = args.pad
    x, y = max(0, x - pad), max(0, y - pad)
    bw = min(w - x, bw + 2 * pad)
    bh = min(h - y, bh + 2 * pad)
    return x, y, bw, bh


def process(path, out_path, args):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        print(f"skip (unreadable): {path}", file=sys.stderr)
        return False
    h, w = img.shape[:2]
    x, y, bw, bh = resolve_box(w, h, args)
    mask = np.zeros((h, w), np.uint8)
    mask[y:y + bh, x:x + bw] = 255
    method = cv2.INPAINT_TELEA if args.method == "telea" else cv2.INPAINT_NS
    result = cv2.inpaint(img, mask, args.radius, method)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    if not cv2.imwrite(out_path, result):
        print(f"failed to write: {out_path}", file=sys.stderr)
        return False
    print(f"ok: {out_path}  (box {x},{y} {bw}x{bh})")
    return True


def main():
    a = argparse.ArgumentParser(description="Free local watermark inpaint remover.")
    a.add_argument("input", help="image file or folder")
    a.add_argument("output", nargs="?", help="output file or folder (default: <input>.dewatermarked.png)")
    a.add_argument("--box", type=int, nargs=4, metavar=("X", "Y", "W", "H"),
                   help="exact pixel region to remove")
    a.add_argument("--corner", choices=["br", "bl", "tr", "tl"], default="br",
                   help="which corner when --box is not given (default br)")
    a.add_argument("--fw", type=float, default=0.30, help="corner width as image fraction (default 0.30)")
    a.add_argument("--fh", type=float, default=0.07, help="corner height as image fraction (default 0.07)")
    a.add_argument("--pad", type=int, default=8, help="px to grow the box on each side (default 8)")
    a.add_argument("--radius", type=float, default=4.0, help="inpaint neighborhood radius (default 4)")
    a.add_argument("--method", choices=["telea", "ns"], default="telea", help="inpaint algorithm")
    args = a.parse_args()

    exts = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
    if os.path.isdir(args.input):
        files = [f for f in sorted(os.listdir(args.input)) if f.lower().endswith(exts)]
        out_dir = args.output or args.input
        if not files:
            sys.exit("no images found in input folder")
        n = sum(process(os.path.join(args.input, f),
                        os.path.join(out_dir, f), args) for f in files)
        print(f"{n}/{len(files)} processed")
    else:
        out = args.output
        if not out:
            base, _ = os.path.splitext(args.input)
            out = base + ".dewatermarked.png"
        if not process(args.input, out, args):
            sys.exit(1)


if __name__ == "__main__":
    main()
