#!/usr/bin/env python3
"""Generate HighSeaz store item images via Pollinations (free, keyless), then
strip the corner watermark with dewatermark.py. Resumable: skips anything already done.

  python gen_store.py            # generate everything missing
  python gen_store.py --only cannon   # only items whose name contains 'cannon'
  python gen_store.py --list     # print the catalog and exit
"""
import argparse
import os
import subprocess
import sys
import time
import urllib.parse

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "store")
RAW = os.path.join(HERE, "_store_raw")
DEWM = os.path.join(HERE, "dewatermark.py")

SIZE = 768
MODEL = "flux"
STYLE = ("single object centered, dark navy background, dramatic rim lighting, "
         "gold and teal accents, highly detailed clean product render, "
         "game store item, no text, no label")

# name -> (category, description prompt)
CATALOG = {
    # --- SHIPS (names assigned in assets/models) ---
    "ship_starter_sloop":  "a small humble single-masted starter sloop with a worn tan sail",
    "ship_raider_sloop":   "a quick sleek armed single-masted raider sloop with dark sails",
    "ship_raider_brig":    "a fast two-masted raider brig with black sails and sharp bow",
    "ship_brigantine":     "a two-masted brigantine warship with square sails and a long bowsprit",
    "ship_merchant":       "a sturdy round-bellied merchant trading ship with a heavy cargo hold",
    "ship_galleon":        "a large high-sterncastle galleon with three masts and full canvas",
    "ship_war_galleon":    "a heavily armed war galleon bristling with rows of cannon ports",
    "ship_imperial":       "an ornate imperial warship with golden sails, flags and gilded carvings",
    # --- CANNONS ---
    "cannon_light":      "a small sleek bronze naval swivel cannon with a short barrel",
    "cannon_medium":     "a medium cast-iron naval cannon on a wooden gun carriage",
    "cannon_heavy":      "a large heavy-caliber iron naval cannon with a thick barrel on a reinforced carriage",
    "cannon_longrange":  "an elongated culverin-style long slim naval cannon with a narrow barrel",
    "cannon_ornate":     "an ornate baroque royal naval cannon engraved with gold filigree and a dolphin handle",
    "cannon_reinforced": "a reinforced iron cannon wrapped in steel hoop reinforcement rings",
    "cannon_legendary":  "a legendary dark-metal naval cannon with molten gold runes and a faint blue glow",
    # --- AMMUNITION ---
    "ammo_cannonball":   "a single solid black iron cannonball",
    "ammo_roundshot":    "a stack of solid iron round cannon shot balls",
    "ammo_chainshot":    "a pair of iron cannonballs joined by a chain, chain shot",
    "ammo_barshot":      "a bar shot, two cannonballs joined by a solid iron bar",
    "ammo_grapeshot":    "a canvas bag of clustered iron balls, grape shot canister",
    "ammo_canister":     "an open canister shot case spilling small iron musket balls",
    "ammo_heatedshot":   "a glowing red-hot iron cannonball held by metal tongs",
    "ammo_explosive":    "a hollow explosive iron cannon shell with a lit fuse",
    "ammo_silver":       "a polished silver cannonball engraved with protective wards",
    "ammo_cursed":       "a black cursed cannonball glowing with red runes and smoke",
    # --- SAILS ---
    "sail_linen":        "a light pale linen racing sail, thin and finely woven",
    "sail_canvas":       "a folded cream canvas square sail with stitched seams and rope edges",
    "sail_reinforced":   "a heavy doubled canvas sail with leather patches and iron grommets",
    "sail_storm":        "a dark weathered storm trysail sail, thick and battered",
    "sail_silk":         "a flowing black silk speed sail with a subtle sheen",
    "sail_crimson":      "a deep crimson raider sail with black trim and tattered edges",
    "sail_war":          "a heavy ballistic war sail reinforced with hidden iron mesh",
    "sail_imperial":     "a gold-trimmed white imperial ceremonial sail with an eagle crest",
    "sail_legendary":    "a glowing translucent spectral sail with faint floating runes",
    # --- HULL & ARMOR ---
    "hull_timber":       "a stack of oak hull planking timber boards",
    "hull_ironbrace":    "an iron reinforcement brace bracket for a ship hull",
    "hull_copper":       "shiny copper sheathing plates for a ship hull",
    "hull_bulwark":      "a thick armored wooden bulwark section with iron studs",
    # --- REPAIRS ---
    "repair_kit":        "a sailor's repair kit with a hammer, nails and rope in a wooden crate",
    "repair_tar":        "a barrel of black pitch tar with a brush for caulking",
    "repair_timber":     "a bundle of spare ship timber and pegs",
    "repair_sailneedle": "a large wooden sailmaker's palm and needle with waxed thread",
    # --- NAVIGATION ---
    "nav_spyglass":      "a brass telescoping spyglass, partially extended",
    "nav_compass":       "an ornate brass ship's compass with a glowing needle",
    "nav_chart":         "a rolled old sea chart map with a wax seal",
    "nav_lantern":       "a brass ship's lantern with a warm flame",
    # --- RIGGING & GEAR ---
    "gear_anchor":       "a weathered iron ship anchor with rope",
    "gear_figurehead":   "a carved wooden ship figurehead of a serpent",
    "gear_rope":         "a neat coil of thick hemp rope",
    "gear_wheel":        "a polished wooden ship's steering wheel with brass fittings",
    # --- CARGO & TRADE ---
    "cargo_crate":       "a sealed wooden trade crate stamped with a coin emblem",
    "cargo_treasure":    "an open chest overflowing with gold doubloon coins",
    "cargo_spice":       "wooden barrels of colorful spices and sacks",
    "cargo_rum":         "a cluster of rum barrels with a tap",
    # --- SPECIAL / LEGENDARY ---
    "special_krakeneeye":"a mystical kraken-eye lens in a gold frame, glowing teal",
    "special_ghostlantern":"an eerie ghostly green spectral lantern",
    "special_horseshoe": "a rusty lucky horseshoe nailed to driftwood",
}


def prompt_for(desc):
    return f"{desc}, {STYLE}"


def fetch(url, dest, tries=4):
    for i in range(tries):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 200 and r.content[:2] == b"\xff\xd8" or (r.content[:4] == b"\x89PNG"):
                with open(dest, "wb") as f:
                    f.write(r.content)
                return True
            wait = int(r.headers.get("Retry-After", "0")) or (8 * (i + 1))
            print(f"    HTTP {r.status_code}; retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
        except Exception as e:
            print(f"    err {e}; retry", file=sys.stderr)
            time.sleep(6)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="substring filter on item name")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--delay", type=float, default=3.0, help="seconds between items")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(RAW, exist_ok=True)

    items = {k: v for k, v in CATALOG.items() if (not args.only or args.only in k)}
    if args.list:
        for k in sorted(items):
            print(f"{k}: {items[k]}")
        print(f"\n{len(items)} items")
        return

    ok = made = failed = skipped = 0
    total = len(items)
    for i, (name, desc) in enumerate(sorted(items.items()), 1):
        clean = os.path.join(OUT, f"{name}.png")
        if os.path.exists(clean):
            skipped += 1
            continue
        print(f"[{i}/{total}] {name}")
        url = ("https://image.pollinations.ai/prompt/"
               + urllib.parse.quote(prompt_for(desc))
               + f"?width={SIZE}&height={SIZE}&model={MODEL}&nologo=true")
        raw = os.path.join(RAW, f"{name}.src.jpg")
        if not fetch(url, raw):
            print(f"    FAILED to fetch {name}", file=sys.stderr)
            failed += 1
            continue
        res = subprocess.run(
            [sys.executable, DEWM, raw, clean, "--corner", "br",
             "--fw", "0.34", "--fh", "0.08", "--pad", "6"],
            capture_output=True, text=True)
        if os.path.exists(clean):
            made += 1
            print(f"    -> {clean}")
        else:
            failed += 1
            print(f"    FAILED dewatermark: {res.stderr.strip()}", file=sys.stderr)
        time.sleep(args.delay)

    print(f"\nDone. made={made} skipped={skipped} failed={failed} of {total}")
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
