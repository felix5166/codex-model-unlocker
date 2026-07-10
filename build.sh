#!/bin/zsh
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$SOURCE_DIR/dist}"
APP="$OUTPUT_DIR/Codex 模型解锁器.app"
CONTENTS="$APP/Contents"
ICON_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-model-unlocker.XXXXXX")"
ICONSET="$ICON_WORK_DIR/AppIcon.iconset"
MASTER_ICON="$ICON_WORK_DIR/AppIcon-1024.png"

trap 'rm -rf "$ICON_WORK_DIR"' EXIT

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$ICONSET"

cp "$SOURCE_DIR/Info.plist" "$CONTENTS/Info.plist"
cp "$SOURCE_DIR/CodexModelUnlocker" "$CONTENTS/MacOS/CodexModelUnlocker"
cp "$SOURCE_DIR/injector.mjs" "$CONTENTS/Resources/injector.mjs"
cp "$SOURCE_DIR/injection.js" "$CONTENTS/Resources/injection.js"
chmod 755 "$CONTENTS/MacOS/CodexModelUnlocker"

/usr/bin/qlmanage -t -s 1024 -o "$ICON_WORK_DIR" "$SOURCE_DIR/AppIcon.svg" >/dev/null 2>&1
mv "$ICON_WORK_DIR/AppIcon.svg.png" "$MASTER_ICON"

for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  size="${spec%% *}"
  name="${spec#* }"
  /usr/bin/sips -z "$size" "$size" "$MASTER_ICON" --out "$ICONSET/$name" >/dev/null
done

if ! /usr/bin/iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"; then
  sleep 1
  /usr/bin/iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
fi

/usr/bin/codesign --force --deep --sign - "$APP"
/usr/bin/plutil -lint "$CONTENTS/Info.plist"

print -r -- "$APP"
