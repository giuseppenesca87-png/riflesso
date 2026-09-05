#!/bin/bash
# Riflesso — prepara il rimbalzo (coturn) su QUESTA macchina.
#
# Fa tre cose, e non ne fa una quarta:
#   1. genera il segreto (una volta sola: se `.env` esiste lo tiene, a meno di
#      `--rigenera`), e scrive `.env` con permessi 600;
#   2. calcola i due indirizzi pubblici della macchina — l'IPv4 e l'IPv6 — e li
#      scrive al posto dei segnaposto di `turnserver.conf`, producendo
#      `turnserver.local.conf`. Gli indirizzi si CALCOLANO qui e non si
#      copiano dal repository: chi si copia un file con dentro l'indirizzo di
#      un altro protegge quella macchina e lascia scoperta la propria;
#   3. stampa, senza eseguirli, i comandi che restano: il container e le tre
#      regole del firewall (solo IPv4, a mano). Il firewall non si tocca da
#      uno script: su una macchina dove girano altri progetti in produzione
#      lo si fa con gli occhi aperti.
#
#     ./installa.sh                      # sulla VPS
#     ./installa.sh --dest /una/cartella # per una prova: scrive lì e non qui
#     ./installa.sh --ipv4 X --ipv6 Y    # se il calcolo automatico sbaglia
#     ./installa.sh --senza-ipv6         # macchina senza IPv6 pubblico
#     ./installa.sh --rigenera           # un segreto nuovo (il ponte va riavviato)
#
# Gira sia su Linux (`ip route`) sia su macOS (`route`/`ifconfig`), perché il
# collaudo lo lancia sul Mac contro un coturn locale prima della VPS.
set -euo pipefail

QUI="$(cd "$(dirname "$0")" && pwd)"
DEST="$QUI"
IPV4=""; IPV6=""; SENZA6=0; RIGENERA=0; ZITTO=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --ipv4) IPV4="$2"; shift 2 ;;
    --ipv6) IPV6="$2"; shift 2 ;;
    --senza-ipv6) SENZA6=1; shift ;;
    --rigenera) RIGENERA=1; shift ;;
    --zitto) ZITTO=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opzione sconosciuta: $1" >&2; exit 2 ;;
  esac
done

dire() { [ "$ZITTO" = 1 ] || echo "$@"; }
morire() { echo "installa.sh: $*" >&2; exit 1; }

MODELLO="$QUI/turnserver.conf"
[ -f "$MODELLO" ] || morire "manca $MODELLO"
mkdir -p "$DEST"

# ---- 1. gli indirizzi della macchina ----
# L'indirizzo «pubblico» è quello da cui la macchina esce verso Internet: si
# chiede al sistema quale sorgente userebbe per raggiungere un indirizzo
# lontano. Nessun pacchetto parte: `route get` guarda solo la tabella.
ipv4_della_macchina() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
  else
    local dev
    dev="$(route -n get 1.1.1.1 2>/dev/null | awk '/interface:/{print $2; exit}')"
    [ -n "$dev" ] && ipconfig getifaddr "$dev" 2>/dev/null || true
  fi
}
ipv6_della_macchina() {
  if command -v ip >/dev/null 2>&1; then
    local v
    v="$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    # senza rotta di default IPv6 la sorgente non c'è: si prende il primo
    # indirizzo globale che non sia temporaneo
    [ -n "$v" ] || v="$(ip -6 addr show scope global -temporary 2>/dev/null | awk '/inet6/{sub("/.*","",$2); print $2; exit}')"
    echo "$v"
  else
    local dev
    dev="$(route -n get -inet6 2606:4700:4700::1111 2>/dev/null | awk '/interface:/{print $2; exit}')"
    [ -n "$dev" ] || dev="$(route -n get 1.1.1.1 2>/dev/null | awk '/interface:/{print $2; exit}')"
    [ -n "$dev" ] && ifconfig "$dev" 2>/dev/null \
      | awk '/inet6 / && !/temporary/ {a=$2; sub("%.*","",a); if (a !~ /^(fe80|fe9|fea|feb|fc|fd)/) {print a; exit}}' || true
  fi
}

[ -n "$IPV4" ] || IPV4="$(ipv4_della_macchina)"
[ -n "$IPV4" ] || morire "non trovo l'IPv4 della macchina: passalo con --ipv4"
[[ "$IPV4" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || morire "IPv4 strano: $IPV4"
case "$IPV4" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|127.*|169.254.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
    dire "ATTENZIONE: $IPV4 è un indirizzo privato. Va bene per una prova in casa,"
    dire "            non per una macchina su Internet (lì l'indirizzo pubblico sta sull'interfaccia)." ;;
esac

if [ "$SENZA6" = 1 ]; then
  IPV6=""
else
  [ -n "$IPV6" ] || IPV6="$(ipv6_della_macchina)"
  if [ -z "$IPV6" ]; then
    dire "ATTENZIONE: nessun IPv6 pubblico trovato: la riga IPv6 resta fuori (--ipv6 X per forzarlo)."
  else
    [[ "$IPV6" == *:* ]] || morire "IPv6 strano: $IPV6"
    case "$IPV6" in
      fe[89ab]*|fc*|fd*|::1) morire "$IPV6 non è un indirizzo pubblico: passa quello giusto con --ipv6, o --senza-ipv6" ;;
    esac
  fi
fi

# ---- 2. il segreto ----
ENVF="$DEST/.env"
SEGRETO=""
if [ -f "$ENVF" ] && [ "$RIGENERA" = 0 ]; then
  SEGRETO="$(awk -F= '/^TURN_SECRET=/{print $2; exit}' "$ENVF")"
  [ -n "$SEGRETO" ] && dire "segreto: quello già in $ENVF (--rigenera per cambiarlo)"
fi
if [ -z "$SEGRETO" ]; then
  # Solo esadecimale: passa dalla riga di comando di coturn, e l'entrypoint
  # dell'immagine fa `eval` sugli argomenti — un carattere speciale lì dentro
  # romperebbe l'avvio.
  SEGRETO="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "${#SEGRETO}" = 64 ] || morire "non riesco a generare il segreto"
  dire "segreto: generato (64 cifre esadecimali)"
fi

# ---- 3. i due file ----
umask 077
{
  echo "# Scritto da installa.sh il $(date '+%Y-%m-%d %H:%M'). NON versionare."
  echo "TURN_SECRET=$SEGRETO"
  echo "TURN_HOST=$IPV4"
  echo "TURN_IPV4=$IPV4"
  echo "TURN_IPV6=$IPV6"
} > "$ENVF.tmp"
mv -f "$ENVF.tmp" "$ENVF"
chmod 600 "$ENVF"

CONF="$DEST/turnserver.local.conf"
# Il file deve poterlo leggere `nobody` dentro il container: 644. Non contiene
# il segreto, solo gli indirizzi.
umask 022
{
  echo "# Generato da installa.sh da turnserver.conf il $(date '+%Y-%m-%d %H:%M'). NON versionare."
  echo "# Indirizzi di questa macchina: IPv4 $IPV4 · IPv6 ${IPV6:-(nessuno)}"
  if [ -n "$IPV6" ]; then
    sed -e "s/__IPV4__/$IPV4/g" -e "s/__IPV6__/$IPV6/g" "$MODELLO"
  else
    sed -e "s/__IPV4__/$IPV4/g" -e "s/^denied-peer-ip=__IPV6__$/# (nessun IPv6 pubblico su questa macchina: riga omessa da installa.sh)/" "$MODELLO"
  fi
} > "$CONF.tmp"
mv -f "$CONF.tmp" "$CONF"
chmod 644 "$CONF"

# Nessun segnaposto deve sopravvivere: coturn si rifiuterebbe di partire, ma
# meglio dirlo qui che scoprirlo nel registro del container.
if grep -q "__IPV" "$CONF"; then morire "segnaposto rimasti in $CONF"; fi

# ---- 4. cosa resta da fare, e chi lo fa ----
dire ""
dire "scritti:"
dire "  $ENVF                  (600: il segreto, TURN_HOST=$IPV4)"
dire "  $CONF   (644: la configurazione con gli indirizzi di questa macchina)"
dire ""
dire "indirizzi negati come destinazione del rimbalzo, oltre alle reti private:"
dire "  IPv4  $IPV4"
dire "  IPv6  ${IPV6:-(nessuno)}"
dire ""
dire "Adesso, a mano e con gli occhi aperti:"
dire ""
dire "  # il container (dalla cartella di questo script; MAI aggiungere 'ports:')"
dire "  cd $DEST && docker compose up -d && docker compose logs -f rimbalzo"
dire ""
dire "  # le tre regole del firewall, SOLO IPv4 (su questa macchina ogni regola"
dire "  # nuda ne creerebbe due, e la IPv6 non va aperta: coturn parla solo IPv4)"
dire "  ufw allow proto udp from any to $IPV4 port 3478"
dire "  ufw allow proto tcp from any to $IPV4 port 3478"
dire "  ufw allow proto udp from any to $IPV4 port 49200:49400"
dire ""
dire "  # il ponte legge da solo QUESTO .env (TURN_HOST e TURN_SECRET): il suo"
dire "  # docker-compose.yml ha già 'env_file: coturn/.env'. Basta rilanciarlo,"
dire "  # dalla cartella del ponte (quella che contiene coturn/):"
dire "  docker compose up -d --build && docker compose logs ponte | grep rimbalzo"
dire "  #   → «rimbalzo (TURN): acceso · turn:$IPV4:3478», e /health deve dire relay:true"
dire ""
dire "  # il collaudo, dal Mac o da qui:"
dire "  node tools/icecheck.js --turn        # legge bridge/coturn/.env"
