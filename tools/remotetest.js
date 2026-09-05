'use strict';

/* ------------------------------------------------------------------
   La prova del fuori casa, per intero e per davvero.

   · il punto d'incontro gira in locale (lo stesso `bridge/main.ts` che andrebbe
     online), con **un registratore in mezzo**: così si può guardare con gli
     occhi cosa vede il servizio, e dimostrare che non vede niente;
   · Chrome fa la parte del telefono e carica la webapp **dal punto d'incontro**,
     non dal Mac: è la condizione vera del fuori casa;
   · il Mac risponde col suo `RemoteLink`, e da lì in poi tutto passa dal
     DataChannel: elenco chat, conversazione, diretta.

   Si misurano byte e tempi, e si controlla che il codice **non** esca dal tubo.

   Due giri, non uno:

   A. **l'accoppiamento col solo codice**, da un browser vergine che non ha mai
      visto il Mac — è il giro nuovo, quello che toglie l'obbligo di accoppiarsi
      in casa. Si controlla anche che da quel canale non si possa fare altro;
   B. **la vita normale** di un telefono già accoppiato, col gettone.

   In tutti e due si guarda cosa ha visto il servizio, e dentro non ci deve
   essere niente: né SDP, né indirizzi, né — ora — le otto cifre.
------------------------------------------------------------------ */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./browser.js');
const { pin } = require('./pin');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'http://127.0.0.1:7654';
// Le porte del ponte locale e del registratore: `RIFLESSO_BRIDGE_PORT` (e la
// successiva) se la 8787 e' occupata da un altro progetto.
const BRIDGE_PORT = Number(process.env.RIFLESSO_BRIDGE_PORT) || 8787;
const PROXY_PORT = BRIDGE_PORT + 1;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

let ok = 0, bad = 0;
const check = (cond, label, extra = '') => {
  if (cond) { ok++; console.log('  ok   ' + label + (extra ? ' · ' + extra : '')); }
  else { bad++; console.log('  NO   ' + label + (extra ? ' · ' + extra : '')); }
  return cond;
};

/* ---------- il registratore in mezzo ----------
   Vede esattamente quello che vedrebbe il servizio: metodo, percorso, e i byte
   del corpo. Serve a provare che i byte sono opachi. */

const seen = [];

function startProxy() {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const out = http.request({
        host: '127.0.0.1', port: BRIDGE_PORT, path: req.url, method: req.method,
        headers: Object.assign({}, req.headers, { host: `127.0.0.1:${BRIDGE_PORT}` }),
      }, (up) => {
        const back = [];
        up.on('data', (c) => back.push(c));
        up.on('end', () => {
          const payload = Buffer.concat(back);
          if (req.url.startsWith('/m/')) {
            seen.push({ method: req.method, url: req.url, up: body, down: payload });
          }
          res.writeHead(up.statusCode, up.headers);
          res.end(payload);
        });
      });
      out.on('error', () => { try { res.writeHead(502); res.end(); } catch (e) {} });
      // Se chi ha chiesto se ne va, il registratore deve **staccare anche
      // sopra**: altrimenti il punto d'incontro non si accorge che nessuno sta
      // più aspettando, e la busta finisce in un'attesa morta. In produzione il
      // registratore non c'è e il segnale arriva diretto.
      const drop = () => { if (!out.destroyed) out.destroy(); };
      req.on('aborted', drop);
      res.on('close', drop);
      out.end(body);
    });
  });
  return new Promise((r) => srv.listen(PROXY_PORT, '127.0.0.1', () => r(srv)));
}

/* ---------- utilità ---------- */

async function hostJSON(pathname, opts = {}) {
  const res = await fetch(HOST + pathname, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** La stessa derivazione che fanno Swift (`RemoteLink.derive`) e il browser
    (`net.js`). Se le tre non combaciassero, le due parti si aspetterebbero in
    stanze diverse — e non c'è errore che lo dica. */
const SALT = Buffer.from('riflesso.rendezvous.v1');
const MAGIC = Buffer.from([0x52, 0x46, 0x31]); // "RF1"

function roomFor(secret, kind = 'device') {
  const info = kind === 'pair' ? 'room.pair' : 'room';
  const bits = crypto.hkdfSync('sha256', Buffer.from(secret), SALT, Buffer.from(info), 16);
  return Buffer.from(bits).toString('base64url');
}

function sealKey(secret, kind = 'device') {
  const info = kind === 'pair' ? 'seal.pair' : 'seal';
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), SALT, Buffer.from(info), 32));
}

function opaqueId(token) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), SALT, Buffer.from('id'), 16))
    .toString('base64url');
}

function keysOf(meet, token) {
  return { room: roomFor(meet), seal: sealKey(token) };
}

function seal(keys, role, obj) {
  const head = Buffer.concat([MAGIC, Buffer.from([role.charCodeAt(0)])]);
  const aad = Buffer.concat([head, Buffer.from(keys.room)]);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.seal, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return Buffer.concat([head, nonce, ct, c.getAuthTag()]);
}

function unseal(keys, role, bytes) {
  const head = bytes.subarray(0, 4);
  if (!head.subarray(0, 3).equals(MAGIC)) throw new Error('busta non riconosciuta');
  if (head[3] !== role.charCodeAt(0)) throw new Error('busta del ruolo sbagliato');
  const aad = Buffer.concat([head, Buffer.from(keys.room)]);
  const d = crypto.createDecipheriv('aes-256-gcm', keys.seal, bytes.subarray(4, 16));
  d.setAAD(aad);
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  const plain = Buffer.concat([d.update(bytes.subarray(16, bytes.length - 16)), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// Il codice arriva da `Riflesso --print-pin` (socket Unix): `/api/pin` non
// esiste piu' dal 03/09/2026.
async function pairDummy(label) {
  let code = '';
  try { code = pin(); } catch (e) { return ''; }
  const pair = await hostJSON('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: code, label }),
  });
  return (pair.body && pair.body.token) || '';
}

function lastListenLine() {
  try {
    const log = fs.readFileSync(path.join(os.homedir(), 'Library/Logs/Riflesso/riflesso.log'), 'utf8');
    const lines = log.split('\n').filter(l => l.includes("punto d'incontro: in ascolto"));
    return lines.pop() || '';
  } catch (e) { return ''; }
}

/* ---------- la prova ---------- */

let extrasForCleanup = [];
// Se la prova muore a meta', il Mac deve tornare comunque sul suo ponte vero:
// lasciarlo puntato al registratore locale vuol dire un pannello che dice
// «il ponte non risponde» finche' qualcuno non se ne accorge.
let previousForCleanup = null;
let tokenForCleanup = '';

(async () => {
  console.log('\n=== FUORI CASA — prova completa ===\n');

  // 0. Chrome di prova rimasti in giro da un giro finito male: vanno chiusi
  //    **prima**. Con lo stesso gettone hanno la stessa stanza, quindi si
  //    prenderebbero le buste destinate a questo giro — e la colpa sembrerebbe
  //    del Mac. (Sono solo i nostri: il profilo `riflesso-chrome-` lo creiamo
  //    qui, il Chrome di chi usa il Mac non c'entra.)
  try {
    require('child_process').execSync('pkill -f riflesso-chrome- || true', { stdio: 'ignore' });
    await sleep(500);
  } catch (e) { /* nessuno da chiudere */ }

  // 0b. la webapp dentro il punto d'incontro
  spawn('bash', [path.join(ROOT, 'tools/bridge-sync.sh')], { stdio: 'ignore' });
  await sleep(600);

  const deno = spawn('deno', ['run', '--allow-net', '--allow-read', '--allow-env',
    '--unstable-kv', path.join(ROOT, 'bridge/main.ts')],
    { env: Object.assign({}, process.env, { PORT: String(BRIDGE_PORT), BIND: '127.0.0.1' }),
      stdio: 'ignore' });
  const proxy = await startProxy();
  await sleep(1500);

  const health = await fetch(`${PROXY}/health`).then(r => r.json()).catch(() => null);
  check(health && health.ok, 'il punto d\'incontro risponde', health ? ('kv: ' + health.kv) : '');

  const shell = await fetch(`${PROXY}/`).then(r => r.text()).catch(() => '');
  check(shell.includes('riflesso-build'), 'il punto d\'incontro serve la webapp',
    shell.length + ' byte');

  // 1. un gettone per la prova. Si riusa quello dell'ultima volta se il Mac lo
  //    riconosce ancora: un dispositivo finto in più a ogni giro sarebbe
  //    spazzatura nell'elenco di chi usa il Mac. Non tiene più aperta
  //    un'attesa propria, ma resta comunque un nome in più nel pannello.
  const KEEP = path.join(ROOT, 'test-output/remote-token.txt');
  fs.mkdirSync(path.dirname(KEEP), { recursive: true });
  let token = '';
  if (fs.existsSync(KEEP)) {
    const saved = fs.readFileSync(KEEP, 'utf8').trim();
    const probe = await hostJSON('/api/status', { headers: { Authorization: 'Bearer ' + saved } });
    if (probe.status === 200) { token = saved; console.log('  ·    riuso il dispositivo di prova già accoppiato'); }
  }
  if (!token) {
    let firstCode = '';
    try { firstCode = pin(); } catch (e) { /* si dice sotto */ }
    if (!check(!!firstCode, 'codice letto dal Mac (Riflesso --print-pin)')) return done(deno, proxy, null);
    const pair = await hostJSON('/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: firstCode, label: 'Prova fuori casa' }),
    });
    token = (pair.body && pair.body.token) || '';
    if (token) fs.writeFileSync(KEEP, token);
  }
  if (!check(!!token, 'dispositivo di prova accoppiato')) return done(deno, proxy, null);

  const st = await hostJSON('/api/status', { headers: { Authorization: 'Bearer ' + token } });
  const meet = (st.body && st.body.meet) || '';
  check(!!meet && meet.length === 64, 'il Mac consegna il segreto della stanza',
    meet ? meet.length + ' caratteri' : 'manca');

  // 2. si accende il fuori casa puntando al registratore
  const before = await hostJSON('/api/remote', { headers: { Authorization: 'Bearer ' + token } });
  const previous = before.body || {};
  previousForCleanup = previous;
  tokenForCleanup = token;
  const set = await hostJSON('/api/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ on: true, base: PROXY }),
  });
  check(set.body && set.body.ok, 'punto d\'incontro acceso sul Mac', set.body && set.body.state);
  await sleep(1200);

  // Due telefoni finti in più: la prova è che le attese restano **una**.
  // Si scollegheranno da soli a fine giro; non si tocca nient'altro.
  const extras = [];
  extras.push(await pairDummy('Prova attesa A'));
  extras.push(await pairDummy('Prova attesa B'));
  extrasForCleanup = extras;
  check(extras.filter(Boolean).length === 2, 'due dispositivi finti accoppiati in più',
    extras.filter(Boolean).length + ' ok');
  await sleep(1500);
  const remote = await hostJSON('/api/remote', { headers: { Authorization: 'Bearer ' + token } });
  check(remote.body && remote.body.waits === 1,
    'una sola attesa aperta, qualunque sia il numero di telefoni accoppiati',
    remote.body ? ('waits=' + remote.body.waits + ' · paired=' + remote.body.paired) : 'nessuna risposta');
  const listen = lastListenLine();
  check(/una attesa/.test(listen) && !/in ascolto per \d+/.test(listen),
    'il log del Mac dice una attesa, non una per telefono',
    listen.replace(/.*INFO /, ''));

  // La busta di un telefono non si apre con la chiave di un altro: stessa
  // stanza, chiavi diverse. Si controlla in Node, identico a Swift e browser.
  if (meet && token && extras[0]) {
    const keysA = keysOf(meet, token);
    const keysB = keysOf(meet, extras[0]);
    check(keysA.room === keysB.room, 'due telefoni dello stesso Mac condividono la stanza');
    const env = seal(keysA, 'o', { t: 'offer', sdp: 'x', n: 'n', ts: Date.now(), d: opaqueId(token) });
    let opened = false;
    try { unseal(keysB, 'o', env); opened = true; } catch (e) { /* atteso */ }
    check(!opened, 'un telefono non apre la busta di un altro');
    const mine = unseal(keysA, 'o', env);
    check(mine.d === opaqueId(token), 'l\'identificatore opaco sta dentro la busta');
  } else {
    check(false, 'busta per-dispositivo verificabile');
  }

  /* ================================================================
     GIRO A — l'accoppiamento col solo codice.

     Browser vergine, nessun gettone da nessuna parte, Mac raggiungibile
     **solo** attraverso il punto d'incontro: è la situazione di chi apre
     Riflesso per la prima volta stando fuori. Prima non si poteva: il codice
     si accettava solo dalla rete di casa.
     ================================================================ */

  // Il codice non scade piu' da solo (dal 31/08/2026): si legge e basta.
  let code = '';
  try { code = pin(); } catch (e) { /* si dice sotto */ }
  check(code.length === 8, 'il Mac mostra un codice di otto cifre',
    code ? code.length + ' cifre' : 'nessun codice');
  const pairRoom = roomFor(code, 'pair');
  await sleep(800);   // il Mac apre la stanza del codice

  const firstSeen = seen.length;
  // `#p=…` è quello che c'è dentro il QR del pannello: link e codice insieme.
  // Il pezzo dopo il cancelletto non viene spedito a nessun server.
  const pb = await launch(`${PROXY}/#p=${code}`);
  // La pagina puo' non essere ancora pronta al primo giro: si legge con le
  // mani avanti, invece di schiantarsi su un elemento che non c'e' ancora.
  await sleep(800);
  let ps = null;
  for (let i = 0; i < 90; i++) {
    ps = await pb.evalJS('(typeof Net === "undefined") ? { screen: "loading" } : ' +
      '({screen: document.querySelector(".screen:not(.hidden)")?.id, ' +
      'err: document.getElementById("pairError")?.textContent || "", ' +
      'token: !!Net.token, state: Net.state, detail: Net.detail})');
    if (ps.screen === 'list' || (ps.err && !/looking|waiting|connecting|cerco|collego|aspetto/i.test(ps.err))) break;
    await sleep(500);
  }
  const paired = check(ps && ps.token === true && ps.screen === 'list',
    'accoppiato da fuori col solo codice, senza mai passare da casa',
    ps ? (ps.err || 'schermata: ' + ps.screen) : 'nessuno stato');
  if (!paired) {
    console.log('    stato:', JSON.stringify(ps));
    const trace = await pb.evalJS('Net.trace.join("\\n")').catch(() => '');
    if (trace) console.log('    cronaca dal telefono:\n      ' + String(trace).split('\n').join('\n      '));
    await pb.shot('accoppiamento-fallito.png');
  } else {
    // L'app vive davvero, non è solo una schermata cambiata. Appena accoppiato
    // il telefono **rifà** l'appuntamento, stavolta col gettone: mezzo secondo
    // per il canale nuovo più il giro delle API. Si aspetta quello.
    let alive = null;
    for (let i = 0; i < 40; i++) {
      alive = await pb.evalJS('({n: S.chats.length, ws: !!(S.ws && S.ws.readyState === 1), ' +
        'where: Net.where, ms: Net.stats.msToOpen})');
      if (alive.n > 0 && alive.ws) break;
      await sleep(500);
    }
    check(alive.n > 0 && alive.ws, 'e da lì l\'app funziona subito, col gettone',
      alive.n + ' conversazioni · diretta ' + (alive.ws ? 'aperta' : 'chiusa')
      + ' · canale rifatto in ' + alive.ms + ' ms');
    await pb.shot('accoppiamento-da-fuori.png');
  }

  // Cosa ha visto il servizio durante l'accoppiamento: **niente**, e in
  // particolare non le otto cifre. È il controllo nuovo che chiedeva il giro.
  const pairTraffic = seen.slice(firstSeen);
  const pairBytes = Buffer.concat(pairTraffic.map(
    s => Buffer.concat([s.up || Buffer.alloc(0), s.down || Buffer.alloc(0)])));
  const pairAscii = pairBytes.toString('latin1');
  check(!pairAscii.includes(code), 'il codice non compare in ciò che vede il servizio',
    pairBytes.length + ' byte guardati');
  check(!/sdp|v=0|fingerprint|candidate|ice-ufrag/i.test(pairAscii),
    'anche qui le buste sono illeggibili');
  const pairRooms = [...new Set(pairTraffic.map(s => s.url.split('/')[2]))];
  check(pairRooms.includes(pairRoom),
    'la stanza è quella derivata dal codice (HKDF uguale in Node, Swift e browser)');
  check(pairRooms.every(r => /^[A-Za-z0-9_-]{22}$/.test(r)),
    'e resta un nome opaco', pairRooms.join(' '));

  // Una busta manomessa nella stanza del codice non deve aprire niente.
  const pairOffer = pairTraffic.find(s => s.method === 'POST' && s.url.includes(`/${pairRoom}/o`));
  if (pairOffer && pairOffer.up.length) {
    const guasta = Buffer.from(pairOffer.up);
    guasta[guasta.length - 5] ^= 0x40;
    await fetch(`${PROXY}/m/${pairRoom}/o`, { method: 'POST', body: guasta });
    await sleep(2500);
    const risp = await fetch(`${PROXY}/m/${pairRoom}/a`).then(r => r.status);
    check(risp === 204, 'a una busta manomessa nella stanza del codice il Mac non risponde',
      'risposta ' + risp);
  } else {
    check(false, 'busta dell\'accoppiamento registrata');
  }

  // Il telefono di prova lascia il posto invece di restare nell'elenco del
  // Mac a tenere aperta un'attesa lunga. Scollega **solo** sé stesso.
  if (paired) {
    const gone = await pb.evalJS(`(async () => {
      const r = await Net.fetch('/api/forget', {
        method: 'POST', headers: { Authorization: 'Bearer ' + Net.token } });
      return r.status;
    })()`).catch(e => 'errore: ' + e.message);
    check(gone === 200, 'e si scollega da solo a fine prova', 'risposta ' + gone);
  }
  await pb.kill();
  await sleep(600);

  /* ---- la politica di inoltro, guardata tutta insieme ----
     Il canale aperto col codice deve saper fare **una cosa sola**. La pagina
     ponte è la stessa che gira dentro il Mac: gliela si chiede direttamente,
     invece di sperare di indovinare il momento giusto per provarci. */
  const rb = await launch(`${HOST}/host-bridge.html`);
  // Gli script della pagina ponte devono essere arrivati prima di chiederle
  // la politica: al primo giro dopo l'apertura `RB` puo' non esserci ancora.
  for (let i = 0; i < 20; i++) {
    if (await rb.evalJS('typeof RB !== "undefined" && typeof RB.allowed === "function"').catch(() => false)) break;
    await sleep(250);
  }
  const politica = await rb.evalJS(`({
    pairSuPair:   RB.allowed('/api/pair', 'pair'),
    chatsSuPair:  RB.allowed('/api/chats', 'pair'),
    healthSuPair: RB.allowed('/health', 'pair'),
    pinSuPair:    RB.allowed('/api/pin', 'pair'),
    chatsSuGettone: RB.allowed('/api/chats', 'device'),
    pinSuGettone:   RB.allowed('/api/pin', 'device')
  })`).catch(e => ({ errore: e.message }));
  check(politica.pairSuPair === true && politica.chatsSuPair === false
        && politica.healthSuPair === false && politica.pinSuPair === false,
    'col codice si può **solo** accoppiarsi: niente chat, niente diretta, niente PIN',
    JSON.stringify(politica));
  check(politica.chatsSuGettone === true && politica.pinSuGettone === false,
    'col gettone si fa tutto tranne leggere il PIN');
  await rb.kill();

  /* ================================================================
     GIRO B — la vita normale, con un telefono già accoppiato.
     ================================================================ */

  // 3. Chrome nel ruolo del telefono, con la pagina presa dal punto d'incontro
  // Con RF_PUBLIC=1 il browser può usare **solo** l'interfaccia pubblica: gli si
  // toglie la rete di casa, come a un telefono sotto rete mobile. Non è la
  // stessa cosa di un telefono vero fuori — il giro resta dentro il router —
  // ma prova che la strada pubblica funziona davvero.
  const b = await launch(`${PROXY}/#k=${token}&m=${meet}`, {
    args: process.env.RF_PUBLIC
      ? ['--force-webrtc-ip-handling-policy=default_public_interface']
      : [],
  });
  if (process.env.RF_PUBLIC) console.log('  ·    browser con la sola interfaccia pubblica');
  await sleep(1000);

  let state = null;
  for (let i = 0; i < 60; i++) {
    state = await b.evalJS('(typeof Net === "undefined") ? { state: "loading" } : ' +
      '({state: Net.state, where: Net.where, detail: Net.detail, ' +
      'ms: Net.stats.msToOpen, bytes: Net.stats.signalBytes, pair: Net.stats.pair, ' +
      'remote: Net.remote, screen: document.querySelector(".screen:not(.hidden)")?.id})');
    if (state.state === 'open' || state.state === 'failed') break;
    await sleep(500);
  }
  check(state.remote === true, 'la webapp si sa fuori casa');
  if (!check(state.state === 'open', 'canale diretto aperto', state.detail || state.state)) {
    console.log('    stato:', JSON.stringify(state));
    const trace = await b.evalJS('Net.trace.join("\\n")');
    console.log('    cronaca dal telefono:\n      ' + String(trace).split('\n').join('\n      '));
    await b.shot('fuoricasa-fallito.png');
    return done(deno, proxy, b, previous, token, extras);
  }
  console.log(`\n  ⏱  aperto in ${state.ms} ms · appuntamento ${state.bytes} byte · coppia ${state.pair}\n`);
  // Qui le due parti sono sulla stessa macchina: nessun rimbalzo, e il tempo
  // di andata e ritorno di un millisecondo dice «rete locale». Ma quel tempo
  // il browser lo misura solo dopo qualche scambio: la pagina rimisura per
  // qualche secondo, e qui si aspetta che lo dica.
  for (let i = 0; i < 16 && state.where !== 'casa'; i++) {
    await sleep(500);
    state.where = await b.evalJS('Net.where');
  }
  const strada = await b.evalJS(`(async () => {
    const s = await Net.peerStats(); return JSON.stringify(s);
  })()`);
  check(state.where === 'casa', 'collegamento diretto e riconosciuto come locale',
    state.where + ' · ' + String(strada).slice(0, 200));

  // 4. l'app vera dentro il tubo
  await sleep(2500);
  const list = await b.evalJS('({n: S.chats.length, ready: S.listReady, screen: S.screen})');
  check(list.screen === 'list' && list.n > 0, 'elenco chat arrivato dal tubo', list.n + ' conversazioni');

  const opened = await b.evalJS(`(async () => {
    const target = S.chats.find(c => c.readable !== false) || S.chats[0];
    await openChat(target.id, target.title);
    await new Promise(r => setTimeout(r, 2500));
    return { id: S.chat && S.chat.id, items: document.querySelectorAll('#thread .row').length,
             title: S.chat && S.chat.title };
  })()`);
  check(opened.items > 0, 'conversazione aperta dal tubo',
    opened.items + ' blocchi · ' + (opened.title || ''));

  const wsAlive = await b.evalJS('S.ws && S.ws.readyState === 1');
  check(wsAlive === true, 'la diretta (WebSocket) vive dentro il tubo');

  await b.shot('fuoricasa-conversazione.png');

  // 5. il PIN non deve uscire di casa — i due lucchetti: l'endpoint non
  //    esiste piu' (404 sul Mac) e la pagina ponte rifiuta comunque di
  //    inoltrarlo (403 qui dentro, prima ancora di bussare).
  const pinThroughTunnel = await b.evalJS(`(async () => {
    const r = await Net.fetch('/api/pin');
    return { status: r.status, body: await r.text() };
  })()`);
  check(pinThroughTunnel.status === 403, 'il PIN non passa dal tubo',
    'risposta ' + pinThroughTunnel.status);

  // 6. cosa ha visto il punto d'incontro
  const bodies = seen.filter(s => (s.up && s.up.length) || (s.down && s.down.length));
  const all = Buffer.concat(bodies.map(s => Buffer.concat([s.up || Buffer.alloc(0), s.down || Buffer.alloc(0)])));
  const ascii = all.toString('latin1');
  check(bodies.length >= 2, 'il servizio ha visto passare le buste', bodies.length + ' corpi');
  check(!/sdp|v=0|fingerprint|candidate|ice-ufrag/i.test(ascii),
    'le buste sono illeggibili (niente SDP in chiaro)');
  check(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(ascii),
    'nessun indirizzo IP visibile dentro le buste');
  // Nemmeno i due segreti, in tutto quello che è passato dal servizio nei due
  // giri: né il gettone né le otto cifre.
  check(!ascii.includes(token) && !ascii.includes(code) && !(meet && ascii.includes(meet)),
    'né il gettone né il codice né il segreto del Mac compaiono in tutta la registrazione');
  const rooms = [...new Set(seen.map(s => s.url.split('/')[2]).filter(Boolean))];
  check(rooms.every(r => /^[A-Za-z0-9_-]{22}$/.test(r)),
    'le stanze sono nomi opachi', rooms.join(' '));
  check(meet && rooms.includes(roomFor(meet)),
    'la stanza è quella derivata dal segreto del Mac (HKDF uguale in Node, Swift e browser)');
  check(!rooms.includes(roomFor(token)),
    'e non nasce più dal gettone');
  check(!ascii.includes(opaqueId(token)),
    'l\'identificatore del dispositivo sta dentro la busta, il servizio non lo vede');

  const sizes = bodies.map(s => (s.up.length || s.down.length));
  console.log(`  ·    buste: ${sizes.join(' e ')} byte`);

  // 7. una busta manomessa non deve aprirsi. **Nella stanza del gettone**: da
  // quando le stanze sono due, cercare «un POST che finisce per /o» pescava
  // quella dell'accoppiamento e provava due volte la stessa cosa.
  const room = roomFor(meet);
  const offer = seen.find(s => s.method === 'POST' && s.url.includes(`/${room}/o`));
  if (offer && offer.up.length) {
    const tampered = Buffer.from(offer.up);
    tampered[tampered.length - 5] ^= 0x40;                 // un bit dentro il cifrato
    await fetch(`${PROXY}/m/${room}/o`, { method: 'POST', body: tampered });
    await sleep(2500);
    const answer = await fetch(`${PROXY}/m/${room}/a`).then(r => r.status);
    check(answer === 204, 'a una busta manomessa il Mac non risponde', 'risposta ' + answer);
  } else {
    check(false, 'busta dell\'offerta registrata');
  }

  // 8. la console del telefono
  const errs = b.consoleErrors.filter(e => !/favicon/i.test(e));
  check(errs.length === 0 && b.exceptions.length === 0, 'nessun errore in console',
    errs.concat(b.exceptions).slice(0, 2).join(' | '));

  // 9. il freno sul ponte. **Per ultimo**, perché brucia il budget al minuto
  //    di questo indirizzo e da qui in poi il Mac stesso verrebbe rallentato.
  //    Con otto cifre e questo limite, tentare a caso da un indirizzo solo
  //    vuol dire secoli — e il codice intanto vive dieci minuti.
  const finta = 'A'.repeat(22);
  let frenato = 0, passate = 0;
  for (let i = 0; i < 60; i++) {
    const s = await fetch(`${PROXY}/m/${finta}/o`, { cache: 'no-store' }).then(r => r.status);
    if (s === 429) { frenato = i + 1; break; }
    passate++;
  }
  check(frenato > 0, 'il ponte frena chi tenta a raffica',
    frenato ? `429 dopo ${frenato} richieste` : `nessun freno in ${passate} richieste`);

  await done(deno, proxy, b, previous, token, extras);
})().catch(async (e) => {
  console.error('\nERRORE:', e && e.stack || e);
  // Anche quando va male non si lascia niente in piedi: un Chrome dimenticato
  // avvelena il giro dopo. I finti accoppiati di questa prova si scollegheranno
  // da soli; il resto dell'elenco non si tocca.
  for (const t of extrasForCleanup.filter(Boolean)) {
    await hostJSON('/api/forget', {
      method: 'POST', headers: { Authorization: 'Bearer ' + t },
    }).catch(() => {});
  }
  // E il Mac torna sul suo ponte vero, come nel giro che finisce bene.
  if (previousForCleanup && tokenForCleanup) {
    await hostJSON('/api/remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenForCleanup },
      body: JSON.stringify({ on: !!previousForCleanup.on, base: previousForCleanup.base || '' }),
    }).catch(() => {});
    console.error('il Mac e\' tornato sul ponte di prima: ' + (previousForCleanup.base || '(nessuno)'));
  }
  try { require('child_process').execSync('pkill -f riflesso-chrome- || true', { stdio: 'ignore' }); } catch (_) {}
  try { require('child_process').execSync('pkill -f "bridge/main.ts" || true', { stdio: 'ignore' }); } catch (_) {}
  process.exit(1);
});

async function done(deno, proxy, b, previous, token, extras) {
  // I finti di questa prova se ne vanno. Non si tocca nient'altro.
  if (Array.isArray(extras)) {
    for (const t of extras.filter(Boolean)) {
      await hostJSON('/api/forget', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t },
      }).catch(() => {});
    }
  }
  // Si rimette il Mac com'era: se il fuori casa era spento, resta spento.
  if (previous && token) {
    await hostJSON('/api/remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ on: !!previous.on, base: previous.base || '' }),
    }).catch(() => {});
  }
  if (b) await b.kill();
  if (proxy) proxy.close();
  if (deno) deno.kill();
  console.log(`\n=== ${ok} controlli superati · ${bad} falliti ===\n`);
  if (token) {
    console.log('Nota: resta accoppiato **un** dispositivo «Prova fuori casa», riusato a ogni\n'
      + 'giro (il gettone sta in test-output/remote-token.txt). Non lo tolgo da solo:\n'
      + 'si toglie con «Scollega tutti», che però scollega anche il telefono vero.\n'
      + 'I finti «Prova attesa A/B» di questo giro si sono scollegati da soli.\n');
  }
  process.exit(bad === 0 ? 0 : 1);
}
