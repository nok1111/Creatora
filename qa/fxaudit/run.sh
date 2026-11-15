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
  [invert]="lutrgb=r='val*-1+255':g='val*-1+255':b='val*-1+255'"
  [hueRotate]="hue=h=120"
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

# --- compound + new primitives (appended audit — same PSNR check) ---
declare -A FX2=(
  [channelSwap]="colorchannelmixer=rr=0:rg=0:rb=1:gr=0:gg=1:gb=0:br=1:bg=0:bb=0"
  [posterize]="lutrgb=r='floor(val/51+0.5)*51':g='floor(val/51+0.5)*51':b='floor(val/51+0.5)*51'"
  [scanlines]="geq=r='r(X,Y)*(1-0.45*eq(mod(Y,3),0))':g='g(X,Y)*(1-0.45*eq(mod(Y,3),0))':b='b(X,Y)*(1-0.45*eq(mod(Y,3),0))'"
  [rgbShift]="rgbashift=rh=8:bh=-8:edge=smear"
  [edges]="edgedetect=low=0.112:high=0.36:mode=colormix"
  [filmNoir]="colorchannelmixer=rr=0.213:rg=0.715:rb=0.072:gr=0.213:gg=0.715:gb=0.072:br=0.213:bg=0.715:bb=0.072,lutrgb=r='clip(val*1.35+-44.625,0,255)':g='clip(val*1.35+-44.625,0,255)':b='clip(val*1.35+-44.625,0,255)',vignette=angle=1.047197551"
  [dreamGlow]="gblur=sigma=3,colorchannelmixer=rr=1.144:gg=1.144:bb=1.144"
  [blockbuster]="colorchannelmixer=rr=1.15:rg=0:rb=-0.08:gr=-0.02:gg=1:gb=0:br=0.08:bg=0.02:bb=0.92"
  [matteFade]="lutrgb=r='clip(val*0.8875+22.95,0,255)':g='clip(val*0.8875+22.95,0,255)':b='clip(val*0.8875+22.95,0,255)'"
  [popColor]="colorchannelmixer=rr=1.19675:rg=-0.17875:rb=-0.018:gr=-0.05325:gg=1.07125:gb=-0.018:br=-0.05325:bg=-0.17875:bb=1.232"
  [retro]="lutrgb=r='clip(val*0.95+14,0,255)':g='clip(val*0.95+14,0,255)':b='clip(val*0.95+14,0,255)',colorchannelmixer=rr=0.816175:rg=0.228725:rb=0.056175:gr=0.103775:gg=0.91025:gb=0.0504:br=0.0808:bg=0.1599:bb=0.74275,noise=alls=12:allf=t+u"
  [crt]="rgbashift=rh=1.625:bh=-1.625:edge=smear,colorchannelmixer=rr=0.8195:rg=0.578625:rb=0.05832:gr=0.17235:gg=0.771875:gb=0.05832:br=0.17235:bg=0.578625:bb=0.8204,geq=r='r(X,Y)*(1-0.325*eq(mod(Y,3),0))':g='g(X,Y)*(1-0.325*eq(mod(Y,3),0))':b='b(X,Y)*(1-0.325*eq(mod(Y,3),0))'"
  [vhs]="rgbashift=rh=3.2:bh=-3.2:edge=smear,lutrgb=r='clip(val*0.95+16,0,255)':g='clip(val*0.95+16,0,255)':b='clip(val*0.95+16,0,255)',colorchannelmixer=rr=0.85432:rg=0.18456:rb=0.04536:gr=0.08352:gg=0.92488:gb=0.04032:br=0.06528:bg=0.12816:bb=0.79168,noise=alls=13:allf=t+u,geq=r='r(X,Y)*(1-0.32*eq(mod(Y,3),0))':g='g(X,Y)*(1-0.32*eq(mod(Y,3),0))':b='b(X,Y)*(1-0.32*eq(mod(Y,3),0))'"
)
echo "=== NEW EFFECTS ==="
for k in "${!FX2[@]}"; do
  f="${FX2[$k]}"
  if "$FF" -v error -f lavfi -i "$SRC" -vf "$f" -frames:v 1 -y "$OUT/$k.png" 2>"$OUT/$k.err"; then
    p=$("$FF" -i "$OUT/$k.png" -i "$OUT/ref.png" -filter_complex "psnr" -f null - 2>&1 | grep -o "average:[0-9.inf]*" | head -1)
    echo "$k : $p"
  else
    echo "$k : FFMPEG ERROR: $(head -1 "$OUT/$k.err")"
  fi
done | sort
