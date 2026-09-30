#!/usr/bin/env bash
set -u
SRC="C:/Users/fred/Downloads/Highseaz"
OUT="C:/Users/fred/Documents/GitHub/HighSeaz/assets/models"
TMP="/tmp/hs_proc"
mkdir -p "$OUT" "$TMP"

ratio_for() {
  case "$1" in
    "Starter Sloop"|"Raider Sloop"|"Brigantine"|"Raider Brig"|"Galleon"|"War Galleon"|"Imperial Ship"|"Merchant Ship")
      echo "0.20" ;;   # ships: keep silhouette
    "Fortified Island"|"Jungle Island"|"Tropical Pirate Island"|"Volcanic Island"|"lighthouse")
      echo "0.08" ;;   # landmarks: seen from far
    *)
      echo "0.12" ;;   # props / vegetation / loot
  esac
}

for f in "$SRC"/*.glb; do
  base=$(basename "$f" .glb)
  r=$(ratio_for "$base")
  echo "=== $base (ratio $r) ==="
  npx --yes @gltf-transform/cli@latest simplify "$f" "$TMP/${base}.simp.glb" --ratio "$r" 2>&1 | tail -1
  npx --yes @gltf-transform/cli@latest optimize "$TMP/${base}.simp.glb" "$OUT/${base}.glb" \
    --compress meshopt --texture-compress webp --texture-size 1024 2>&1 | tail -1
done
echo "ALL DONE"
