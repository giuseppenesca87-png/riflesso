#!/bin/bash
# Compila Riflesso, lo impacchetta in Riflesso.app e lo firma.
#
#   ./build.sh              compila e firma in build/Riflesso.app
#   ./build.sh --install    lo copia anche in /Applications
#   ./build.sh --run        lo avvia dopo la compilazione
#
# **Le cose personali stanno in `host-mac/local.env`**, un file fuori dal
# repository (vedi `local.env.example`): l'identita' dell'app, l'identita' di
# firma, l'indirizzo del proprio ponte. Senza quel file si compila lo stesso,
# con i valori neutri e la firma ad-hoc.
#
# La firma con un'identita' reale conta: senza, macOS azzera i permessi
# (Accessibilita') a ogni ricompilazione perche' cambia il cdhash.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
BUILD="$HERE/build"
APP="$BUILD/Riflesso.app"

# Il file locale, se c'e'. Le variabili gia' nell'ambiente vincono.
if [ -f "$HERE/local.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$HERE/local.env"; set +a
fi
BUNDLE_ID="${RIFLESSO_BUNDLE_ID:-}"
IDENTITY="${RIFLESSO_IDENTITY:-}"
BRIDGE="${RIFLESSO_BRIDGE:-}"

DO_INSTALL=0; DO_RUN=0; for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --run) DO_RUN=1 ;;
    *) echo "opzione sconosciuta: $arg"; exit 2 ;;
  esac
done

echo "==> compilazione (release)"
cd "$HERE"
swift build -c release --disable-sandbox

BIN="$(swift build -c release --show-bin-path)/RiflessoHost"
[ -x "$BIN" ] || { echo "binario non trovato: $BIN"; exit 1; }

echo "==> impacchettamento"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Riflesso"
cp "$HERE/Resources/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

PLIST=/usr/libexec/PlistBuddy
# L'identita' dell'app: quella del file locale, se c'e'. Cambiarla su
# un'installazione esistente fa perdere i permessi: si sceglie una volta.
if [ -n "$BUNDLE_ID" ]; then
  "$PLIST" -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Contents/Info.plist"
fi
echo "    identita' dell'app: $("$PLIST" -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
# L'indirizzo di partenza del ponte, se questa build ne ha uno.
if [ -n "$BRIDGE" ]; then
  "$PLIST" -c "Set :RiflessoBridgeDefault $BRIDGE" "$APP/Contents/Info.plist"
  echo "    ponte predefinito: $BRIDGE"
else
  echo "    ponte predefinito: nessuno (si scrive nel pannello)"
fi

# La webapp viaggia dentro l'app: l'host la serve da qui.
rm -rf "$APP/Contents/Resources/webapp"
cp -R "$ROOT/webapp" "$APP/Contents/Resources/webapp"

# Icona dell'app riusando quella della webapp.
if command -v sips >/dev/null && [ -f "$ROOT/webapp/icon-512.png" ]; then
  ICONSET="$BUILD/Riflesso.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$ROOT/webapp/icon-512.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png" 2>/dev/null || true
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Riflesso.icns" >/dev/null 2>&1 || true
  rm -rf "$ICONSET"
  if [ -f "$APP/Contents/Resources/Riflesso.icns" ]; then
    "$PLIST" -c "Add :CFBundleIconFile string Riflesso" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
  fi
fi

if [ -n "$IDENTITY" ] && security find-identity -v -p codesigning | grep -qF "$IDENTITY"; then
  echo "==> firma con: $IDENTITY"
  codesign --force --deep --options runtime --timestamp=none \
    --entitlements "$HERE/Resources/Riflesso.entitlements" \
    --sign "$IDENTITY" "$APP"
  codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'
  echo "    cdhash: $(codesign -dvvv "$APP" 2>&1 | grep -i '^CDHash' | head -1)"
else
  if [ -n "$IDENTITY" ]; then
    echo "!!! identita' di firma «$IDENTITY» non trovata nel portachiavi"
  fi
  echo "==> firma ad-hoc (il permesso di Accessibilita' va riconcesso a ogni build:"
  echo "    per evitarlo, RIFLESSO_IDENTITY in host-mac/local.env)"
  codesign --force --deep -s - "$APP"
fi

echo "==> pronto: $APP"

if [ "$DO_INSTALL" = "1" ]; then
  TARGET="/Applications/Riflesso.app"
  if [ ! -w /Applications ]; then TARGET="$HOME/Applications/Riflesso.app"; mkdir -p "$HOME/Applications"; fi
  # Se l'app gira, va chiusa prima di sovrascriverla.
  pkill -x Riflesso 2>/dev/null || true
  sleep 1
  rm -rf "$TARGET"
  cp -R "$APP" "$TARGET"
  echo "==> installata in $TARGET"
  # **La copia di lavoro non deve restare in giro.** Due bundle con la stessa
  # identita' confondono il Mac: dopo un riavvio partiva quella di build invece
  # di quella installata, e il registro delle app ne teneva due. Installata la
  # buona, la copia di staging si toglie dal disco e dal registro.
  LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  [ -x "$LSREG" ] && "$LSREG" -u "$APP" >/dev/null 2>&1 || true
  rm -rf "$APP"
  APP="$TARGET"
fi

if [ "$DO_RUN" = "1" ]; then
  pkill -x Riflesso 2>/dev/null || true
  sleep 1
  open -a "$APP"
  echo "==> avviata. Icona nella barra dei menu in alto a destra."
fi
