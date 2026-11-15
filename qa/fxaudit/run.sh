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
  [grayscale]="colorchannelmixer=rr=0.213:rg=0.715:rb=0.072:gr=0.213:gg=0.715:gb=0.072:br=0.213:bg=0.715:bb=0.072"
  [sepia]="colorchannelmixer=rr=0.48405:rg=0.65365:rb=0.16065:gr=0.29665:gg=0.7331:gb=0.1428:br=0.2312:bg=0.4539:bb=0.26135"
  [sharpen]="unsharp=5:5:1.5"
  [vignette]="vignette=angle=0.942477796"
  [grain]="noise=alls=18:allf=t+u"
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

