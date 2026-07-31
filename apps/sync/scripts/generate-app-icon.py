#!/usr/bin/env python3
"""Put the HQ app icon on Apple's macOS icon grid.

    python3 scripts/generate-app-icon.py
    pnpm tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons

Input   src-tauri/icons/source/app-icon-master.png  (1024x1024, full-bleed art)
Output  src-tauri/icons/app-icon.png                (1024x1024, on the grid)

## Why this exists

macOS does NOT mask or inset app icons. Whatever a bundle ships is drawn into
the Dock tile verbatim, so the rounded-rect shape and the margin around it have
to be baked into the artwork.

HQ shipped a full-bleed 1024x1024 square with fully opaque corners. Next to the
inset squircles every other Mac app ships, it read as a hard-edged square that
looked noticeably larger than its neighbours.

Apple's macOS app-icon grid (Big Sur onward), on a 1024x1024 canvas:

    body    824 x 824, centred  ->  100px transparent margin on every side
    corner  radius 185.4        ->  22.5% of the body

Those three numbers are the contract, written literally below so they stay
auditable against Apple's published template.

The corner is a circular-arc rounded rectangle. Apple's real shape is a
continuous-curvature squircle, which differs from a circular arc by about a
pixel at Dock sizes; the published grid radius with a circular arc is the
standard approximation and is what design tools emit by default.

## Why a raster master, not the SVG

`src-tauri/icons/app-icon.svg` does NOT match the shipped artwork — it describes
a near-black tile with a gradient wordmark, whereas HQ actually ships a
pink/violet gradient tile with a white wordmark. Regenerating from that SVG
silently rebrands the app. The master here was recovered from the 1024x1024
`ic10` representation inside the previously shipped `icon.icns`, which is the
highest-resolution copy of the real artwork that exists in the repo.

If a true vector master ever turns up, point this script at a rasterised 1024px
export of it; the grid maths below does not change.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Apple's macOS icon grid.
CANVAS = 1024
BODY = 824
RADIUS = 185.4
MARGIN = (CANVAS - BODY) // 2  # 100

# Corners are drawn at this multiple and downsampled, so the arc is smooth
# instead of stair-stepped. A plain rounded_rectangle() mask at 1024 has visibly
# hard edges at Dock sizes.
SUPERSAMPLE = 4

ICONS = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
MASTER = ICONS / "source" / "app-icon-master.png"
OUTPUT = ICONS / "app-icon.png"


def squircle_mask(size: int, body: int, radius: float, margin: int) -> Image.Image:
    """Antialiased alpha mask: a rounded rect of `body` inset by `margin`."""
    hi = size * SUPERSAMPLE
    mask = Image.new("L", (hi, hi), 0)
    draw = ImageDraw.Draw(mask)
    lo = margin * SUPERSAMPLE
    draw.rounded_rectangle(
        [lo, lo, lo + body * SUPERSAMPLE - 1, lo + body * SUPERSAMPLE - 1],
        radius=radius * SUPERSAMPLE,
        fill=255,
    )
    # BOX, not LANCZOS. Downsampling a coverage mask is an area-average, which
    # is exactly what BOX does. LANCZOS has negative lobes, so it rings: it
    # leaves a few pixels of faint alpha OUTSIDE the geometric edge, which
    # pushes the icon off the grid (measured: bbox 97..927 instead of
    # 100..924) and puts a faint halo around the tile.
    return mask.resize((size, size), Image.BOX)


def main() -> int:
    if not MASTER.exists():
        print(f"missing master artwork: {MASTER}", file=sys.stderr)
        return 1

    master = Image.open(MASTER).convert("RGBA")
    if master.size != (CANVAS, CANVAS):
        print(
            f"master must be {CANVAS}x{CANVAS}, got {master.size[0]}x{master.size[1]}",
            file=sys.stderr,
        )
        return 1

    # Shrink the full-bleed art to the body, then inset it by the margin.
    body = master.resize((BODY, BODY), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(body, (MARGIN, MARGIN))

    # Replace alpha wholesale rather than compositing: the master's own corners
    # are opaque, so multiplying would leave them opaque outside the squircle.
    canvas.putalpha(squircle_mask(CANVAS, BODY, RADIUS, MARGIN))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUTPUT, "PNG")

    corners = [canvas.getpixel(p)[3] for p in [(0, 0), (CANVAS - 1, 0), (0, CANVAS - 1), (CANVAS - 1, CANVAS - 1)]]
    bbox = canvas.getchannel("A").getbbox()
    print(f"wrote {OUTPUT.relative_to(ICONS.parent.parent)}  {canvas.size}")
    print(f"  opaque bbox {bbox}  (expected ({MARGIN}, {MARGIN}, {MARGIN + BODY}, {MARGIN + BODY}))")
    print(f"  corner alpha {corners}  (expected all 0)")
    assert corners == [0, 0, 0, 0], "corners must be transparent"
    assert bbox == (MARGIN, MARGIN, MARGIN + BODY, MARGIN + BODY), "body must sit on the grid"
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
