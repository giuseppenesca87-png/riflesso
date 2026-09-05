#!/bin/bash
# Il pannello del Mac, fotografato nei due stati e nelle due lingue.
#
#   tools/pannelloshot.sh prima
#   tools/pannelloshot.sh dopo
#
# Finiscono in promo/grafica/scatti/. Alla fine rimette servizio e lingua
# come stavano: sono le preferenze vere di chi usa l'app, non quelle di un
# collaudo.
#
# Serve il permesso di Registrazione schermo al terminale, e uno schermo
# **acceso**: a display addormentato `screencapture` non ha niente da
# fotografare e dice «could not create image from window».

set -euo pipefail

FASE="${1:-dopo}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/promo/grafica/scatti"
# L'identita' dell'app: quella di `host-mac/local.env` se c'e', altrimenti
# quella neutra. Con un dominio sbagliato `defaults write` scrive in un posto
# che l'app non legge, e la foto viene sempre uguale.
if [ -f "$ROOT/host-mac/local.env" ]; then set -a; . "$ROOT/host-mac/local.env"; set +a; fi
DOM="${RIFLESSO_BUNDLE_ID:-app.riflesso.host}"
SCRATCH="$(mktemp -d)"

mkdir -p "$OUT"
LANG_PRIMA="$(defaults read "$DOM" riflesso.lang 2>/dev/null || echo it)"
SERV_PRIMA="$(defaults read "$DOM" riflesso.servizio.acceso 2>/dev/null || echo 1)"

cat > "$SCRATCH/winid.swift" <<'SWIFT'
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                      kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where (w[kCGWindowOwnerName as String] as? String ?? "").contains("Riflesso") {
    print(w[kCGWindowNumber as String] as? Int ?? 0)
}
SWIFT

scatta() {                       # scatta <nome>
  osascript -e 'tell application "System Events" to set frontmost of first process whose name is "Riflesso" to true' 2>/dev/null || true
  sleep 1
  local id
  id="$(swift "$SCRATCH/winid.swift" | head -1)"
  [ -n "$id" ] || { echo "pannello non trovato"; return 1; }
  screencapture -x -l"$id" "$OUT/$FASE-mac-$1.png"
  echo "salvato promo/grafica/scatti/$FASE-mac-$1.png"
}

riavvia() {                      # riavvia <lang> <acceso 0|1>
  osascript -e 'quit app "Riflesso"' 2>/dev/null || true
  sleep 2
  defaults write "$DOM" riflesso.lang -string "$1"
  defaults write "$DOM" riflesso.servizio.acceso -bool "$2"
  open -a Riflesso; sleep 5
  open -a Riflesso; sleep 3      # il secondo apre il pannello
}

caffeinate -u -t 3 || true

riavvia it true;  scatta acceso-it
riavvia en true;  scatta acceso-en
riavvia it false; scatta spento-it
riavvia en false; scatta spento-en

# Come l'abbiamo trovato.
riavvia "$LANG_PRIMA" "$([ "$SERV_PRIMA" = "1" ] && echo true || echo false)"
rm -rf "$SCRATCH"
echo "lingua e servizio rimessi come stavano: $LANG_PRIMA / $SERV_PRIMA"
