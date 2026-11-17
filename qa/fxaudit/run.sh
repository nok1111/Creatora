#!/usr/bin/env bash
# Real-render audit: every overlay effect + merge xfade must change pixels.
# Filter strings mirror render/effects.rs at EFFECT_DROP_PARAMS defaults;
# PSNR vs the unfiltered frame: inf = the effect does NOTHING.
FF="src-tauri/target/debug/tools/bin/ffmpeg.exe"
OUT="qa/fxaudit/frames"; mkdir -p "$OUT"
SRC="testsrc2=size=320x180:rate=10:duration=0.2"

"$FF" -v error -f lavfi -i "$SRC" -frames:v 1 -y "$OUT/ref.png"

declare -A FX=(
  [brightness]="colorchannelmixer=rr=1.25:gg=1.25:bb=1.25"
  [contrast]="lutrgb=r='clip(val*1.35+-31.875,0,255)':g='clip(val*1.35+-31.875,0,255)':b='clip(val*1.35+-31.875,0,255)'"
  [saturation]="colorchannelmixer=rr=1.3148:rg=-0.286:rb=-0.0288:gr=-0.0852:gg=1.114:gb=-0.0288:br=-0.0852:bg=-0.286:bb=1.3712"
  [blur]="gblur=sigma=8"
)
echo "=== OVERLAY (psnr vs unfiltered — inf = DOES NOTHING) ==="
for k in "${!FX[@]}"; do
  f="${FX[$k]}"
  if "$FF" -v error -f lavfi -i "$SRC" -vf "$f" -frames:v 1 -y "$OUT/$k.png" 2>"$OUT/$k.err"; then
    p=$("$FF" -i "$OUT/$k.png" -i "$OUT/ref.png" -filter_complex "psnr" -f null - 2>&1 | grep -o "average:[0-9.inf]*" | head -1)
    echo "$k : $p"
  else
    echo "$k : FFMPEG ERROR: $(head -1 "$OUT/$k.err")"
  fi
done | sort

