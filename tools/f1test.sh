#!/bin/bash
# ------------------------------------------------------------------
# F1 — la prova che conta: riprendere una conversazione la cui `cwd`
# registrata nel transcript e' DIVERSA dalla cartella-progetto in cui il
# CLI tiene il file.
#
# E' esattamente il caso successo per davvero: la conversazione viveva
# in `.../Claude/code`, ma dentro la sessione un `cd` aveva spostato la
# cartella di lavoro in `.../Claude/code/claude-mirror`, e l'host riprendeva
# da li'. `claude --resume` risponde «No conversation found».
#
# Si fa tutto su una sessione di prova NOSTRA, in test-output/.
# Mai su una chat vera.
# ------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/host-mac/.build/debug/RiflessoHost"
BASE="$ROOT/test-output/prova-cartella"
SOTTO="$BASE/sotto"
FAILS=0

ok()   { printf '[OK] %s\n' "$1"; }
bad()  { FAILS=$((FAILS+1)); printf '[NO] %s\n' "$1"; }
note() { printf '     %s\n' "$1"; }

mkdir -p "$SOTTO"
SLUG="$(python3 -c "import re,sys; print(re.sub(r'[^a-zA-Z0-9]','-',sys.argv[1]))" "$BASE")"
STATE="$ROOT/test-output/prova-cartella-id.txt"

if [ -s "$STATE" ] && [ -f "$HOME/.claude/projects/$SLUG/$(cat "$STATE").jsonl" ]; then
  ID="$(cat "$STATE")"
  note "riuso la sessione di prova $ID"
else
  ID="$(uuidgen | tr 'A-Z' 'a-z')"
  note "creo una sessione di prova in $BASE"
  ( cd "$BASE" && env -u CLAUDE_CONFIG_DIR claude --session-id "$ID" -p \
      --model claude-haiku-4-5-20251001 "Rispondi solo con: PRONTO." >/dev/null 2>&1 )
  echo "$ID" > "$STATE"
fi

FILE="$HOME/.claude/projects/$SLUG/$ID.jsonl"
[ -f "$FILE" ] || { bad "il transcript di prova non esiste: $FILE"; exit 1; }

# Si «avvelena» il file come farebbe un `cd` dentro la sessione: da qui in poi
# la cwd scritta nei record punta alla sottocartella, non alla cartella vera.
python3 - "$FILE" "$SOTTO" <<'PY'
import json, sys
path, sotto = sys.argv[1], sys.argv[2]
out = []
for line in open(path, encoding='utf-8'):
    if not line.strip():
        continue
    try:
        o = json.loads(line)
    except Exception:
        out.append(line.rstrip('\n')); continue
    if 'cwd' in o:
        o['cwd'] = sotto
    out.append(json.dumps(o, ensure_ascii=False))
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
note "cwd nel transcript riscritta a: $SOTTO"
note "cartella-progetto del file:     $SLUG"

echo
echo "--- 1. ripresa dalla cartella sbagliata (quello che faceva prima) ---"
OUT="$(cd "$SOTTO" && env -u CLAUDE_CONFIG_DIR claude --resume "$ID" -p \
        --model claude-haiku-4-5-20251001 "Rispondi solo con: X." 2>&1)"
if printf '%s' "$OUT" | grep -qi "No conversation found"; then
  ok "dalla cartella sbagliata il CLI rifiuta, come previsto"
  note "$(printf '%s' "$OUT" | head -1 | cut -c1-100)"
else
  bad "la ripresa sbagliata non ha dato l'errore atteso: $(printf '%s' "$OUT" | head -1 | cut -c1-120)"
fi

echo
echo "--- 2. la cartella scelta dall'host ---"
WHERE="$("$BIN" --where "$ID" 2>&1)"
printf '%s\n' "$WHERE" | sed 's/^/     /'
SCELTA="$(printf '%s' "$WHERE" | awk -F': *' '/^scelta:/ {print $2}')"
if [ "$SCELTA" = "$BASE" ]; then
  ok "l'host sceglie la cartella-progetto: $SCELTA"
elif [ "$SCELTA" = "$SOTTO" ]; then
  bad "l'host sceglie ancora la cwd del transcript: e' il difetto F1"
else
  bad "l'host sceglie una cartella inattesa: $SCELTA"
fi

echo
echo "--- 3. ripresa dalla cartella scelta ---"
MARK="F1-$(date +%s | tail -c 6)"
OUT2="$(cd "$SCELTA" && env -u CLAUDE_CONFIG_DIR claude --resume "$ID" -p \
         --model claude-haiku-4-5-20251001 "Rispondi solo con: $MARK" 2>&1)"
if printf '%s' "$OUT2" | grep -q "$MARK"; then
  ok "la conversazione riprende davvero e risponde ($MARK)"
else
  bad "la ripresa non ha funzionato: $(printf '%s' "$OUT2" | head -2 | tr '\n' ' ' | cut -c1-160)"
fi

# Il file torna avvelenato, cosi' la prova resta valida anche al giro dopo:
# riprendendo, il CLI ha riscritto la cwd giusta nei record nuovi.
echo
echo "--- 4. lo slug decodificato dal disco (chat nate dal Terminale) ---"
DEC="$("$BIN" --where "$ID" 2>&1 | awk -F': *' '/^scelta:/ {print $2}')"
[ "$DEC" = "$BASE" ] && ok "la cartella si ritrova anche a file appena riscritto" \
                      || bad "seconda lettura diversa: $DEC"

echo
if [ "$FAILS" = "0" ]; then
  printf '\033[32m=== F1: tutte le prove superate ===\033[0m\n'
else
  printf '\033[31m=== F1: %s prove fallite ===\033[0m\n' "$FAILS"
fi
exit "$FAILS"
