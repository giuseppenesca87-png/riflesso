/*
  Riflesso — il punto d'incontro.

  Fa due cose e nient'altro:

  1. serve la webapp in HTTPS, perché fuori casa il telefono non può prenderla
     dal Mac (e senza HTTPS non esiste nemmeno WebRTC: vuole un contesto sicuro);
  2. tiene due cassette per stanza in cui telefono e Mac si lasciano **una busta
     opaca** a testa, per meno di due secondi.

  Cieco per costruzione:
  · il nome della stanza è HKDF(segreto) — 128 bit che sembrano rumore, e da cui
    non si torna indietro al segreto;
  · la busta è AES-256-GCM con una chiave che qui dentro non arriva mai: non si
    può leggere, non si può modificare, non si può fabbricare;
  · le buste si consegnano una volta sola e scadono comunque da sole;
  · non si registra niente: né corpi, né stanze, né indirizzi.

  Quello che resta visibile — gli indirizzi IP di chi si presenta, l'orario, la
  dimensione delle buste — lo vedrebbe qualunque punto d'incontro, anche uno
  scritto da noi su un server nostro. Sta scritto in docs/10-FUORICASA.md §4.

  Il segreto è il **segreto del Mac** (una stanza per tutti i suoi telefoni)
  oppure il **codice** a otto cifre, che è la stanza in cui ci si accoppia da
  qualunque rete. Qui dentro non cambia niente: sono due stanze uguali, due
  nomi opachi. È per la seconda che serve il freno qui sotto.

  Come si mette sulla propria macchina: README.md qui accanto (docker compose
  e un vhost di Caddy, con le protezioni gia' scritte).
*/

const ROOM_RE = /^[A-Za-z0-9_-]{22}$/; // 16 byte in base64url
const SLOTS = new Set(["o", "a"]);     // offerta (telefono→Mac) · risposta (Mac→telefono)
const MAX_ENVELOPE = 64 * 1024;
const TTL_MS = 120_000;
const MAX_WAIT_S = 50;

/* ---------- la cassetta ----------------------------------------------------

   Deno KV quando c'è (le due parti possono finire su isolati diversi), memoria
   locale quando non c'è: così gira anche in locale e non muore se la
   piattaforma cambia idea sul KV.                                            */

interface Box {
  put(room: string, slot: string, body: Uint8Array): Promise<void>;
  take(room: string, slot: string): Promise<Uint8Array | null>;
  /** `signal` è quello della richiesta: quando chi aspettava se ne va, si
      smette di aspettare **prima** di prendere la busta. Senza, un'attesa
      abbandonata resta lì, si prende la busta appena arriva (la consegna è
      singola!) e la scrive dentro una connessione che non esiste più: la parte
      che sta ancora aspettando davvero non riceve niente. Successo davvero, e
      in modo intermittente — il peggiore dei modi. */
  wait(room: string, slot: string, seconds: number, signal?: AbortSignal): Promise<Uint8Array | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MemoryBox implements Box {
  #m = new Map<string, { body: Uint8Array; until: number }>();

  async put(room: string, slot: string, body: Uint8Array) {
    this.#m.set(room + "/" + slot, { body, until: Date.now() + TTL_MS });
    // Una passata di pulizia: senza, la memoria dell'isolato cresce piano.
    if (this.#m.size > 500) {
      const now = Date.now();
      for (const [k, v] of this.#m) if (v.until < now) this.#m.delete(k);
    }
  }

  async take(room: string, slot: string) {
    const k = room + "/" + slot;
    const v = this.#m.get(k);
    if (!v) return null;
    this.#m.delete(k);
    return v.until > Date.now() ? v.body : null;
  }

  async wait(room: string, slot: string, seconds: number, signal?: AbortSignal) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !signal?.aborted) {
      const v = await this.take(room, slot);
      if (v) return v;
      await sleep(200);
    }
    return null;
  }
}

class KvBox implements Box {
  constructor(private kv: Deno.Kv) {}

  #key(room: string, slot: string) {
    return ["m", room, slot];
  }

  async put(room: string, slot: string, body: Uint8Array) {
    await this.kv.set(this.#key(room, slot), body, { expireIn: TTL_MS });
  }

  async take(room: string, slot: string) {
    const k = this.#key(room, slot);
    const got = await this.kv.get<Uint8Array>(k);
    if (!got.value) return null;
    // Consegna singola: chi la prende la toglie.
    const ok = await this.kv.atomic().check(got).delete(k).commit();
    return ok.ok ? got.value : null;
  }

  /** `watch` è una spinta, non un sondaggio: una lettura per cambiamento
      invece di una ogni 200 ms. Sul piano gratuito è la differenza fra
      starci dentro e non starci. */
  async wait(room: string, slot: string, seconds: number, signal?: AbortSignal) {
    const first = await this.take(room, slot);
    if (first) return first;

    const k = this.#key(room, slot);
    const deadline = Date.now() + seconds * 1000;
    const alive = () => Date.now() < deadline && !signal?.aborted;
    try {
      const stream = this.kv.watch<Uint8Array[]>([k]);
      const reader = stream.getReader();
      if (signal) signal.addEventListener("abort", () => reader.cancel().catch(() => {}));
      try {
        while (alive()) {
          const timeout = sleep(Math.min(3000, deadline - Date.now())).then(() => null);
          const step = await Promise.race([reader.read(), timeout]);
          if (!alive()) return null;
          if (step && !step.done && step.value?.[0]?.value) {
            const v = await this.take(room, slot);
            if (v) return v;
          }
          // Anche senza spinta si ricontrolla ogni 3 s: rete di sotto, se la
          // busta è stata scritta in un'altra regione.
          const v = await this.take(room, slot);
          if (v) return v;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch {
      while (alive()) {
        const v = await this.take(room, slot);
        if (v) return v;
        await sleep(500);
      }
    }
    return null;
  }
}

let box: Box = new MemoryBox();
try {
  if (typeof Deno.openKv === "function") box = new KvBox(await Deno.openKv());
} catch {
  // Nessun KV: si resta in memoria. Funziona lo stesso finché le due parti
  // finiscono sullo stesso isolato, ed è il caso in locale.
}

/* ---------- il freno ---------------------------------------------------

   La stanza dell'accoppiamento nasce da un codice di otto cifre: cento milioni
   di possibilità. Chi volesse indovinarne uno dovrebbe, per ogni tentativo,
   posare una busta in una stanza diversa e stare a vedere se il Mac risponde —
   cioè fare **un giro di rete da qui**. Il freno serve a rendere quel giro
   lento abbastanza da non valere la pena: col limite qui sotto, da un solo
   indirizzo servirebbero secoli, e il codice intanto vive dieci minuti e si
   rinnova da solo.

   Due limiti diversi, perché fermano due cose diverse:
   · **per indirizzo di provenienza** — ferma chi prova tante stanze (è
     l'attacco vero: ogni codice tentato è una stanza nuova);
   · **per stanza** — ferma chi martella una stanza sola, per esempio per
     tenerla occupata o per far scadere le buste degli altri.

   Non si registra niente lo stesso: in memoria restano un conteggio e un
   orario, per un minuto, e la chiave è l'indirizzo **accorciato** (niente
   `/32`: basta la rete). Il traffico buono non se ne accorge — un Mac fa ~1,3
   richieste al minuto per stanza, un telefono ~2,5.

   Su Deno Deploy gli isolati sono più d'uno, quindi il conteggio è per isolato:
   è un freno, non un muro. Il muro sono le otto cifre e i tentativi contati
   sul Mac. */

const RATE_WINDOW_MS = 60_000;
const PER_IP = 90;       // richieste al minuto da uno stesso indirizzo
const PER_ROOM = 40;     // richieste al minuto verso una stessa stanza

const hits = new Map<string, { n: number; until: number }>();

function tooFast(key: string, limit: number): boolean {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || cur.until < now) {
    hits.set(key, { n: 1, until: now + RATE_WINDOW_MS });
    // Una passata di pulizia ogni tanto: senza, la mappa cresce piano.
    if (hits.size > 5000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
    return false;
  }
  cur.n++;
  return cur.n > limit;
}

/** Chi sta bussando. Dietro la piattaforma l'indirizzo vero è il primo salto di
    `x-forwarded-for`; in locale (le prove) c'è solo `remoteAddr`. Si accorcia
    subito: per contare basta la rete, e così qui dentro non passa mai un
    indirizzo intero. */
function origin(req: Request, info?: Deno.ServeHandlerInfo): string {
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const addr = info?.remoteAddr;
  const raw = fwd || (addr && "hostname" in addr ? addr.hostname : "") || "?";
  if (raw.includes(":")) return raw.split(":").slice(0, 4).join(":");   // IPv6: /64
  return raw.split(".").slice(0, 3).join(".");                          // IPv4: /24
}

/* ---------- il rimbalzo (TURN) -----------------------------------------

   Dal 5G la strada diretta non esiste: l'operatore assegna una porta diversa
   per ogni destinazione (NAT simmetrico, misurato il 04/09/2026 con tre srflx
   dallo stesso indirizzo e tre porte diverse), e i due non si trovano mai.
   Allora i pacchetti — già sigillati fra telefono e Mac, la chiave qui non
   arriva — rimbalzano su un coturn nostro, in un container suo, separato da
   questo (`coturn/`). La rotta `/ice` qui sotto conia la credenziale per
   usarlo; il ponte resta cieco come prima, vede solo qualche byte in più.

   **Spento per costruzione.** Senza `TURN_HOST` e `TURN_SECRET` la rotta
   restituisce **esattamente** la lista di STUN che la pagina (`net.js`) e il
   Mac (`RemoteLink.swift`) hanno già dentro, e `relay:false`. Chi non accende
   il rimbalzo non vede nessuna differenza, e non c'è un secondo percorso di
   codice da mantenere.

   **La porta d'ingresso — e quanto vale davvero.** La credenziale si dà solo
   per una stanza **viva**: c'è un'attesa aperta a una sua cassetta (il Mac sta
   appeso lì, 50 secondi alla volta), oppure ci è passata una busta negli ultimi
   120 secondi. Va detto chiaro cosa ferma e cosa no. Ferma chi trova `/ice`
   senza leggere il codice. **Non ferma chi lo legge**: il ponte è cieco per
   costruzione e non distingue il Mac da uno sconosciuto, quindi chiunque rende
   «viva» una stanza a piacere con una richiesta in più — `POST /m/<stanza>/o`
   con un byte, o una `GET …/o?w=45` come fa il Mac — e alla seconda richiesta
   ottiene la credenziale (provato il 04/09/2026 contro un coturn vero). Il muro
   contro l'abuso della sponda sono le quote e il freno di coturn
   (`coturn/turnserver.conf`: 12 sessioni per credenziale, 100 in tutto,
   250 kB/s, destinazioni private e la macchina stessa negate) e il freno di
   questa rotta, non questo controllo. Una porta che regga vuole che sia il Mac
   a dimostrare di esserci — una firma con la chiave della stanza, che il ponte
   verifica senza aprire niente — ed è la TAPPA 2 (`RemoteLink.swift`), che non
   si fa da qui.

   Lo stesso controllo ha un rovescio. Per una stanza morta la risposta è la
   lista di oggi e `relay:false`, quindi `/ice` dice **se in quella stanza
   qualcuno ascolta**. La stanza del codice il Mac la ascolta sempre: chi prova
   codici può chiedere `/ice` per la stanza di ogni codice e leggere la risposta
   senza che una sola busta arrivi al Mac — 10 tentativi al minuto per rete (il
   freno qui sotto), e sul Mac non compare niente. Non è una porta nuova: la
   cassetta lo dice già — chi posa un byte in `/m/<stanza>/o` e lo ricontrolla
   vede se il Mac l'ha preso — a 45 tentativi al minuto per rete, cioè più in
   fretta di qui. Chiudere `/ice` da solo non cambierebbe il conto: chiuderlo
   davvero vuol dire non far dipendere la risposta dalla presenza del Mac (cioè
   togliere la porta) o far ruotare il codice, che qui non si tocca. Anche
   questo è scritto nel README, perché chi installa lo sappia.

   **La credenziale** è quella di TURN-REST (coturn con `use-auth-secret`):
   nome `<scadenza unix>:<8 caratteri casuali>`, password
   `base64(HMAC-SHA1(segreto, nome))`, 600 secondi di vita. Gli otto caratteri
   non sono decorazione: coturn conta la quota **per nome utente**, e senza di
   essi due telefoni che chiedono nello stesso secondo si dividerebbero una
   quota sola — e il rimbalzo smetterebbe di funzionare in silenzio, senza un
   errore da nessuna parte.

   Nessuna chiamata in uscita: l'HMAC si calcola qui, con WebCrypto. Il recinto
   (`--allow-net=0.0.0.0:8080`, sola lettura, permessi tolti) resta com'è. */

/** La lista di oggi, uguale a `webapp/net.js` e `RemoteLink.swift`: tre STUN di
    tre padroni diversi. Se cambia lì, cambia anche qui. */
const ICE_DEFAULT = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.nextcloud.com:3478", "stun:stun.sipgate.net:3478"] },
];

const TURN_TTL_S = 600;     // vita della credenziale; il telefono la tiene in tasca per metà
const ICE_PER_IP = 10;      // richieste al minuto a /ice da uno stesso indirizzo
const ALIVE_MS = 120_000;   // una busta passata da meno di così tiene viva la stanza
// Il Mac riapre l'attesa subito dopo la scadenza dei 50 s: fra la fine di una
// e l'inizio dell'altra c'è un varco di qualche millisecondo. Un telefono che
// chiedesse proprio lì troverebbe la stanza «morta» e resterebbe senza
// rimbalzo, in silenzio. Un'attesa chiusa da meno di così conta ancora.
const REARM_MS = 5_000;

/** `TURN_HOST` è un nome o un IPv4, con `:porta` facoltativa (3478 se manca,
    e comunque fra 1 e 65535). Si controlla una volta all'avvio: un valore
    storto finirebbe dentro un URL consegnato al telefono, meglio spegnere il
    rimbalzo e dirlo sul terminale. **Si dice sempre com'è andata**, anche
    quando è spento: due variabili presenti ma vuote (un `.env` che manca, un
    `env_file` sbagliato) spegnevano il rimbalzo in silenzio, e dal telefono si
    vedeva solo «rimbalzo muto» senza un errore da nessuna parte. Il segreto non
    si scrive mai. */
const TURN = (() => {
  const rawHost = Deno.env.get("TURN_HOST");
  const rawSecret = Deno.env.get("TURN_SECRET");
  const host = (rawHost ?? "").trim();
  const secret = (rawSecret ?? "").trim();
  const spento = (perche: string) => {
    console.error(`rimbalzo (TURN): spento — ${perche}`);
    return null;
  };
  if (rawHost === undefined && rawSecret === undefined) {
    return spento("TURN_HOST e TURN_SECRET non sono nell'ambiente (è così di default: il ponte funziona come prima)");
  }
  if (!host || !secret) {
    return spento(`TURN_HOST ${host ? "c'è" : "manca o è vuoto"}, TURN_SECRET ${secret ? "c'è" : "manca o è vuoto"}: servono tutti e due (coturn/installa.sh scrive coturn/.env)`);
  }
  const m = host.match(/^([A-Za-z0-9.-]+?)(?::(\d{1,5}))?$/);
  if (!m) return spento(`TURN_HOST «${host}» non è un nome o un IPv4 con :porta facoltativa`);
  const port = Number(m[2] ?? "3478");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return spento(`porta «${m[2]}» fuori da 1..65535`);
  console.error(`rimbalzo (TURN): acceso · turn:${m[1]}:${port} · credenziali da ${TURN_TTL_S} s`);
  return { host: m[1], port, secret };
})();

/** La chiave HMAC si importa una volta sola: il segreto non cambia finché il
    processo vive, e importarla a ogni richiesta sarebbe lavoro buttato. */
const turnKey: Promise<CryptoKey> | null = TURN
  ? crypto.subtle.importKey("raw", new TextEncoder().encode(TURN.secret),
                            { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
  : null;

async function turnServer() {
  // 6 byte casuali → 8 caratteri base64url, senza «:» (è il separatore del nome).
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  const tag = btoa(String.fromCharCode(...rnd)).replace(/\+/g, "-").replace(/\//g, "_");
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${tag}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await turnKey!, new TextEncoder().encode(username)));
  const credential = btoa(String.fromCharCode(...mac));
  const at = `${TURN!.host}:${TURN!.port}`;
  // UDP prima (è quella che serve dal 5G), TCP per le reti che buttano giù
  // l'UDP. Niente `turns:`: non c'è TLS, per scelta (README, «Il rimbalzo»).
  return { urls: [`turn:${at}?transport=udp`, `turn:${at}?transport=tcp`], username, credential };
}

/* Chi c'è in ogni stanza, adesso. Non è un registro: in memoria restano un
   contatore di attese aperte e due orari, e la voce sparisce alla pulizia
   appena la stanza tace. Le stanze le vede già la cassetta: qui non si
   aggiunge niente a quello che il ponte sapeva. */
interface Presence { waits: number; envelope: number; waited: number }
const rooms = new Map<string, Presence>();

function presence(room: string): Presence {
  let p = rooms.get(room);
  if (!p) {
    p = { waits: 0, envelope: 0, waited: 0 };
    rooms.set(room, p);
    if (rooms.size > 5000) {
      const dead = Date.now() - ALIVE_MS;
      for (const [k, v] of rooms) if (v.waits === 0 && v.envelope < dead && v.waited < dead) rooms.delete(k);
    }
  }
  return p;
}

function alive(room: string): boolean {
  const p = rooms.get(room);
  if (!p) return false;
  const now = Date.now();
  return p.waits > 0 || now - p.waited < REARM_MS || now - p.envelope < ALIVE_MS;
}

/** L'attesa alla cassetta, contata: è il segnale che il Mac (o il telefono)
    sta ascoltando in questa stanza. La cassetta sotto non cambia. */
async function waitCounted(room: string, slot: string, seconds: number, signal?: AbortSignal) {
  const p = presence(room);
  p.waits++;
  try {
    return await box.wait(room, slot, seconds, signal);
  } finally {
    p.waits--;
    p.waited = Date.now();
  }
}

/* ---------- la webapp servita in HTTPS ---------------------------------- */

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

async function asset(name: string): Promise<Response | null> {
  if (name === "" || name.endsWith("/")) name += "index.html";
  if (name.includes("..") || name.startsWith("/")) return null;
  try {
    const data = await Deno.readFile(new URL("./public/" + name, import.meta.url));
    const ext = name.split(".").pop() ?? "";
    return new Response(data, {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        // La pagina non deve invecchiare in mano al telefono: se cambia il
        // trasporto, deve arrivare la versione nuova.
        "cache-control": name.endsWith(".html") ? "no-cache" : "public, max-age=300",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return null;
  }
}

/* ---------- le rotte ---------------------------------------------------- */

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

// In locale (le prove) si sceglie porta e interfaccia: si sta su 127.0.0.1,
// perché un punto d'incontro in ascolto sulla rete di casa non serve a nessuno.
// Online questi due valori non li usa nessuno: ci pensa la piattaforma.
const PORT = Number(Deno.env.get("PORT") ?? "") || undefined;
const BIND = Deno.env.get("BIND") || undefined;
const local: Deno.ServeTcpOptions = {};
if (PORT) local.port = PORT;
if (BIND) local.hostname = BIND;

Deno.serve(local, async (req: Request, info?: Deno.ServeHandlerInfo) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    // `single`: qui gira **un processo solo** (una macchina nostra, non una
    // piattaforma che sparpaglia le richieste fra isolati). In quel caso la
    // memoria in process e' gia' condivisa fra le due parti e il KV non serve:
    // senza questo campo il Mac vedrebbe `kv:false` e allarmerebbe a vuoto.
    // Su Deno Deploy la variabile c'e', quindi `single` diventa falso e
    // l'avviso torna a essere giusto.
    const single = !Deno.env.get("DENO_DEPLOYMENT_ID");
    // `relay`: se questo ponte **offre** il rimbalzo. Il Mac interroga già
    // /health; è da qui che potrà scrivere «rimbalzo: attivo» nel pannello
    // senza una casella nuova da compilare. Non dice niente di nessuna stanza.
    return Response.json(
      { ok: true, app: "riflesso-bridge", kv: box instanceof KvBox, single, relay: TURN !== null },
      { headers: NO_STORE },
    );
  }

  // /ice?room=<stanza> — la lista dei server ICE per il telefono.
  // Sempre 200 con una lista: stanza mancante, storta o morta danno la lista
  // di oggi e `relay:false`, senza distinguere fra i tre casi. L'unico
  // errore possibile è il freno, che va **prima** di guardare la stanza.
  if (path === "/ice") {
    if (req.method !== "GET") return new Response("no", { status: 405, headers: NO_STORE });
    if (tooFast("ice:" + origin(req, info), ICE_PER_IP)) {
      return new Response("piano", {
        status: 429,
        headers: { ...NO_STORE, "retry-after": "60" },
      });
    }
    const room = url.searchParams.get("room") ?? "";
    const body: { iceServers: unknown[]; relay: boolean; ttl: number } =
      { iceServers: ICE_DEFAULT, relay: false, ttl: TURN_TTL_S };
    if (TURN && ROOM_RE.test(room) && alive(room)) {
      body.iceServers = [...ICE_DEFAULT, await turnServer()];
      body.relay = true;
    }
    return Response.json(body, { headers: NO_STORE });
  }

  // /m/<stanza>/<cassetta>
  if (path.startsWith("/m/")) {
    const parts = path.slice(3).split("/");
    if (parts.length !== 2 || !ROOM_RE.test(parts[0]) || !SLOTS.has(parts[1])) {
      return new Response("no", { status: 400, headers: NO_STORE });
    }
    const [room, slot] = parts;

    // Il freno. Va **prima** di toccare la cassetta: chi tenta a raffica non
    // deve nemmeno arrivare a sapere se in quella stanza c'era qualcosa.
    if (tooFast("i:" + origin(req, info), PER_IP) || tooFast("r:" + room, PER_ROOM)) {
      return new Response("piano", {
        status: 429,
        headers: { ...NO_STORE, "retry-after": "60" },
      });
    }

    if (req.method === "POST") {
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length === 0 || body.length > MAX_ENVELOPE) {
        return new Response("no", { status: 413, headers: NO_STORE });
      }
      await box.put(room, slot, body);
      presence(room).envelope = Date.now();   // è passata una busta: stanza viva per 120 s
      return new Response(null, { status: 204, headers: NO_STORE });
    }

    if (req.method === "GET") {
      const w = Math.min(Math.max(Number(url.searchParams.get("w") ?? "0") || 0, 0), MAX_WAIT_S);
      const v = w > 0 ? await waitCounted(room, slot, w, req.signal) : await box.take(room, slot);
      if (!v) return new Response(null, { status: 204, headers: NO_STORE });
      presence(room).envelope = Date.now();   // consegnata: anche questo è traffico vivo
      // Se nel frattempo se n'è andato, la busta torna nella cassetta invece di
      // finire in una connessione morta: la consegna è singola, e buttarla via
      // vorrebbe dire far aspettare l'altra parte fino alla scadenza.
      if (req.signal.aborted) {
        await box.put(room, slot, v);
        return new Response(null, { status: 204, headers: NO_STORE });
      }
      return new Response(v.slice().buffer as ArrayBuffer, {
        headers: { ...NO_STORE, "content-type": "application/octet-stream" },
      });
    }

    if (req.method === "DELETE") {
      await box.take(room, slot);
      return new Response(null, { status: 204, headers: NO_STORE });
    }

    return new Response("no", { status: 405, headers: NO_STORE });
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const res = await asset(path.slice(1));
    if (res) return res;
  }
  return new Response("Not found", { status: 404, headers: NO_STORE });
});
