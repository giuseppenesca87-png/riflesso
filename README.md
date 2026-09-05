# Riflesso

*Your Claude conversations, from your phone.* Riflesso is a small macOS
menu-bar app plus a web page: the phone opens the page, sees the same chats
that sit in Claude Desktop's sidebar, and keeps writing in them — the message is
delivered into Claude Desktop on the Mac and sent from there. It works on your
home network and, through a bridge you host yourself, from anywhere else. No
account, no cloud, no third-party service: the only server involved is one you
own. The interface is in English and Italian; this README and the code comments
are in Italian.

---

Le tue **conversazioni Claude**, sul telefono. Si apre la pagina, si vede
l'elenco delle chat, si entra in una e **si continua a parlare lì dentro** —
come una chat qualunque, ma sulle conversazioni che esistono già nella barra
laterale di Claude Desktop.

Il messaggio parte dal telefono e viene **consegnato dentro Claude Desktop sul
Mac**, nella stessa conversazione, e mandato da lì: lavora il Desktop, quindi
sul Mac si vede tutto in tempo reale e non si apre nessuna conversazione nuova.
Le risposte arrivano sul telefono mentre si formano.

Due pezzi, più uno facoltativo:

- **`host-mac/`** — l'app per il Mac, nella barra dei menu. Legge le
  conversazioni, serve la pagina al telefono, consegna i messaggi a Claude.
- **`webapp/`** — la pagina che si apre da Safari sul telefono. Servita
  dall'app stessa: niente store, niente installazione, niente npm.
- **`bridge/`** — il ponte, facoltativo: un piccolo servizio da mettere su una
  macchina propria, per quando si è fuori casa.

Nessun account, nessun servizio di terzi, nessun token estratto da Claude. Le
conversazioni si leggono dai file che Claude tiene già sul disco; l'unica
scrittura passa da Claude Desktop (o, di riserva, dal comando `claude`).

---

## 1. Le due strade

Il telefono arriva al Mac per una di due strade, e **l'app sa da quale —
dicendolo sempre**, sul Mac e sul telefono. Mai un ripiego silenzioso.

| dove sei | strada | indirizzo |
|---|---|---|
| in casa | **rete locale** | `http://<mac>.local:7654` — la più veloce, non esce di casa, non serve Internet |
| fuori | **ponte** | `https://<il-tuo-ponte>` — la pagina arriva dal ponte e telefono e Mac si parlano direttamente in WebRTC, da qualunque rete, senza VPN |
| fuori, dove il diretto non passa | **ponte + rimbalzo** | come sopra, ma i byte rimbalzano su un `coturn` sulla tua stessa macchina. Serve con il 5G, che assegna una porta diversa per ogni destinazione e rende impossibile il collegamento diretto. È **spento** finché non lo accendi tu |

**Il QR sul Mac porta a un indirizzo che funziona da qualunque rete**: il ponte
se l'hai configurato, altrimenti l'indirizzo di casa — e in quel caso sotto il
QR c'è scritto che vale solo lì.

**A ogni apertura la pagina chiede a chi la sta servendo se è il Mac**
(`/health`): se sì, parla con lui diretto, senza tubo — anche dietro un inoltro
qualunque. Se la pagina arriva dal ponte, apre il collegamento diretto col Mac
e scrive anche quello — e se in casa, WebRTC sceglie da solo la coppia di
indirizzi locali: «ponte · in casa».

Sul telefono la strada è scritta sotto il codice, nella riga di stato
dell'elenco e nella diagnostica (⋯ → in fondo). Sul Mac, sotto il QR e nella
scheda **Come arriva il telefono**, che cresce da sola dove manca qualcosa.

---

## 2. Requisiti

- macOS 14 o più recente, Apple Silicon o Intel.
- **Claude Desktop** installato e con l'accesso fatto (è lui a rispondere). In
  sua assenza l'app ripiega sul comando `claude` (Claude Code), se c'è.
- Xcode 26 / Swift 6 per compilare. Nessun'altra dipendenza: niente SPM esterni,
  niente npm.
- **macOS 26** per la dettatura dal telefono (il Mac trascrive con il motore di
  sistema, tutto sul dispositivo). Su un macOS precedente tutto il resto
  funziona, e resta la dettatura della tastiera del telefono.
- Facoltativi: una **VPS con Docker e Caddy** (ponte), **Node 22** e **Deno**
  solo per i collaudi.

---

## 3. Compilare e installare

```bash
# facoltativo, ma consigliato: le cose personali della build
cp host-mac/local.env.example host-mac/local.env
#   RIFLESSO_BUNDLE_ID  l'identità dell'app (scegline una e non cambiarla più)
#   RIFLESSO_IDENTITY   la tua identità di firma nel portachiavi
#   RIFLESSO_BRIDGE     l'indirizzo del tuo ponte, se ne hai uno

./host-mac/build.sh --install
open -a Riflesso
```

`build.sh` compila, impacchetta `Riflesso.app`, la firma e la copia in
`/Applications`. Compare un'icona nella **barra dei menu** (un iPhone). Non c'è
icona nel Dock e non c'è finestra: è voluto. Se la barra è piena e l'icona non
trova posto, riaprendo l'app (Spotlight, Finder) il pannello compare come
finestra.

**Sull'identità dell'app.** macOS lega a `CFBundleIdentifier` i permessi e le
preferenze: una volta installata, **non cambiarla più**, altrimenti va
riconcessa l'Accessibilità e spariscono i telefoni accoppiati. Il valore neutro
è `app.riflesso.host`; chi ne vuole uno proprio lo mette in `local.env`
**prima** della prima installazione.

**Sulla firma.** Senza un'identità di firma vera (`RIFLESSO_IDENTITY`) la firma
è ad-hoc e il permesso di Accessibilità si azzera a ogni ricompilazione. Per
usarla e basta non importa; per lavorarci conviene un'identità *Apple
Development* del proprio account.

L'app si registra da sola fra gli elementi di apertura al login (una volta
sola: se poi la togli, non si rimette).

---

## 4. Permessi, e perché

| permesso | serve a | chiesto quando |
|---|---|---|
| **Accessibilità** | consegnare il messaggio dentro il compositore di Claude Desktop e premere Invio, muovere il cursore dell'impegno, premere Esc per fermare. Senza, si legge ma non si scrive dal telefono | dal pannello, pulsante **Concedi** (Impostazioni di Sistema → Privacy e sicurezza → Accessibilità) |
| **Rete locale** | far trovare la pagina ai telefoni sulla rete di casa | dal sistema, al primo avvio |

Nient'altro. Non serve la Registrazione schermo (lo specchio dello schermo è
stato tolto), non serve la fotocamera, non serve il microfono. Il pannello mostra
il permesso con una spunta verde quando è a posto.

---

## 5. Collegare il telefono

1. Apri Riflesso sul Mac: nel pannello c'è un **QR** e, accanto, un **codice di
   8 cifre**. Sotto il QR c'è scritto **dove porta** (ponte, o solo casa).
2. Inquadra il QR con la fotocamera del telefono: si apre la pagina **già
   compilata**. Oppure apri l'indirizzo scritto sotto e batti le otto cifre.
3. Fatto. Il telefono resta collegato anche dopo aver riavviato Mac o app. Il
   codice resta valido finché non lo cambi (**Nuovo codice**); dopo cinque
   tentativi sbagliati si brucia da solo e ne compare un altro.

**Aggiungi alla schermata Home** (condividi → *Aggiungi a Home*): si apre a
schermo intero. Conviene farlo dall'indirizzo che il QR usa, così vale ovunque.

Per staccare un telefono: dal telefono, ⋯ → **Dimentica questo dispositivo**.
Per staccare tutto: pannello sul Mac → **Scollega tutti** (due tocchi).

**Dettare invece di scrivere.** Nella conversazione, fra il ＋ e il campo di
scrittura, c'è il tasto del microfono: si registra sul telefono, il Mac
trascrive **sul Mac** (macOS 26, motore di sistema, niente esce dal Mac) e il
testo compare nel campo, da rileggere prima di mandarlo. Il tasto c'è dove la
pagina è in https (dal ponte); sulla rete di casa la pagina è in http e il
browser non dà il microfono, quindi lì il tasto non c'è — ma la **dettatura
della tastiera** del telefono scrive nello stesso campo, dappertutto. Le
Impostazioni (⋯) lo dicono.

---

## 6. Il ponte (fuori casa)

Per quando sei fuori casa — da qualunque rete, senza installare niente sul
telefono. Sta su una macchina **tua**; non esiste un ponte pubblico
predefinito e da fuori dal codice non parte nessuna chiamata verso server che
non siano tuoi.

Le istruzioni complete, con `docker-compose.yml` e il vhost per Caddy già
scritti con tutte le protezioni (recinto di memoria e processi, sola lettura,
nessuna capability, rete dedicata, nessuna chiamata in uscita, freno contro i
tentativi a raffica), stanno in **[`bridge/README.md`](bridge/README.md)**.

In due parole: `docker compose up -d --build`, il vhost in Caddy col tuo
dominio, e poi l'indirizzo nel pannello di Riflesso, riga **Ponte**.

Cosa vede il ponte: gli indirizzi IP di chi si presenta e la dimensione di due
buste cifrate per collegamento. Cosa non vede: il codice, il gettone, le
conversazioni, gli allegati — tutto passa da telefono a Mac direttamente.

**Quando il diretto non passa, invece, i byte passano di lì.** Succede con il
5G, che assegna una porta diversa per ogni destinazione: il collegamento
diretto non si apre e serve un **rimbalzo** (`coturn`, in un container a parte,
sulla stessa macchina). I byte passano **sigillati** — il rimbalzo li sposta e
non può aprirli, perché la chiave sta solo nel telefono e nel Mac — ma la
macchina vede **i due indirizzi insieme**, e quanti byte e quando. Il rimbalzo
è spento finché non lo accendi tu: senza, il ponte funziona esattamente come
prima. Istruzioni in [`bridge/coturn/`](bridge/coturn/).

Una nota sul dimensionamento: **qualche kilobyte per collegamento**, ma
**qualche megabyte** se accendi il rimbalzo. E se il ponte sparisse mentre stai
scrivendo non te ne accorgeresti fino al collegamento dopo; se sparisse il
**rimbalzo** mentre stai usando l'app dal 5G, il collegamento cadrebbe subito —
è uno dei motivi per cui sta in un container separato.

---

## 7. Sicurezza, in breve

- La porta 7654 accetta connessioni **solo da indirizzi privati** (rete di
  casa, link-local, loopback, e l'intervallo `100.64/10` delle VPN personali).
- Il **codice di accoppiamento non si legge via rete**: lo mostra il pannello,
  e per i collaudi lo dà `Riflesso --print-pin` attraverso un socket Unix
  riservato all'utente. Non esiste un endpoint HTTP che lo restituisca, e la
  pagina ponte si rifiuta comunque di inoltrarne uno.
- Otto cifre, tentativi contati, codice che si brucia dopo cinque errori; sul
  ponte, freno per indirizzo e per stanza.
- Il gettone di un telefono vive nel browser, **per origine**: quello del ponte
  e quello di casa sono due cassetti separati. Il codice letto dal QR viaggia
  dopo il cancelletto dell'indirizzo, che il browser non spedisce a nessun
  server.
- L'audio dettato sale sul Mac come un allegato, si trascrive sul Mac e si
  cancella subito dopo: non entra in Claude e non va a nessun servizio.
- Dal telefono la modalità permessi di Claude è sempre quella normale: un
  comando che chiede conferma si ferma, perché davanti al Mac non c'è nessuno a
  darla.
- Spegnendo il servizio dal pannello, il Mac chiude la porta, chiude il ponte e
  scollega i telefoni: da spento non fa nessuna chiamata a Internet.

---

## 8. Collaudi

Node 22 (`WebSocket` nativo) e Google Chrome. Il codice lo chiedono da soli a
`Riflesso --print-pin`. Tutti contro l'app installata e accesa.

```bash
node tools/uitest.js          # la webapp in Chrome a misura di iPhone: elenco, conversazione, markdown, il tasto della voce
node tools/allegatest.js      # gli allegati a pezzi, identici al byte, con i rifiuti giusti
node tools/vocetest.js        # la dettatura: una voce vera di macOS trascritta sul Mac, e i rifiuti con un codice
node tools/pesotest.js        # quanto viaggia: gzip, ETag e 304, con i numeri
node tools/solocasatest.js    # le due strade e l'elenco in spinta (serve deno)
node tools/remotetest.js      # il ponte in locale, con un registratore in mezzo che mostra cosa vede
node tools/pontetest.js       # il ponte vero, quello scritto nel pannello: accoppiamento e diretta da lì
./tools/autotest.sh           # tutto insieme, compreso un invio vero su una sessione di prova
```

Ogni collaudo si accoppia con una identità fissa e si scollega da solo alla
fine: non lascia dispositivi fantasma nel pannello.

---

## 9. Cosa non fa, detto chiaro

- **Non crea conversazioni nuove**: si risponde dentro quelle che esistono già.
  Modello e impegno si cambiano dal telefono (⋯ nella conversazione).
- **Per consegnare, Claude viene un attimo davanti sul Mac**: i tasti arrivano
  solo alla finestra attiva. Se in quel momento stai usando il Mac, l'invio
  aspetta e te lo dice, invece di scriverti sopra.
- **Senza Claude Desktop aperto** si torna al motore di riserva (`claude
  --resume`): la conversazione va avanti, ma sul Mac si vedrà solo riaprendola —
  e l'app lo dice.
- Le conversazioni il cui testo non è più sul disco sono elencate in grigio e
  non si aprono.
- **Dal ponte, su certe reti non si passa** (NAT simmetrico da tutte e due le
  parti, reti aziendali che bloccano UDP). Il rimbalzo (TURN) è spento di
  proposito: costerebbe in proporzione a chi usa l'app. Quando non si passa,
  l'app lo scrive.
- Non si cancellano né si archiviano conversazioni.

---

## 10. Com'è fatto, in breve

```
host-mac/Sources/RiflessoHost/
  Server.swift, HTTP.swift, WebSocketCodec.swift   server HTTP e WebSocket scritti a mano su Network.framework
  AppHub.swift                                     le rotte dell'API e la diretta
  Auth.swift, PinSocket.swift, PinClient.swift     codice, gettoni, il socket di --print-pin
  Strade.swift, RemoteLink.swift                   le due strade: la scelta del QR e il ponte
  Trascrizione.swift                               la dettatura, trascritta sul Mac
  Transcript*.swift, ChatList.swift, SessionsIndex.swift   la lettura delle conversazioni dai file di Claude
  DesktopBridge.swift, InputInjector.swift, ChatSender.swift   la consegna dentro Claude Desktop (e il ripiego CLI)
  MenuBarUI.swift, main.swift, L.swift             il pannello, in due lingue
webapp/
  index.html, app.js, style.css, i18n.js           la pagina del telefono, senza dipendenze
  net.js, tunnel.js                                il trasporto: casa, ponte (WebRTC)
  host-bridge.html, host-bridge.js                 la pagina ponte che gira dentro il Mac, in una WKWebView
bridge/
  main.ts, Dockerfile, docker-compose.yml, riflesso.caddy   il punto d'incontro, per la tua macchina
tools/
  i collaudi (Chrome pilotato dal protocollo di debug) e gli attrezzi
```

Le conversazioni stanno già su disco in due posti che l'app mette insieme:
`~/Library/Application Support/Claude/claude-code-sessions/…/local_<uuid>.json`
(titolo, modello, cartella) e `~/.claude/projects/<cartella>/<id>.jsonl` (il
testo, un blocco JSON per riga). L'host legge il `.jsonl` **dal fondo**, a pezzi,
e riduce ogni riga a quello che serve alla vista: il telefono non vede mai JSON
grezzo, e un transcript da un gigabyte si apre in pochi centesimi di secondo.

---

## Licenza

MIT — vedi `LICENSE`.
