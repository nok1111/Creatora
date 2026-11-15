#!/usr/bin/env bash
FF="src-tauri/target/debug/tools/bin/ffmpeg.exe"
OUT="qa/fxaudit/frames"; mkdir -p "$OUT"
"$FF" -v error -f lavfi -i "color=c=red:size=320x180:rate=10:duration=0.2" -frames:v 1 -y "$OUT/ref_red.png"
"$FF" -v error -f lavfi -i "color=c=blue:size=320x180:rate=10:duration=0.2" -frames:v 1 -y "$OUT/ref_blue.png"
A="color=c=red:size=320x180:rate=10:duration=2"
B="color=c=blue:size=320x180:rate=10:duration=2"
MERGE="crossfade dipToBlack dipToWhite fadegrays dissolve pixelize hblur zoomin radial circleopen circleclose circlecrop wipeleft wiperight wipeup wipedown wipetl diagtr slideleft slideright slideup slidedown smoothleft smoothright coverleft coverup revealleft revealright revealup squeezeh vertopen horzclose hlslice vuslice vdslice"
for k in $MERGE; do
  case "$k" in
    dipToBlack) x="fadeblack";; dipToWhite) x="fadewhite";; crossfade) x="fade";; *) x="$k";;
  esac
  # frame 10 = t=1.0s = exact midpoint of the 1s transition (offset .5 → .5–1.5s)
  if "$FF" -v error -f lavfi -i "$A" -f lavfi -i "$B" -filter_complex "[0][1]xfade=transition=$x:duration=1:offset=0.5,select='eq(n,10)'" -frames:v 1 -y "$OUT/tr_$k.png" 2>"$OUT/tr_$k.err"; then
    pa=$("$FF" -i "$OUT/tr_$k.png" -i "$OUT/ref_red.png" -filter_complex psnr -f null - 2>&1 | grep -o "average:[0-9.inf]*" | head -1)
    pb=$("$FF" -i "$OUT/tr_$k.png" -i "$OUT/ref_blue.png" -filter_complex psnr -f null - 2>&1 | grep -o "average:[0-9.inf]*" | head -1)
    echo "$k : vsA=$pa vsB=$pb"
  else
    echo "$k : FFMPEG ERROR: $(head -1 "$OUT/tr_$k.err")"
  fi
done | sort
