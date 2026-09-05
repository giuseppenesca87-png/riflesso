'use strict';

/* ------------------------------------------------------------------
   Il trasporto. Due strade, stessa app sopra — e **si dice sempre quale**.

   · **casa** — la pagina arriva dal Mac sulla 7654 (`http://<mac>.local:7654`):
     si parla con lui direttamente, fetch e WebSocket veri. Nessun Internet.
   · **ponte** — la pagina arriva dal punto d'incontro in HTTPS, perché il Mac
     non è raggiungibile: si apre un collegamento **diretto** telefono↔Mac
     (WebRTC) e ci si infila dentro l'API e la conversazione dal vivo. Dentro
     il tubo la scelta «prima la rete locale» la fa ICE da solo: a casa vince
     la coppia di indirizzi privati e l'app scrive «in casa».

   In mezzo c'era una terza strada, Tailscale (un inoltro in https davanti alla
   7654), tolta il 04/09/2026: il ponte vale da qualunque rete, e ogni salto
   di origine in più costava un permesso del microfono in meno. La sonda che la
   riconosceva resta (`probeDirect`): se un giorno davanti alla 7654 ci fosse
   un inoltro qualunque, la pagina lo scoprirebbe e parlerebbe diretta lo
   stesso, scrivendo «diretta».

   Quale delle strade lo decide chi serve la pagina, non l'utente. Ma non ci si
   fida della porta: si chiede a chi risponde (`probeDirect`). Mai un ripiego
   muto — il 01/09/2026 ne è costata una serata.

   Perché non si può fare più semplice: una pagina HTTPS **non può** parlare
   in HTTP con la rete locale (contenuto misto), e WebRTC **non esiste** fuori
   da un contesto sicuro. Vedi docs nel README.

   ## L'accoppiamento non dipende da dove sei

   Il collegamento normale nasce dal **gettone**, che però ce l'ha solo un
   telefono già accoppiato: il cane che si morde la coda. Perciò sul ponte c'è
   una seconda porta, aperta dallo stesso meccanismo ma con un altro segreto —
   il **codice** a otto cifre mostrato sul Mac. Si digita, si ricava la stessa
   stanza che il Mac sta ascoltando, si apre il canale e si completa
   l'accoppiamento lì dentro. Il codice fa da chiave, quindi il ponte non lo
   vede mai; da quel canale si può chiamare **solo** `/api/pair` (lo impone
   `host-bridge.js`). Appena arriva il gettone si torna alla porta di sempre.
------------------------------------------------------------------ */

(function (global) {
  const K = Tunnel.KIND;

  const RF = {
    remote: false,       // vero finché non è accertato che a servire la pagina è il Mac
    road: 'casa',        // casa · diretta · ponte — la strada di questa pagina
    token: '',
    meet: '',            // segreto del Mac: da qui nasce la stanza unica sul ponte
    state: 'idle',       // (solo ponte) idle · connecting · open · failed
    where: '',           // (solo ponte) casa · fuori · relay
    detail: '',
    stats: { signalBytes: 0, msToOpen: 0, pair: '' },
    onstatus: null,
    // Solo collaudo e controprova (`Net.forceRelay = true` dalla console, prima
    // di collegarsi): vieta la strada diretta e passa dal rimbalzo anche dove
    // non servirebbe. Non si salva: alla prossima apertura è di nuovo falso.
    forceRelay: false,
  };

  /* ---------- da dove arriva questa pagina ---------- */

  // Il Mac serve la webapp **sulla 7654**: quella è casa, di sicuro. Su
  // un'altra porta — un inoltro davanti al Mac, o il punto d'incontro — lo si
  // accerta chiedendo a chi risponde, invece di darlo per scontato.
  RF.remote = location.port !== '7654';
  RF.road = RF.remote ? 'ponte' : 'casa';

  // La sonda. Il Mac risponde `{"app":"Riflesso"}` a `/health`, il punto
  // d'incontro `{"app":"riflesso-bridge"}`: se è il Mac, la strada è diretta e
  // non serve nessun tubo. Va chiamata **prima** di ogni altra cosa (`boot()`
  // in app.js), e resta quella che decide: se un giorno davanti alla 7654 ci
  // fosse qualcosa che non è Riflesso, `Net.remote` resterebbe vero e si
  // vedrebbe subito.
  RF.probeDirect = async () => {
    if (!RF.remote) return false;
    try {
      const r = await fetch('/health', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j || j.app !== 'Riflesso') return false;
    } catch (_) { return false; }
    RF.remote = false;
    RF.road = 'diretta';
    RF.token = localStorage.getItem(STORE) || '';
    RF.meet = localStorage.getItem(MEET_STORE) || '';
    return true;
  };

  // Accertato che la pagina arriva dal ponte, si chiede subito la lista dei
  // server ICE (col rimbalzo, se c'è): dev'essere in tasca **prima** di
  // collegarsi, non chiesta sulla radio nel momento in cui serve. `boot()`
  // chiama `probeDirect` per prima cosa: è l'avvio della pagina.
  const probeOnly = RF.probeDirect;
  RF.probeDirect = async () => {
    const direct = await probeOnly();
    if (!direct && RF.remote) RF.prefetchIce();
    return direct;
  };

  /* ---------- il gettone e il codice, e come arrivano qui ----------

     Il gettone lo dà l'accoppiamento e resta salvato. Il codice invece arriva
     dal QR del Mac (`#p=12345678`) e **non si salva**: serve una volta sola,
     e tenerlo in giro sarebbe solo un segreto in più da perdere.

     Tutti passano **dopo il cancelletto**, che è l'unico pezzo di un
     indirizzo che il browser non spedisce mai al server: il punto d'incontro
     non vede né l'uno né l'altro. Appena letti si ripulisce la barra. */

  // Un cassetto per origine. Il browser tiene già separati i cassetti del
  // ponte e di casa (sono due origini diverse), quindi un secondo nome per
  // la stessa origine non serve: con due cassetti, se la sonda falliva per un
  // attimo il gettone finiva in quello sbagliato e un telefono già accoppiato
  // si ritrovava a chiedere il codice.
  const STORE = 'riflesso.token';
  const MEET_STORE = 'riflesso.meet';

  // I cassetti vecchi del ponte (`*.remote`, fino al 03/09/2026): quello che
  // c'è dentro passa nel cassetto unico, così un telefono accoppiato allora
  // non deve rifare il codice.
  (function migra() {
    for (const [vecchio, nuovo] of [['riflesso.token.remote', STORE], ['riflesso.meet.remote', MEET_STORE]]) {
      try {
        const v = localStorage.getItem(vecchio);
        if (v && !localStorage.getItem(nuovo)) localStorage.setItem(nuovo, v);
        localStorage.removeItem(vecchio);
      } catch (e) {}
    }
  })();

  /// Il codice inquadrato col QR, se c'era. Lo consuma la schermata di
  /// accoppiamento e poi sparisce.
  RF.codeFromLink = '';

  (function grabFromHash() {
    const k = location.hash.match(/[#&]k=([0-9a-f]{32,128})/i);
    if (k) localStorage.setItem(STORE, k[1]);
    const m = location.hash.match(/[#&]m=([0-9a-f]{32,128})/i);
    if (m) localStorage.setItem(MEET_STORE, m[1]);
    const p = location.hash.match(/[#&]p=(\d{6,12})/);
    if (p) RF.codeFromLink = p[1];
    if (!k && !m && !p) return;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { location.hash = ''; }
  })();

  RF.token = localStorage.getItem(STORE) || '';
  RF.meet = localStorage.getItem(MEET_STORE) || '';
  RF.setToken = (t) => { RF.token = t; localStorage.setItem(STORE, t); };
  // Appena si sa la stanza del Mac (dopo l'accoppiamento) si chiede la lista
  // dei server per quella: il giro col gettone parte un attimo dopo, e deve
  // trovarla già in tasca.
  RF.setMeet = (m) => { if (!m) return; RF.meet = m; localStorage.setItem(MEET_STORE, m); RF.prefetchIce(); };
  RF.forgetToken = () => {
    RF.token = ''; localStorage.removeItem(STORE);
    RF.meet = ''; localStorage.removeItem(MEET_STORE);
  };

  // Le ultime cose successe al collegamento, con l'orario. Costa niente e
  // risponde all'unica domanda che conta quando non va: **cos'è successo
  // prima**. Si legge da `Net.trace`.
  RF.trace = [];
  function trace(what) {
    RF.trace.push(Math.round(performance.now()) + ' ' + what);
    if (RF.trace.length > 40) RF.trace.shift();
  }

  function setState(state, detail, where) {
    RF.state = state;
    if (detail !== undefined) RF.detail = detail;
    if (where !== undefined) RF.where = where;
    trace(state + (detail ? ' · ' + detail : '') + (where ? ' · ' + where : ''));
    if (RF.onstatus) RF.onstatus(RF);
  }

  /* =================================================================
     CASA e DIRETTA — niente di speciale: fetch e WebSocket veri.
     ================================================================= */

  const lan = {
    async fetch(path, opts) {
      const res = await fetch(path, opts);
      return {
        ok: res.ok, status: res.status,
        json: () => res.json(), text: () => res.text(),
        bytes: async () => new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || '',
      };
    },
    socket(h) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(RF.token)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => h.onopen && h.onopen();
      ws.onmessage = (ev) => h.onmessage && h.onmessage(ev.data);
      ws.onclose = (ev) => h.onclose && h.onclose(ev.code);
      ws.onerror = () => h.onerror && h.onerror();
      return {
        send: (s) => { if (ws.readyState === 1) ws.send(s); },
        close: () => ws.close(),
        get readyState() { return ws.readyState; },
      };
    },
    async assetURL(path) { return path; },
    /// In casa il Mac è lì: si bussa e basta. Stessa forma della risposta del
    /// giro dal tubo, così l'app non deve sapere da dove sta parlando.
    async pair(code, label, id) {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: code, label, id }),
      });
      return res.json();
    },
  };

  /* =================================================================
     PONTE — chiavi, buste, appuntamento, DataChannel.
     ================================================================= */

  const SALT = 'riflesso.rendezvous.v1';
  const MAGIC = [0x52, 0x46, 0x31]; // "RF1"
  const te = new TextEncoder();

  // Le etichette di HKDF. Restano **identiche** a prima: le tre
  // implementazioni (browser, Swift, Node) devono continuare a coincidere.
  // Il codice ha le sue, così le due porte non si confondono nemmeno per sbaglio.
  // Le stesse due righe, identiche, stanno in `RemoteLink.Kind` (Swift).
  const INFO = {
    device: { room: 'room', seal: 'seal' },
    pair: { room: 'room.pair', seal: 'seal.pair' },
  };

  let keyCache = null;      // { id, room, seal }
  async function derive(secret, kind) {
    const id = kind + ':' + secret;
    if (keyCache && keyCache.id === id) return keyCache;
    if (!secret) throw new Error('senza-segreto');
    const info = INFO[kind];
    const material = await crypto.subtle.importKey('raw', te.encode(secret), 'HKDF',
      false, ['deriveBits', 'deriveKey']);
    const roomBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: te.encode(SALT), info: te.encode(info.room) },
      material, 128);
    const seal = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: te.encode(SALT), info: te.encode(info.seal) },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keyCache = { id, room: b64url(new Uint8Array(roomBits)), seal };
    return keyCache;
  }

  function b64url(bytes) {
    return Tunnel.toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Identificatore opaco del dispositivo: sta **dentro** la busta, il ponte
  // non lo vede. Stessa derivazione di `RemoteLink.opaqueID` (Swift).
  async function opaqueId(token) {
    const material = await crypto.subtle.importKey('raw', te.encode(token), 'HKDF',
      false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: te.encode(SALT), info: te.encode('id') },
      material, 128);
    return b64url(new Uint8Array(bits));
  }

  // Per i telefoni accoppiati: stanza dal segreto del Mac, chiave dal gettone.
  // Per l'accoppiamento: tutti e due dal codice, come sempre.
  async function keysFor(secret, kind) {
    if (kind === 'device') {
      if (!RF.meet) throw new Error('senza-incontro');
      if (!secret) throw new Error('senza-gettone');
      const roomPart = await derive(RF.meet, 'device');
      const sealPart = await derive(secret, 'device');
      return { room: roomPart.room, seal: sealPart.seal, did: await opaqueId(secret) };
    }
    const k = await derive(secret, kind);
    return { room: k.room, seal: k.seal, did: '' };
  }

  async function seal(keys, role, obj) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const head = new Uint8Array([...MAGIC, role.charCodeAt(0)]);
    const aad = new Uint8Array([...head, ...te.encode(keys.room)]);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad }, keys.seal,
      te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(head.length + nonce.length + ct.length);
    out.set(head, 0); out.set(nonce, head.length); out.set(ct, head.length + nonce.length);
    return out;
  }

  async function unseal(keys, role, bytes) {
    if (bytes.length < 16 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) {
      throw new Error('bad-envelope');
    }
    if (bytes[3] !== role.charCodeAt(0)) throw new Error('wrong-role-envelope');
    const head = bytes.subarray(0, 4);
    const aad = new Uint8Array([...head, ...te.encode(keys.room)]);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(4, 16), additionalData: aad },
      keys.seal, bytes.subarray(16));
    return JSON.parse(Tunnel.dec.decode(new Uint8Array(plain)));
  }

  /* ---------- l'appuntamento ---------- */

  // Il ponte ha un freno per stanza e per indirizzo di provenienza (serve a
  // rendere impraticabile il tentare codici a raffica). Se scatta con noi
  // davanti non è un guasto da nascondere: si dice, e si dice pure per quanto.
  const TROPPO_IN_FRETTA = 'troppo-in-fretta';

  async function post(room, slot, body) {
    RF.stats.signalBytes += body.length;
    const res = await fetch(`/m/${room}/${slot}`, { method: 'POST', body, cache: 'no-store' });
    if (res.status === 429) throw new Error(TROPPO_IN_FRETTA);
    if (!res.ok && res.status !== 204) throw new Error('rendezvous-' + res.status);
  }

  async function get(room, slot, waitS) {
    const res = await fetch(`/m/${room}/${slot}?w=${waitS}`, { cache: 'no-store' });
    if (res.status === 204) return null;
    if (res.status === 429) throw new Error(TROPPO_IN_FRETTA);
    if (!res.ok) throw new Error('rendezvous-' + res.status);
    const b = new Uint8Array(await res.arrayBuffer());
    RF.stats.signalBytes += b.length;
    return b.length ? b : null;
  }

  /* ---------- STUN: solo per scoprire il proprio indirizzo pubblico ----------

     Tre server di tre padroni diversi. C'erano `stun.l.google.com` e
     `stun1.l.google.com`, che sono **lo stesso server** (stesso indirizzo,
     74.125.250.129): un punto solo di rottura travestito da due. Gli altri
     due sono misurati funzionanti su IPv4 e IPv6 (`tools/icecheck.js --stun`,
     04/09/2026). La stessa lista sta in `RemoteLink.swift` e in
     `bridge/main.ts` (`ICE_DEFAULT`).

     È la **rete di sicurezza**: la lista vera si chiede al ponte (sotto). */

  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.nextcloud.com:3478', 'stun:stun.sipgate.net:3478'] },
  ];

  /* ---------- il rimbalzo: la lista dei server si chiede al ponte ----------

     Dal 5G la strada diretta non esiste: l'operatore assegna una porta
     diversa per ogni destinazione (NAT simmetrico — misurato il 04/09/2026:
     tre srflx, stesso indirizzo, tre porte) e i due non si trovano mai. La
     cura è un rimbalzo TURN sulla macchina del ponte, che sposta pacchetti
     già sigillati fra telefono e Mac. Il ponte conia la credenziale:
     `GET /ice?room=<stanza>` risponde `{ iceServers, relay, ttl }` — con il
     `turn:` in coda **solo** se in quella stanza qualcuno sta ascoltando
     adesso (è la porta d'ingresso: chi non sa il nome della stanza non ottiene
     niente). Senza rimbalzo acceso, o per una stanza morta, arriva la lista di
     sopra e `relay:false`, e non cambia nulla.

     Tre regole, tutte per la radio:

     · si chiede **all'avvio della pagina** (`prefetch`), non al momento di
       collegarsi: è un giro di rete in più proprio sulla radio che stiamo
       curando, e deve essere già in tasca quando serve;
     · si tiene per **metà della scadenza** (`ttl`): la credenziale vive 600 s,
       il telefono la rinnova a 300 — così non si parte mai con una credenziale
       che scade a metà collegamento;
     · se il ponte non risponde, tarda, o non conosce la rotta (ponte vecchio):
       **la lista di oggi**, e lo si scrive nella cronaca. Mai un ripiego muto.

     La stanza è la stessa che il ponte confronta con le sue cassette: per un
     telefono accoppiato quella del segreto del Mac (`keysFor`, `device`), per
     l'accoppiamento quella del codice (`pair`). */

  const ICE_FETCH_MS = 2500;     // quanto si aspetta /ice se NON è già in tasca
  const ICE_TTL_S = 600;         // se il ponte non dice la scadenza
  const ICE_TTL_MIN_S = 60;      // sotto, il rinnovo a metà scadenza diventerebbe una raffica
  const ICE_TTL_MAX_S = 3600;    // sopra, si terrebbe in tasca una credenziale già morta
  const ICE_RETRY_MS = 30000;    // dopo un ripiego, prima di richiedere

  // Per stanza: { servers, relay, until, from }. `until` è quando smette di
  // valere; `from` dice da dove viene (ponte · ripiego), per la diagnostica.
  const icePocket = new Map();
  const iceInFlight = new Map();

  RF.ice = { relay: false, from: '', room: '' };   // l'ultima lista usata

  function hasTurn(servers) {
    return servers.some((s) => [].concat(s.urls || []).some((u) => /^turns?:/i.test(String(u))));
  }

  /** La risposta del ponte, letta con le mani avanti: un campo storto non deve
      buttare giù il collegamento, deve solo farci tornare alla lista di oggi. */
  function parseIce(j) {
    if (!j || !Array.isArray(j.iceServers)) return null;
    const servers = [];
    for (const s of j.iceServers) {
      if (!s || !s.urls) continue;
      const urls = [].concat(s.urls).filter((u) => typeof u === 'string' && /^(stun|turn)s?:/i.test(u));
      if (!urls.length) continue;
      const o = { urls };
      if (s.username) o.username = String(s.username);
      if (s.credential) o.credential = String(s.credential);
      servers.push(o);
    }
    if (!servers.length) return null;
    const relay = !!j.relay && hasTurn(servers);
    let ttl = Number(j.ttl) || 0;
    if (!ttl && relay) {
      // La scadenza sta anche dentro il nome utente (`<scadenza unix>:<tag>`):
      // se il ponte non dice `ttl`, la si ricava da lì.
      const named = servers.find((s) => s.username && /^\d+:/.test(s.username));
      if (named) ttl = Math.max(0, Number(named.username.split(':')[0]) - Math.floor(Date.now() / 1000));
    }
    if (!ttl) ttl = ICE_TTL_S;
    // Recinto: un `ttl` assurdo (zero, negativo, un anno) manderebbe in raffica
    // il rinnovo a metà scadenza, o terrebbe in tasca una credenziale morta.
    ttl = Math.min(Math.max(ttl, ICE_TTL_MIN_S), ICE_TTL_MAX_S);
    return { servers, relay, ttl };
  }

  function fallbackIce(room, why) {
    const entry = { servers: ICE, relay: false, until: Date.now() + ICE_RETRY_MS, from: 'ripiego: ' + why };
    icePocket.set(room, entry);
    trace('lista ICE: ' + why + ' → la lista di oggi');
    return entry;
  }

  /** Un giro a `/ice` per una stanza, uno alla volta. Risolve sempre con una
      lista buona (quella del ponte o quella di oggi), mai con un errore. */
  function fetchIce(room) {
    if (iceInFlight.has(room)) return iceInFlight.get(room);
    const p = (async () => {
      const t0 = performance.now();
      const ctrl = new AbortController();
      const stop = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch('/ice?room=' + encodeURIComponent(room), { cache: 'no-store', signal: ctrl.signal });
        if (res.status === 404 || res.status === 405) return fallbackIce(room, 'il ponte non ha la rotta');
        if (res.status === 429) return fallbackIce(room, TROPPO_IN_FRETTA);
        if (!res.ok) return fallbackIce(room, 'ponte ' + res.status);
        const got = parseIce(await res.json());
        if (!got) return fallbackIce(room, 'risposta illeggibile');
        const entry = {
          servers: got.servers, relay: got.relay,
          until: Date.now() + got.ttl * 500,     // metà della scadenza, in ms
          from: 'ponte',
        };
        icePocket.set(room, entry);
        trace(`lista ICE dal ponte: ${got.relay ? 'con rimbalzo' : 'senza rimbalzo'} · ttl ${got.ttl} s · ${Math.round(performance.now() - t0)} ms`);
        // Si rinnova da sola a metà scadenza, finché la pagina è dal ponte:
        // così al collegamento dopo è ancora in tasca, non «era in tasca».
        setTimeout(() => {
          if (RF.remote && icePocket.get(room) === entry && document.visibilityState !== 'hidden') fetchIce(room);
        }, got.ttl * 500);
        return entry;
      } catch (e) {
        return fallbackIce(room, e && e.name === 'AbortError' ? 'nessuna risposta' : 'ponte non raggiungibile');
      } finally {
        clearTimeout(stop);
        iceInFlight.delete(room);
      }
    })();
    iceInFlight.set(room, p);
    return p;
  }

  /** La lista per questa stanza, **adesso**: quella in tasca se vale ancora;
      altrimenti si chiede, ma non si aspetta oltre `ICE_FETCH_MS` — chi guarda
      lo schermo non deve pagare un ponte lento più di quel tanto. */
  async function iceFor(room) {
    const have = icePocket.get(room);
    let entry = have && have.until > Date.now() ? have : null;
    if (!entry) {
      entry = await Promise.race([
        fetchIce(room),
        new Promise((r) => setTimeout(() => r(null), ICE_FETCH_MS)),
      ]);
      if (!entry) {
        trace('lista ICE: il ponte tarda, parto con ' + (have ? 'quella in tasca' : 'la lista di oggi'));
        entry = have || { servers: ICE, relay: false, from: 'ripiego: il ponte tarda' };
      }
    }
    RF.ice = { relay: entry.relay, from: entry.from, room };
    return entry;
  }

  /** La stanza (o le stanze) che questa pagina userà, per averne la lista in
      tasca prima che serva. Solo dal ponte: in casa la lista non serve. */
  RF.prefetchIce = async () => {
    if (!RF.remote) return;
    // Si leggono **subito**, prima di qualunque `await`. La schermata di
    // accoppiamento consuma `codeFromLink` un attimo dopo l'avvio: leggendolo
    // dopo la prima attesa, un telefono già accoppiato che inquadrava un QR
    // nuovo chiedeva la lista per la stanza vecchia (morta) e mai per quella
    // del codice — cioè pagava sulla radio proprio il giro che questa funzione
    // deve evitare. E se c'è un codice, il segreto in tasca sta per essere
    // buttato (`boot()` lo dimentica prima di accoppiarsi): la sua stanza non
    // si chiede, sarebbe una richiesta per una stanza già morta.
    const code = RF.codeFromLink;
    const meet = code ? '' : RF.meet;
    const rooms = [];
    try { if (meet) rooms.push((await derive(meet, 'device')).room); } catch (e) {}
    try { if (code) rooms.push((await derive(code, 'pair')).room); } catch (e) {}
    for (const room of rooms) {
      const have = icePocket.get(room);
      if (!have || have.until <= Date.now()) fetchIce(room);
    }
  };

  // Tornati sulla pagina dopo un po' (il telefono in tasca, l'app dietro): la
  // lista può essere scaduta mentre nessuno guardava. Si rinnova prima che
  // l'utente tocchi qualcosa, che è il momento in cui servirà.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') RF.prefetchIce();
  });

  const fingerprintOf = (sdp) => (sdp.match(/a=fingerprint:(\S+ \S+)/i) || [])[1] || '';

  let peer = null;        // { pc, dc }
  let opening = null;     // handshake in corso

  function tearDown(why) {
    if (peer) {
      try { peer.dc.close(); } catch (e) {}
      try { peer.pc.close(); } catch (e) {}
    }
    peer = null;
    if (why) setState('failed', why, '');
  }

  /** `kind` è `device` (col gettone) o `pair` (col codice). Per `device` la
      stanza nasce dal segreto del Mac, la chiave dal gettone. */
  async function handshake(secret, kind) {
    if (!secret) throw new Error(kind === 'pair' ? 'senza-codice' : 'senza-gettone');
    const t0 = performance.now();
    RF.stats.signalBytes = 0;
    setState('connecting', 'looking');

    const keys = await keysFor(secret, kind);
    const room = keys.room;
    // La lista dei server: dal ponte (col rimbalzo, se c'è e la stanza è viva),
    // già in tasca dall'avvio della pagina. Vedi «il rimbalzo» sopra.
    const ice = await iceFor(room);
    const cfg = { iceServers: ice.servers, bundlePolicy: 'max-bundle' };
    // Solo per il collaudo e la controprova: si vieta la strada diretta, così
    // si vede il rimbalzo anche da una rete in cui non servirebbe.
    if (RF.forceRelay) cfg.iceTransportPolicy = 'relay';
    const pc = new RTCPeerConnection(cfg);
    const dc = pc.createDataChannel('rf', { ordered: true });
    dc.binaryType = 'arraybuffer';

    const mine = crypto.getRandomValues(new Uint8Array(8));
    const nonce = b64url(mine);

    try {
      await pc.setLocalDescription(await pc.createOffer());
      // Sotto il 5G la prima risposta di uno STUN puo' arrivare ben oltre i due
      // secondi e mezzo che aspettavamo prima: risveglio della radio, DNS, e il
      // NAT dell'operatore in mezzo. Scaduta l'attesa si partiva con i soli
      // indirizzi `.local`, che fuori di casa non vogliono dire niente, e il
      // canale non si apriva **mai** — mentre sotto il wifi di casa lo stesso
      // codice funzionava, perche' li' l'indirizzo pubblico arriva in fretta.
      // Otto secondi non si pagano quasi mai: si aspetta comunque solo finche'
      // non arriva il primo indirizzo pubblico (o quello di rimbalzo, se la
      // lista ne ha uno), e poi si parte subito.
      await gathered(pc, 8000, ice.relay);

      // L'offerta si **rilegge a ogni invio** invece di congelarla: se un
      // indirizzo arriva in ritardo, il tentativo dopo se lo porta dietro.
      // Non c'e' modo di spedire un candidato per conto suo (niente trickle
      // ICE: il ponte non ha una rotta per i candidati sciolti), e questo ne fa
      // le veci. L'impronta DTLS non cambia: la connessione e' sempre la stessa.
      const offerBody = () => {
        const sdp = pc.localDescription.sdp;
        const o = { t: 'offer', sdp, fp: fingerprintOf(sdp), ts: Date.now(), n: nonce };
        if (keys.did) o.d = keys.did;
        return o;
      };
      await post(room, 'o', await seal(keys, 'o', offerBody()));

      setState('connecting', 'waiting_mac');
      // La cassetta è una sola per Mac: se due telefoni bussano insieme, o se
      // la stessa app è aperta in due schede, la risposta può essere quella
      // dell'altra. Non è un errore da dichiarare, è una cosa da riprovare —
      // l'offerta si rimanda e vince chi arriva ultimo. La busta dell'altro
      // non si apre (chiave diversa).
      let answer = null;
      const until = Date.now() + 50000;
      const again = async (why) => {
        trace('rimando l\'offerta: ' + why);
        await post(room, 'o', await seal(keys, 'o', offerBody()));
      };
      while (!answer && Date.now() < until) {
        const env = await get(room, 'a', 25);
        // Niente risposta in venticinque secondi: l'offerta può essersi persa
        // per strada (una cassetta si consegna una volta sola, e una richiesta
        // interrotta può averla presa). Rimandarla costa un chilobyte e rimette
        // le cose a posto da sole, invece di far aspettare chi guarda.
        if (!env) { await again('nessuna risposta'); continue; }
        let got;
        try { got = await unseal(keys, 'a', env); }
        catch (e) { await again('busta non mia'); continue; }
        if (got.t === 'answer' && got.n === nonce) { answer = got; break; }
        await again('era la risposta di un altro collegamento');
      }
      if (!answer) throw new Error('nessuna-risposta');
      if (Math.abs(Date.now() - (answer.ts || 0)) > 90000) throw new Error('risposta-vecchia');
      // L'impronta è già autenticata dalla busta; la si confronta lo stesso con
      // quella dentro l'SDP, così una svista non passa in silenzio.
      if (answer.fp && answer.fp !== fingerprintOf(answer.sdp)) throw new Error('impronta-diversa');

      setState('connecting', 'linking');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('niente-strada')), 20000);
        dc.onopen = () => { clearTimeout(timer); resolve(); };
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed') { clearTimeout(timer); reject(new Error('niente-strada')); }
        };
      });

      RF.stats.msToOpen = Math.round(performance.now() - t0);
      peer = { pc, dc };
      wire(dc);
      describePath(pc);
      return dc;
    } catch (e) {
      try { dc.close(); } catch (_) {}
      try { pc.close(); } catch (_) {}
      // Fallito con una lista **senza** rimbalzo in tasca: al giro dopo la si
      // richiede al ponte, invece di riprovare per cinque minuti con la
      // stessa. Il caso vero: la lista chiesta mentre il Mac dormiva (stanza
      // morta → niente rimbalzo), poi il Mac si sveglia e dal 5G non c'è
      // strada. Costa un giro in più solo dopo un fallimento, mai prima.
      const msg = (e && e.message) || '';
      if (!ice.relay && (msg === 'niente-strada' || msg === 'nessuna-risposta')) icePocket.delete(room);
      throw e;
    }
  }

  /* ---------- quanto aspettare gli indirizzi ----------

     Le due costanti sono **provvisorie**: misurate in Chrome, e il telefono è
     un altro motore. Si congelano dopo la prova dal 5G sul telefono vero
     (FUORI-SOLUZIONE.md, «come si prova che funziona davvero», punto 10). */
  const ICE_GRACE_MS = 250;        // dopo il primo indirizzo buono, per raccoglierne un altro
  const ICE_RELAY_MUTE_MS = 1500;  // col rimbalzo in lista ma muto: quanto lo si aspetta

  /** Si aspettano gli indirizzi da mettere nell'offerta — ma non fino in
      fondo: appena si ha quello che serve fuori casa si parte, perché gli
      altri arriverebbero comunque tardi e l'attesa la pagherebbe chi guarda lo
      schermo. Le cinque regole (`withRelay` dice se nella lista c'è un TURN):

      · raccolta finita → parti;
      · primo indirizzo di **rimbalzo** + 250 ms → parti;
      · primo indirizzo **pubblico** (srflx) + 250 ms → parti, **solo se**
        nella lista non c'è un rimbalzo (senza, quello è il meglio possibile);
      · primo indirizzo pubblico + 1500 ms → parti comunque: il rimbalzo era in
        lista ma è muto (coturn spento, UDP bloccato). Dal 5G l'offerta senza
        relay non porterà da nessuna parte, ma è meglio dirlo in un secondo e
        mezzo che restare a girare otto secondi;
      · tetto assoluto `capMs` (8000) invariato.

      Il primo che scatta vince; nella cronaca si scrive quale, e dopo quanto:
      è il numero da guardare per congelare le costanti. */
  function gathered(pc, capMs, withRelay) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const timers = [];
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        trace('indirizzi: ' + why + ' · ' + Math.round(performance.now() - t0) + ' ms');
        resolve();
      };
      const later = (ms, why) => timers.push(setTimeout(() => finish(why), ms));
      if (pc.iceGatheringState === 'complete') return finish('già completi');
      later(capMs, 'tetto');
      let seenSrflx = false, seenRelay = false;
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') finish('raccolta finita');
      });
      pc.addEventListener('icecandidate', (e) => {
        const c = e.candidate && e.candidate.candidate;
        if (!c) return;
        if (/ typ relay/.test(c) && !seenRelay) {
          seenRelay = true;
          later(ICE_GRACE_MS, 'rimbalzo');
        }
        if (/ typ srflx/.test(c) && !seenSrflx) {
          seenSrflx = true;
          if (!withRelay) later(ICE_GRACE_MS, 'pubblico');
          else later(ICE_RELAY_MUTE_MS, 'pubblico, rimbalzo muto');
        }
      });
    });
  }

  /** Dove sta passando davvero il traffico: indirizzi privati = siamo in casa. */
  async function describePath(pc, attempt) {
    const n = attempt || 0;
    try {
      const stats = await pc.getStats();
      let pair = null, local = null, remote = null;
      stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded') pair = r; });
      if (pair) {
        stats.forEach((r) => {
          if (r.id === pair.localCandidateId) local = r;
          if (r.id === pair.remoteCandidateId) remote = r;
        });
      }
      const relay = (remote && remote.candidateType === 'relay') ||
                    (local && local.candidateType === 'relay');
      let rtt = (pair && pair.currentRoundTripTime) || 0;
      if (!rtt && pair && pair.responsesReceived > 0 && pair.totalRoundTripTime > 0) {
        rtt = pair.totalRoundTripTime / pair.responsesReceived;
      }
      // Dire «in casa» non è ovvio come sembra: i browser **nascondono**
      // l'indirizzo dei propri candidati locali (li mandano come nomi `.local`),
      // quindi spesso qui non c'è nessun indirizzo da guardare. Allora si usa
      // l'unica altra prova disponibile: il tempo di andata e ritorno. Sul Wi-Fi
      // di casa sono pochi millisecondi; uscendo dall'operatore non si scende
      // sotto i venti.
      const home = !relay && (isPrivate(remote && remote.address) ||
                             (rtt > 0 && rtt <= 0.015));
      // Quando si passa dal rimbalzo lo si scrive in chiaro, prima dei tipi:
      // «relay↔host» lo legge chi conosce ICE, «rimbalzo» lo leggono tutti.
      RF.stats.pair = (relay ? I18n.t('net.relay') + ' · ' : '')
                    + `${local ? local.candidateType : '?'}↔${remote ? remote.candidateType : '?'}`
                    + (rtt ? ` · ${Math.round(rtt * 1000)} ms` : '');
      const where = relay ? 'relay' : (home ? 'casa' : 'fuori');
      if (n === 0 || where !== RF.where) setState('open', '', where);
    } catch (e) {
      if (n === 0) setState('open', '', 'fuori');
    }
    // Il tempo di andata e ritorno spesso **non c'è ancora** nell'istante in
    // cui il canale si apre: il browser lo misura solo dopo qualche scambio.
    // Si rimisura per qualche secondo, finché il canale è questo, e se la
    // risposta cambia («fuori» → «in casa») la riga di stato la segue.
    const dopo = [1500, 2500, 4000, 6000][n];
    if (dopo && peer && peer.pc === pc) {
      setTimeout(() => { if (peer && peer.pc === pc) describePath(pc, n + 1); }, dopo);
    }
  }

  function isPrivate(ip) {
    if (!ip) return false;
    if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (/^127\./.test(ip)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;      // fc00::/7
    if (/^fe80:/i.test(ip)) return true;
    return false;
  }

  /* ---------- quando non si passa, si dice **perché** ----------

     Mai «collegati alla stessa rete» a chi non è in casa: la rete non c'entra
     con l'accoppiamento, e mandare qualcuno a cercare un Wi-Fi è mandarlo a
     cercare un problema che non esiste. I motivi veri si nominano, e cambiano
     con la strada: in casa il Mac non risponde sulla rete di casa; dietro un
     inoltro l'inoltro non porta più al Mac; dal ponte è il ponte che non
     risponde. */

  const NET_CODES = {
    looking: 'net.looking',
    waiting_mac: 'net.waiting_mac',
    linking: 'net.linking',
    closed: 'net.closed',
  };

  RF.failure = (e) => {
    const msg = (e && e.message) || '';
    if (I18n.has('err.' + msg)) return { key: 'err.' + msg };
    if (msg === 'mac-timeout') return { key: 'err.il Mac non ha risposto' };
    if (e instanceof TypeError || /fetch|load failed|network/i.test(msg)) {
      if (RF.road === 'casa') return { key: 'net.unreachable_home' };
      if (RF.road === 'ponte') return { key: 'net.unreachable_bridge' };
      return { key: 'net.unreachable' };
    }
    return { key: 'net.failed', vars: { detail: msg || '?' } };
  };
  RF.explain = (e) => { const f = RF.failure(e); return I18n.t(f.key, f.vars); };

  function detailLabel() {
    const d = RF.detail;
    if (!d) return '';
    if (NET_CODES[d]) return I18n.t(NET_CODES[d]);
    if (I18n.has('err.' + d)) return I18n.t('err.' + d);
    if (I18n.has('net.' + d)) return I18n.t('net.' + d);
    return RF.explain({ message: d });
  }

  /// **La strada, detta in due parole**, per la riga di stato del telefono:
  /// quale delle tre, e per il ponte anche com'è messo il canale (in casa,
  /// fuori, rimbalzo, si sta collegando, caduto). È quello che il 01/09 non
  /// c'era.
  RF.roadLabel = () => {
    const host = location.host;
    if (RF.road === 'casa') return I18n.t('road.home', { host });
    if (RF.road === 'diretta') return I18n.t('road.direct', { host });
    if (RF.state === 'open') {
      const k = RF.where === 'casa' ? 'road.bridge_home' : (RF.where === 'relay' ? 'road.bridge_relay' : 'road.bridge_away');
      return I18n.t(k, { host });
    }
    if (RF.state === 'connecting') return I18n.t('road.bridge_connecting', { host });
    return I18n.t('road.bridge_down', { host });
  };

  /* ---------- richieste e risposte dentro il tubo ---------- */

  let reqId = 0;
  const pending = new Map();
  let wsHandlers = null;
  let wsOpen = false;

  // Ogni canale ha il suo numero. Chiudere un canale fa scattare `onclose` al
  // giro dopo, cioè **quando il nuovo è già montato**: senza questo numero il
  // vecchio si porterebbe dietro il nuovo. È lo stesso guasto a intermittenza
  // già trovato dall'altra parte (host-bridge.js), e da questo giro succede sul
  // serio: accoppiarsi chiude il canale del codice e ne apre subito uno col
  // gettone.
  let gen = 0;

  function wire(dc) {
    const my = ++gen;
    const reader = new Tunnel.Reader();
    dc.onmessage = (ev) => {
      const msg = reader.push(ev.data);
      if (!msg) return;
      if (msg.kind === K.RES) {
        const r = JSON.parse(Tunnel.text(msg.bytes));
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(r); }
        return;
      }
      if (msg.kind === K.WS_TEXT) {
        if (wsHandlers && wsHandlers.onmessage) wsHandlers.onmessage(Tunnel.text(msg.bytes));
        return;
      }
      if (msg.kind === K.WS_BIN) {
        // `slice()` copia: `msg.bytes` è una finestra dentro il pezzo ricevuto,
        // e il suo `.buffer` conterrebbe anche l'intestazione.
        if (wsHandlers && wsHandlers.onmessage) wsHandlers.onmessage(msg.bytes.slice().buffer);
        return;
      }
      if (msg.kind === K.CTL) {
        const c = JSON.parse(Tunnel.text(msg.bytes));
        if (c.c === 'wsopen') { wsOpen = true; if (wsHandlers && wsHandlers.onopen) wsHandlers.onopen(); }
        if (c.c === 'wsclose') { wsOpen = false; if (wsHandlers && wsHandlers.onclose) wsHandlers.onclose(c.code || 1006); }
      }
    };
    dc.onclose = () => {
      if (my !== gen) { trace('canale vecchio chiuso: lo ignoro'); return; }
      trace('canale chiuso dal Mac');
      wsOpen = false;
      for (const p of pending.values()) p.reject(new Error('caduto'));
      pending.clear();
      peer = null;
      setState('idle', 'closed', '');
      if (wsHandlers && wsHandlers.onclose) wsHandlers.onclose(1006);
    };
  }

  async function channel() {
    if (peer && peer.dc.readyState === 'open') return peer.dc;
    if (!opening) {
      opening = handshake(RF.token, 'device')
        .catch((e) => {
          setState('failed', (e && e.message) || 'failed', '');
          throw e;
        })
        .finally(() => { opening = null; });
    }
    return opening;
  }

  const remote = {
    async fetch(path, opts) {
      const dc = await channel();
      opts = opts || {};
      const id = (++reqId) & 0xffff;
      const req = {
        m: opts.method || 'GET',
        p: path,
        h: opts.headers || {},
        b: typeof opts.body === 'string' ? opts.body : null,
      };
      const answer = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error('mac-timeout')); }
        }, 60000);
      });
      Tunnel.send(dc, K.REQ, id, JSON.stringify(req));
      const r = await answer;
      const bytes = () => (r.enc === 'b64' ? Tunnel.fromBase64(r.b || '') : Tunnel.enc.encode(r.b || ''));
      return {
        ok: r.s >= 200 && r.s < 300,
        status: r.s,
        contentType: r.ct || '',
        text: async () => (r.enc === 'b64' ? Tunnel.text(bytes()) : (r.b || '')),
        json: async () => JSON.parse(r.enc === 'b64' ? Tunnel.text(bytes()) : (r.b || 'null')),
        bytes: async () => bytes(),
      };
    },

    socket(h) {
      wsHandlers = h;
      let closed = false;
      (async () => {
        try {
          const dc = await channel();
          Tunnel.send(dc, K.CTL, 0, JSON.stringify({ c: 'wsopen', token: RF.token }));
        } catch (e) {
          if (!closed && h.onclose) h.onclose(1006);
        }
      })();
      return {
        send: (s) => {
          if (!peer || peer.dc.readyState !== 'open' || !wsOpen) return;
          Tunnel.send(peer.dc, K.WS_TEXT, 0, s);
        },
        close: () => {
          closed = true;
          if (peer && peer.dc.readyState === 'open') {
            Tunnel.send(peer.dc, K.CTL, 0, JSON.stringify({ c: 'wsclose' }));
          }
        },
        get readyState() { return wsOpen ? 1 : (peer ? 0 : 3); },
      };
    },

    async assetURL(path) {
      const res = await remote.fetch(path);
      if (!res.ok) throw new Error('not-found');
      const blob = new Blob([await res.bytes()], { type: res.contentType || 'application/octet-stream' });
      return URL.createObjectURL(blob);
    },

    /** L'accoppiamento da qualunque rete.
     *
     *  Si apre un canale sulla **stanza del codice** — quella che il Mac
     *  ascolta finché c'è un codice vivo — e lì dentro si fa la stessa identica
     *  `POST /api/pair` che si farebbe da casa. Le otto cifre non escono mai:
     *  fanno da chiave della busta, e la richiesta viaggia dentro il canale
     *  diretto, che è cifrato fra telefono e Mac.
     *
     *  Poi il canale si butta **subito**: da lì non si può fare altro (la
     *  pagina ponte inoltra solo `/api/pair`), e il giro seguente parte col
     *  gettone, dalla porta di sempre. */
    async pair(code, label, id) {
      await handshake(code, 'pair');
      try {
        const res = await remote.fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: code, label, id }),
        });
        return await res.json();
      } finally {
        tearDown('');
        // Le chiavi del codice non devono restare in memoria un istante più
        // del necessario: il giro dopo si deriva dal gettone.
        keyCache = null;
      }
    },
  };

  /* ---------- quello che vede l'app ---------- */

  const impl = () => (RF.remote ? remote : lan);

  RF.fetch = (path, opts) => impl().fetch(path, opts);
  RF.socket = (h) => impl().socket(h);
  RF.assetURL = (path) => impl().assetURL(path);
  /// Accoppiarsi, senza che all'app importi da dove. In casa e in diretta è
  /// una POST normale al Mac; dal ponte è la stessa POST dentro il canale
  /// diretto aperto col codice. Chi chiama vede una cosa sola: `{ ok, token }`
  /// o `{ ok:false, code }`.
  RF.pair = (code, label, id) => impl().pair(code, label, id);
  RF.detailLabel = detailLabel;
  /// Com'è fatta la strada scelta: serve alla prova e alla diagnostica.
  RF.peerStats = async () => {
    if (!peer) return null;
    const out = { pairs: [] };
    const s = await peer.pc.getStats();
    const cands = {};
    s.forEach((r) => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r; });
    s.forEach((r) => {
      if (r.type !== 'candidate-pair' || r.state !== 'succeeded') return;
      const l = cands[r.localCandidateId] || {}, m = cands[r.remoteCandidateId] || {};
      out.pairs.push({
        nominated: !!r.nominated,
        local: `${l.candidateType}/${l.address}`,
        remote: `${m.candidateType}/${m.address}`,
        rtt: r.currentRoundTripTime,
      });
    });
    return out;
  };
  RF.disconnect = () => tearDown('');
  RF.retry = () => { tearDown(''); return channel(); };

  // `RF` è già il ponte verso app.js: il trasporto si chiama `Net`.
  global.Net = RF;
})(window);
