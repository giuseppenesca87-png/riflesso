# Il ponte (punto d'incontro)

È il pezzo di Riflesso che sta **su Internet**, e serve a una cosa sola: far
trovare telefono e Mac quando il telefono è **fuori casa**, da qualunque rete,
senza VPN. È la seconda delle due strade (README in cima al repository, «Le
due strade»).

Ognuno lo mette sulla **propria** macchina — una VPS piccola basta, il traffico
è di qualche kilobyte per collegamento; qualche **megabyte** se accendi il
rimbalzo — e poi scrive l'indirizzo nel pannello
di Riflesso sul Mac, dietro la riga **Ponte**. Non c'è un ponte pubblico
predefinito: da fuori dal codice non parte nessuna chiamata verso un server che
non sia tuo.

## Cosa fa, in due righe

1. Serve la webapp in **HTTPS**, perché fuori casa il telefono non può prenderla
   dal Mac — e perché senza HTTPS il browser non dà nemmeno WebRTC.
2. Tiene **due cassette** per stanza, in cui telefono e Mac si lasciano una
   busta opaca a testa per pochi secondi. Poi i due si parlano **direttamente**
   (WebRTC), e la conversazione, l'elenco e gli allegati **non passano di qui**.
   Quando la rete del telefono non lo permette — succede con il 5G, che assegna
   una porta diversa per ogni destinazione — i byte passano da un **rimbalzo**
   sulla stessa macchina, e passano **sigillati**: il rimbalzo li sposta e non
   può aprirli, perché la chiave sta solo nel telefono e nel Mac. Vede però i
   due indirizzi insieme, e quanti byte e quando. Il rimbalzo è **spento**
   finché non lo accendi tu: senza, il ponte funziona esattamente come prima.

Se questo servizio sparisse mentre stai scrivendo, non te ne accorgeresti fino
al collegamento successivo. Se invece sparisse il **rimbalzo** mentre stai
usando l'app dal 5G, il collegamento cadrebbe subito: è uno dei motivi per cui
sta in un container separato, e non dentro il ponte.

## Le due stanze

| stanza | nasce da | chi entra | cosa può fare |
|---|---|---|---|
| del Mac | il segreto del Mac (consegnato all'accoppiamento) | un telefono già accoppiato | tutto |
| del codice | le **otto cifre** mostrate sul Mac | chi legge il codice | **solo** accoppiarsi |

Da qui dentro le due stanze sono **indistinguibili**: due nomi opachi di 22
caratteri. Il codice non arriva mai, come non arriva mai il gettone.

## Cosa vede, e cosa no

| | |
|---|---|
| il nome della stanza | 128 bit che sembrano rumore: `HKDF(segreto)`, non si torna indietro |
| il contenuto delle buste | **niente**: `AES-256-GCM`, la chiave non arriva mai qui |
| chi si presenta | gli **indirizzi IP** delle due parti, e l'orario. Questo lo vede qualunque punto d'incontro |
| cosa può fare di male | **rifiutare il servizio**, e basta. Non può leggere, non può falsificare, non può mettersi in mezzo (l'impronta DTLS viaggia dentro la busta autenticata) |

Non scrive log dei corpi, non tiene niente più di 120 secondi, e ogni busta si
consegna una volta sola.

### Il freno

Otto cifre sono cento milioni di possibilità, ma la porta è pubblica: perciò
c'è un limite **per indirizzo di provenienza** (90 richieste al minuto) e **per
stanza** (40). Chi tenta codici a raffica si ferma lì; il traffico buono non se
ne accorge (un Mac fa ~1,3 richieste al minuto per stanza, un telefono ~2,5).
Oltre il limite: `429` con `Retry-After: 60`. Il conteggio sta in memoria per
un minuto e la chiave è l'indirizzo **accorciato** (`/24` per IPv4, `/64` per
IPv6): un indirizzo intero qui dentro non resta.

Perché il freno conti l'indirizzo **vero**, il proxy davanti deve sovrascrivere
`X-Forwarded-For` invece di accodarlo: il file `riflesso.caddy` lo fa già.

## Il rimbalzo: `/ice`

Dal 5G la strada diretta non esiste: l'operatore assegna una porta diversa per
ogni destinazione (NAT simmetrico) e i due non si trovano mai. La cura è un
rimbalzo TURN (`coturn`) sulla stessa macchina, in un **container separato**
(`coturn/`): sposta pacchetti già sigillati fra telefono e Mac e non può
aprirli, perché la chiave sta solo in quei due. Il ponte fa una cosa sola in
più: **conia la credenziale** per usarlo.

`GET /ice?room=<stanza>` risponde sempre `200` con:

```json
{ "iceServers": [ { "urls": ["stun:…", "stun:…", "stun:…"] } ], "relay": false, "ttl": 600 }
```

- **Senza** `TURN_HOST` e `TURN_SECRET` nell'ambiente (è com'è di default): la
  lista è **esattamente** quella di STUN che la pagina e il Mac hanno già
  dentro, e `relay` è `false`. Nessuna differenza per chi non accende niente.
- **Con** le due variabili, e solo se la stanza è **viva** — c'è un'attesa
  aperta a una sua cassetta (il Mac appeso alla `/m/…/o`), oppure ci è passata
  una busta negli ultimi 120 secondi — in coda alla lista compare il rimbalzo:

```json
{ "urls": ["turn:HOST:3478?transport=udp", "turn:HOST:3478?transport=tcp"],
  "username": "1788700000:kQ3xP_9a", "credential": "<base64 di HMAC-SHA1(segreto, username)>" }
```

  con `relay:true`. È la credenziale di TURN-REST (coturn `use-auth-secret`):
  il nome è `<scadenza unix>:<8 caratteri casuali>`, vive **600 secondi**
  (`ttl`), e gli otto caratteri servono perché coturn conta la quota per nome
  utente: senza, due telefoni nello stesso secondo si dividerebbero una quota
  sola e il rimbalzo smetterebbe di funzionare in silenzio.
- Stanza **morta**, mancante o storta: la risposta è **identica** a quella del
  rimbalzo spento. `/ice` non dice quali stanze esistono, e non dice nemmeno
  se il rimbalzo c'è: lo dice `/health`, col campo `relay` (vero se il ponte lo
  offre), che riguarda il ponte e non le stanze.

Il controllo sulla stanza viva va preso per quello che è. **Ferma chi trova
`/ice` senza leggere il codice; non ferma chi lo legge.** Il ponte è cieco per
costruzione e non distingue il Mac da uno sconosciuto: chiunque rende «viva» una
stanza a piacere con una richiesta in più — un byte posato con `POST
/m/<stanza>/o`, o una `GET …/o?w=45` come fa il Mac — e alla seconda richiesta
ottiene una credenziale che coturn accetta (provato il 04/09/2026). Il muro
contro l'abuso della sponda sono quindi **le quote e il freno di coturn**
(`coturn/turnserver.conf`: 12 sessioni per credenziale, 100 in tutto, 250 kB/s
a sessione, destinazioni private e la macchina stessa negate) e il freno di
`/ice`: **10 richieste al minuto** per indirizzo (accorciato come sopra), `429`
con `Retry-After: 60` — il telefono ne fa una all'avvio della pagina e la tiene
in tasca per metà della scadenza. Una porta che regga davvero vuole che sia il
Mac a dimostrare di esserci (una firma con la chiave della stanza, che il ponte
verifica senza aprire niente): è un lavoro sul Mac, non su questo file, e non è
ancora fatto.

Lo stesso controllo ha un rovescio: per una stanza morta la risposta è quella
del rimbalzo spento, quindi `/ice` **dice se in una stanza qualcuno ascolta**.
La stanza del codice il Mac la ascolta sempre, quindi chi prova codici può
chiedere `/ice` per la stanza di ogni codice senza che una busta arrivi al Mac,
10 volte al minuto per rete. Non è una porta nuova: la cassetta lo dice già
(un byte posato in `/m/<stanza>/o` e ricontrollato dice se il Mac l'ha preso),
a 45 tentativi al minuto per rete, cioè più in fretta. Il codice sono otto
cifre — cento milioni — e non ruota da solo: saperlo.

Il ponte **non fa nessuna chiamata in uscita** nemmeno così: l'HMAC lo calcola
da solo, e il recinto (`--allow-net=0.0.0.0:8080`, sola lettura) resta com'è.
Per accendere non si scrive niente a mano: `coturn/installa.sh` scrive
`coturn/.env` (segreto e `TURN_HOST` = l'IPv4 pubblico della **tua** macchina),
e il `docker-compose.yml` del ponte legge **quel** file con `env_file` — una
fonte sola per coturn e per il ponte. Senza il file il ponte parte col rimbalzo
spento; in tutti i casi scrive all'avvio com'è andata («rimbalzo (TURN): acceso
· turn:…» oppure «spento — …» con il motivo), e un valore storto lo spegne.

```bash
curl -s "https://ponte.example.com/ice?room=$STANZA"
# {"iceServers":[{"urls":["stun:…"]},{"urls":["turn:…"],"username":"…","credential":"…"}],"relay":true,"ttl":600}
```

## Metterlo sulla propria VPS

Servono Docker (con Compose) e un Caddy che faccia da ingresso HTTPS per la
macchina (se ne hai già uno per altri siti, va bene quello). Tutto sta in questa
cartella:

| file | cosa fa |
|---|---|
| `Dockerfile` | il processo Deno, `--allow-net` solo in ascolto sulla 8080: il ponte non fa **nessuna** chiamata in uscita |
| `docker-compose.yml` | il recinto: `mem_limit 256m`, `pids_limit 128`, `read_only`, `cap_drop ALL`, `no-new-privileges`, rete dedicata `riflesso-net` che non vede gli altri container |
| `riflesso.caddy` | il vhost: TLS automatico, `X-Forwarded-For` sovrascritto, log di accesso ruotati (7 giorni) |
| `public/` | la webapp, **copia** di `webapp/` in cima al repository — si rigenera con `tools/bridge-sync.sh` |

Passi:

```bash
# sulla VPS, con questa cartella copiata (o il repository clonato)
cd bridge

# 1. la rete dedicata: il ponte parla solo con Caddy
docker network create riflesso-net
docker network connect riflesso-net <nome-del-container-di-caddy>

# 2. il ponte
docker compose up -d --build
docker compose logs -f ponte      # deve restare zitto: non logga le richieste

# 3. il vhost: cambia la prima riga di riflesso.caddy col tuo dominio,
#    poi includilo nella configurazione di Caddy (import) e ricarica
```

Il DNS del dominio deve puntare alla VPS prima di ricaricare Caddy, così il
certificato viene emesso al primo colpo. Poi:

```bash
curl -s https://ponte.example.com/health
# {"ok":true,"app":"riflesso-bridge","kv":false,"single":true,"relay":false}
```

`single:true` vuol dire che gira come **processo unico**: la memoria in
process basta e le due parti si trovano sempre. (`kv` riguarda solo le
piattaforme serverless che sparpagliano le richieste fra isolati: qui non serve.)

Infine, sul Mac: pannello di Riflesso → riga **Ponte** → incolla
`https://ponte.example.com` → Salva. Da quel momento il QR porta lì, e sotto il
QR c'è scritto «vale da qualunque rete · ponte». Chi compila Riflesso per sé
può anche metterlo in `host-mac/local.env` (`RIFLESSO_BRIDGE`), così la build
lo ha già.

### Aggiornare la webapp dentro il ponte

La pagina che il ponte serve deve essere **la stessa** che serve il Mac. Dopo
ogni modifica a `webapp/`:

```bash
tools/bridge-sync.sh              # copia webapp/ in bridge/public/
cd bridge && docker compose up -d --build
```

## Il rimbalzo (coturn), spento finché non lo accendi

Dal 5G la strada diretta non esiste: l'operatore mette il telefono dietro un
NAT **simmetrico** (misurato il 04/09/2026: tre STUN, stesso indirizzo, tre
porte diverse), e senza una sponda i due non si trovano. La sponda è un
`coturn` standard, in un container **suo** nella cartella `coturn/`, che
rimbalza pacchetti già sigillati fra telefono e Mac. Non può leggerli: la
chiave DTLS sta nei due estremi e la pagina ricontrolla l'impronta dentro la
busta autenticata (`net.js`), quindi una sponda che provasse a mettersi in
mezzo farebbe **fallire** il collegamento invece di leggerlo.

Cosa vede, in più rispetto al ponte: i due indirizzi **insieme** nella stessa
sessione, e quanti byte passano e quando (da 6 KB si legge «ha aperto l'app»,
da 4 MB «ha guardato una foto»). Cosa non copre: le reti che aprono solo la
443 — lì c'è Caddy con gli altri siti, e non ci si va. Niente TLS (niente 5349):
avrebbe voluto il magazzino dei certificati di Caddy, cioè le chiavi private di
tutti i siti della macchina, in mano a un demone esposto su Internet. Chi sta
su una rete che vuole vedere del TLS resta senza rimbalzo, e lo si dice.

| file (in `coturn/`) | cosa fa |
|---|---|
| `turnserver.conf` | il **modello** della configurazione: un solo indirizzo (l'IPv4 pubblico), porte 3478 e 49200-49400, credenziali a scadenza, quote, freno a 250 kB/s, e il recinto degli indirizzi negati. Non si lancia così com'è: i due segnaposto lo fanno abortire, apposta |
| `installa.sh` | genera il segreto, **calcola** i due indirizzi pubblici della macchina e li scrive al posto dei segnaposto → `turnserver.local.conf` e `.env`, tutti e due fuori dal repository. Poi stampa i comandi che restano, senza eseguirli |
| `docker-compose.yml` | il recinto: `network_mode: host` (**mai** `ports:`), `mem_limit 128m`, `read_only`, `cap_drop ALL`, `no-new-privileges`, utente `nobody`, il segreto da `.env`, un solo montaggio in sola lettura e nessun volume di altri container |
| `.env.example` | le tre variabili, con la spiegazione di chi le legge |

### Perché gli indirizzi li calcola lo script

Le ultime due righe della configurazione negano come destinazione del
rimbalzo **la macchina stessa**, IPv4 e IPv6. Senza, chi ha una credenziale
può puntare coturn contro la sua stessa VPS (ssh sulla 22 attraverso l'IPv6
pubblico, per esempio), e un `fail2ban` che vede martellare farebbe bandire
l'indirizzo della macchina a sé stessa: chiusi fuori dal proprio SSH, senza
capire perché. Un file versionato con dentro l'indirizzo di **una** macchina
proteggerebbe quella e lascerebbe scoperte tutte le altre. Per questo nel
repository ci sono segnaposto, e li riempie `installa.sh` leggendo la macchina.

### Metterlo su

```bash
cd bridge/coturn

# 1. il segreto e gli indirizzi di QUESTA macchina (→ .env e turnserver.local.conf)
./installa.sh
#    controlla i due indirizzi che stampa: sono l'IPv4 e l'IPv6 pubblici della
#    macchina? Se no: ./installa.sh --ipv4 X --ipv6 Y (o --senza-ipv6)

# 2. il container. MAI aggiungere `ports:` al compose: le porte pubblicate da
#    Docker scavalcano il firewall e la 3478 sarebbe aperta al mondo senza
#    comparire nell'elenco delle porte aperte
docker compose up -d
docker compose logs -f rimbalzo     # «Listener address to use: <il tuo IPv4>», e nient'altro

# 3. le tre regole del firewall, a mano e SOLO IPv4. Su una macchina con
#    IPV6=yes ogni regola nuda ne creerebbe due: coturn parla solo IPv4, e la
#    regola IPv6 non va aperta. (installa.sh le stampa già con l'indirizzo giusto)
ufw allow proto udp from any to <IPv4-della-macchina> port 3478
ufw allow proto tcp from any to <IPv4-della-macchina> port 3478
ufw allow proto udp from any to <IPv4-della-macchina> port 49200:49400

# 4. il ponte legge da solo lo stesso .env (il suo docker-compose.yml ha già
#    `env_file: coturn/.env`, facoltativo): basta rilanciarlo dalla cartella
#    del ponte, e controllare che lo dica
cd .. && docker compose up -d --build
docker compose logs ponte | grep rimbalzo     # «rimbalzo (TURN): acceso · turn:<IPv4>:3478»
curl -s https://ponte.example.com/health      # … "relay":true
```

Da quel momento `/ice` consegna il rimbalzo per una stanza «viva» — con il
valore che quel controllo ha davvero, detto sopra.

3478/UDP è l'unica porta che serve davvero (è da lì che passa il 5G);
3478/TCP è per le reti che buttano giù l'UDP. Le 49200-49400/UDP sono le porte
da cui escono i rimbalzi: 201 porte, quindi al massimo 201 sessioni.

Da sapere: il segreto passa a coturn sulla riga di comando, quindi lo legge
chi può leggere la riga di comando dei processi della macchina. Da solo vale
poco — serve anche il nome di una stanza viva — ma se la macchina è condivisa
con altri utenti, saperlo.

### Il collaudo

```bash
node tools/icecheck.js --turn --local   # sul Mac: coturn (brew install coturn) e due ponti accesi qui
node tools/icecheck.js --turn           # contro la VPS: legge bridge/coturn/.env, RIFLESSO_BRIDGE=https://…
```

Prova, e fallisce se non è così: l'allocazione nei suoi due giri (UDP e TCP),
credenziale sbagliata e scaduta rifiutate, allocazione IPv6 rifiutata, permessi
verso le reti private e verso **i due indirizzi della macchina** rifiutati,
permesso verso `8.8.8.8` concesso (è la superficie che resta: una sponda verso
Internet, frenata), `/ice` per una stanza morta senza rimbalzo, `/ice` senza le
variabili uguale alla lista di oggi, e — con `--local` — la catena intera:
stanza viva → credenziale del ponte → allocazione vera su coturn.

Due trappole, per chi rifà le prove nel browser: con coturn su `127.0.0.1` il
browser **butta via il candidato di rimbalzo in silenzio** (va messo
sull'indirizzo dell'interfaccia di rete, come fa `installa.sh`); e su una
macchina sola, coi nomi automatici delle reti locali accesi (`xxxx.local`), la
coppia fallisce per l'mDNS e sembra una bocciatura del rimbalzo. Non lo è.

I collaudi verdi non dimostrano niente dal 5G: la prova vera è col telefono in
mano, wifi spento, e la riga di stato dell'app che dice «rimbalzo»
(`FUORI-SOLUZIONE.md`, «Come si prova che funziona davvero dal 5G»).

## Provarlo in locale, senza VPS

```bash
PORT=8787 BIND=127.0.0.1 deno run --allow-net=0.0.0.0:8787,127.0.0.1:8787 --allow-read --allow-env bridge/main.ts
node --experimental-websocket tools/remotetest.js
```

`remotetest.js` fa tutto da solo: ponte in locale, Chrome nel ruolo del
telefono, e **un registratore in mezzo** che mostra cosa vede il servizio —
serve a dimostrare che non vede niente. Copre tutte e due le stanze, compreso
l'accoppiamento fatto col solo codice. `tools/solocasatest.js` prova invece le
due strade insieme, casa e ponte, e l'elenco che arriva in spinta.
