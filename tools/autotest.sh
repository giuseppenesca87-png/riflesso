#!/bin/bash
# ------------------------------------------------------------------
# Riflesso — l'autotest per intero (PIVOT §9).
#
#   1. compila, parte, serve la webapp        → --selftest dell'host
#   2. elenco chat vero, ordinato, leggibile  → uitest
#   3. conversazione resa bene + screenshot   → uitest
#   4. invio provato davvero, in streaming    → sendtest (sessione di prova)
#   5. aggiornamento dal vivo                 → sendtest
#   6. zero errori in console, riavvio pulito → uitest + restarttest
#
# L'invio gira SEMPRE su una sessione di prova creata qui dentro,
# mai su una chat vera.
# ------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBAPP="$ROOT/webapp"
BIN="$ROOT/host-mac/.build/debug/RiflessoHost"
LOG=/tmp/riflesso-autotest.log
PROVA="$ROOT/test-output/prova-chat"
# `--emit-pin` avvia l'host e stampa i PIN via via che si rigenerano.
# `--print-pin` e' un'altra cosa: chiede il PIN a chi gia' gira, e poi esce.
HOST_CMD="$BIN --emit-pin >> $LOG 2>&1"
FAILS=0

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
note() { printf '     %s\n' "$1"; }
fail() { FAILS=$((FAILS+1)); printf '\033[31m[NO] %s\033[0m\n' "$1"; }

pin() { grep -o 'PIN=[0-9]*' "$LOG" | tail -1 | cut -d= -f2; }
stop_host() { pkill -f RiflessoHost 2>/dev/null; sleep 1.5; }
start_host() {
  : > "$LOG"
  RIFLESSO_WEBAPP="$WEBAPP" sh -c "$HOST_CMD" &
  for _ in $(seq 1 40); do
    sleep 0.4
    curl -sf http://localhost:7654/health >/dev/null && return 0
  done
  return 1
}

step "compilazione"
( cd "$ROOT/host-mac" && swift build 2>&1 | tail -3 ) || { fail "non compila"; exit 1; }

step "1. autotest dell'host (permessi, server, lettura transcript)"
stop_host
# Una sola esecuzione: l'autotest tocca davvero Claude Desktop (tastiera,
# scorrimento), e farlo due volte lo disturberebbe per niente.
SELF_OUT=/tmp/riflesso-selftest.log
RIFLESSO_WEBAPP="$WEBAPP" "$BIN" --selftest > "$SELF_OUT" 2>&1
SELF_RC=$?
grep -vE '^[0-9]{2}:' "$SELF_OUT" | grep -E '^\[|^===|^ ' || true
[ "$SELF_RC" = "0" ] || fail "autotest dell'host ($SELF_RC controlli falliti)"

step "2. la sessione di prova (mai una chat vera)"
mkdir -p "$PROVA"
STATE="$ROOT/test-output/prova-chat-id.txt"
if [ -s "$STATE" ]; then
  CHAT_ID="$(cat "$STATE")"
  note "riuso la sessione di prova $CHAT_ID"
else
  CHAT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
  note "creo una sessione di prova nuova: $CHAT_ID"
  ( cd "$PROVA" && env -u CLAUDE_CONFIG_DIR claude --session-id "$CHAT_ID" -p \
      --output-format stream-json --verbose --model claude-haiku-4-5-20251001 \
      "Rispondi solo con: PRONTO." >/dev/null 2>&1 )
  echo "$CHAT_ID" > "$STATE"
fi
SLUG="$(python3 -c "import re,sys; print(re.sub(r'[^a-zA-Z0-9]','-',sys.argv[1]))" "$PROVA")"
CHAT_FILE="$HOME/.claude/projects/$SLUG/$CHAT_ID.jsonl"
[ -f "$CHAT_FILE" ] || fail "il transcript di prova non esiste: $CHAT_FILE"

# F1 — la sessione di prova viene «avvelenata» apposta: la cwd scritta nei suoi
# record punta a una sottocartella, come dopo un `cd` dentro la sessione. Cosi'
# la prova d'invio qui sotto e' anche la prova che l'host riprende dalla
# cartella-progetto e non da quella sbirciata nel file.
mkdir -p "$PROVA/sotto"
python3 - "$CHAT_FILE" "$PROVA/sotto" <<'PY'
import json, sys
path, sotto = sys.argv[1], sys.argv[2]
rows = []
for line in open(path, encoding='utf-8'):
    if not line.strip():
        continue
    try:
        o = json.loads(line)
    except Exception:
        rows.append(line.rstrip('\n')); continue
    if 'cwd' in o:
        o['cwd'] = sotto
    rows.append(json.dumps(o, ensure_ascii=False))
open(path, 'w', encoding='utf-8').write('\n'.join(rows) + '\n')
PY
note "F1: la cwd nel transcript di prova punta a $PROVA/sotto, la cartella vera e' $PROVA"
WHERE="$("$BIN" --where "$CHAT_ID" 2>&1 | awk -F': *' '/^scelta:/ {print $2}')"
[ "$WHERE" = "$PROVA" ] && note "F1: l'host sceglie $WHERE" \
                        || fail "F1: l'host sceglie $WHERE invece di $PROVA"

# Il rumore di Node va tolto, ma l'esito che conta e' quello dello script,
# non quello di grep: va letto subito dopo la pipeline.
run_node() {
  local script="$1"; shift
  node --experimental-websocket "$script" 2>&1 \
    | grep -v ExperimentalWarning | grep -v 'trace-warnings'
  return "${PIPESTATUS[0]}"
}

step "3. la webapp: elenco chat, conversazione, markdown, specchio"
stop_host
start_host || { fail "l'host non parte"; exit 1; }
RIFLESSO_PIN="$(pin)" run_node "$ROOT/tools/uitest.js" || fail "collaudo della webapp"

step "4-5. invio vero e aggiornamento dal vivo (sessione di prova)"
RIFLESSO_PIN="$(pin)" RIFLESSO_TEST_CHAT="$CHAT_ID" RIFLESSO_TEST_CWD="$PROVA" \
RIFLESSO_TEST_FILE="$CHAT_FILE" \
  run_node "$ROOT/tools/sendtest.js" || fail "collaudo dell'invio"

step "6. riavvio pulito"
RIFLESSO_PIN="$(pin)" RIFLESSO_HOST="$HOST_CMD" RIFLESSO_WEBAPP="$WEBAPP" \
  run_node "$ROOT/tools/restarttest.js" || fail "collaudo del riavvio"

step "7. F6: --print-pin stampa e se ne va"
# Prima restava in esecuzione e apriva una seconda copia che litigava sulla
# porta. Adesso e' un cliente: chiede il PIN a chi gia' gira, e finisce.
PIN_OUT="$("$BIN" --print-pin 2>/tmp/riflesso-printpin.err)"
PIN_RC=$?
PIN_ERR="$(cat /tmp/riflesso-printpin.err)"
if [ "$PIN_RC" = "0" ] && [ "$PIN_OUT" = "PIN=$(pin)" ]; then
  note "esce subito e stampa il PIN dell'istanza viva: $PIN_OUT"
else
  fail "--print-pin: uscita $PIN_RC, stampato «$PIN_OUT» invece di «PIN=$(pin)» $PIN_ERR"
fi
echo "$PIN_ERR" | grep -qi "already in use" && fail "--print-pin litiga ancora sulla porta"
# e a host spento deve dirlo, non restare appeso
stop_host
"$BIN" --print-pin >/dev/null 2>/tmp/riflesso-printpin2.err
[ "$?" = "1" ] && note "a host spento esce con 1 e spiega: $(head -1 /tmp/riflesso-printpin2.err)" \
               || fail "--print-pin non segnala l'host spento"

step "8. F1: cartella diversa dallo slug (sessione di prova a parte)"
"$ROOT/tools/f1test.sh" || fail "collaudo della cartella (F1)"

step "9. il giro nuovo: manda il telefono, lavora il Desktop"
# Serve Claude Desktop aperto **e** la sessione di prova gia' conosciuta da lui
# (`sessionId == local_<cliId>`), altrimenti il collegamento diretto la
# importerebbe: e' la regola scritta in DesktopBridge, qui la si rispetta.
DESK="$HOME/Library/Application Support/Claude/claude-code-sessions"
if ! pgrep -qx Claude; then
  note "Claude Desktop non è in esecuzione: la prova del percorso Desktop si salta"
elif ! ls "$DESK"/*/*/local_"$CHAT_ID".json >/dev/null 2>&1; then
  note "la sessione di prova non è ancora fra quelle del Desktop: aprila una volta con"
  note "  open -g \"claude://resume?session=$CHAT_ID\"   (la importa: succede solo la prima volta)"
else
  start_host || fail "l'host non parte"
  RIFLESSO_PIN="$(pin)" RIFLESSO_TEST_CHAT="$CHAT_ID" \
    run_node "$ROOT/tools/desktoptest.js" || fail "collaudo del percorso Desktop"
fi

stop_host

step "10. fuori casa dal ponte: punto d'incontro cieco e collegamento diretto"
# Questa prova gira contro l'app **installata**: la pagina ponte vive dentro
# `Riflesso.app`, non dentro il binario di collaudo. Se l'app non e' in
# esecuzione si dice e si salta, invece di far finta. Le due strade insieme
# (casa e ponte) e l'elenco in spinta stanno in `tools/solocasatest.js`,
# sempre contro l'app installata.
if ! curl -sf http://localhost:7654/health >/dev/null 2>&1; then
  note "Riflesso non è in esecuzione: «open -a Riflesso» e rilancia"
  note "  (il fuori casa si prova contro l'app installata, non contro il binario di collaudo)"
elif ! command -v deno >/dev/null 2>&1; then
  note "deno non è installato: «brew install deno» e rilancia"
else
  run_node "$ROOT/tools/remotetest.js" || fail "collaudo del fuori casa"
fi

step "esito"
if [ "$FAILS" = "0" ]; then
  printf '\033[32mtutte le prove superate. Immagini in test-output/.\033[0m\n'
else
  printf '\033[31m%s gruppi di prove falliti.\033[0m\n' "$FAILS"
fi
exit "$FAILS"
