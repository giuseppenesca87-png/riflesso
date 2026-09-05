'use strict';

/* ------------------------------------------------------------------
   IL RIMBALZO, LATO TELEFONO — la prova di `webapp/net.js` (tappa 1, passo 1.5).

   Cosa deve essere vero, e qui si misura invece di crederlo:

   · la lista dei server ICE si chiede al ponte (`GET /ice?room=<stanza>`)
     **all'avvio della pagina**, per la stanza giusta (quella del codice
     all'accoppiamento, quella del segreto del Mac dopo), e al momento di
     collegarsi è già in tasca: **una** richiesta per stanza, non una per
     collegamento;
   · se il ponte non ha la rotta (ponte vecchio → 404) o tarda (6 s), si parte
     lo stesso con la lista di oggi, entro 2,5 s, e la cronaca lo dice;
   · con un coturn vero in lista, l'offerta porta un candidato `relay`, la
     coppia vincente passa dal rimbalzo, e la riga di stato dice «rimbalzo»
     (`Net.where === 'relay'`, `Net.stats.pair` comincia con «rimbalzo»);
   · con il rimbalzo in lista ma **muto**, si parte 1,5 s dopo il primo
     indirizzo pubblico, non dopo gli otto secondi del tetto.

   Come è fatto il banco: il ponte vero (`bridge/main.ts`) gira in locale con
   `TURN_HOST`/`TURN_SECRET`; davanti c'è un piccolo inoltro che può fingere
   un ponte vecchio o lento; un coturn locale gira sull'indirizzo della en0;
   la parte del Mac la fa **la pagina ponte vera** (`host-bridge.html`, presa
   dal Mac acceso sulla 7654) dentro un Chrome, a cui questo script porge le
   offerte e da cui riporta le risposte — cioè fa quello che fa
   `RemoteLink.swift`, senza toccare né il Mac né il suo ponte. Il telefono è
   un altro Chrome a misura di iPhone, con la pagina presa dal ponte locale.

   Due trappole, scritte qui perché costano una serata a chi le rifà:
   1. coturn su 127.0.0.1 **non vale**: il browser butta via il candidato di
      rimbalzo in silenzio. Si usa l'indirizzo della en0 (`RIFLESSO_TURN_IP`).
   2. su una macchina sola, con i nomi automatici delle reti locali accesi
      (mDNS), la coppia fallisce per un motivo che non c'entra col rimbalzo e
      sembra una bocciatura: qui si spegne quel travestimento in tutti e due i
      Chrome (`--disable-features=WebRtcHideLocalIpsWithMdns`).
   E una differenza dalla produzione: il coturn di qui **non** rifiuta gli
   indirizzi privati (`denied-peer-ip`), perché le due parti stanno entrambe
   su 192.168.x. Il recinto di produzione lo prova `icecheck.js --turn`.

   Vuole: Riflesso acceso (per il codice e per la pagina ponte), Deno, Chrome,
   e `turnserver` (brew install coturn) — senza, i giri col rimbalzo si
   saltano e si dice.

      node tools/rimbalzotest.js
      RIFLESSO_BRIDGE_PORT=8797 RIFLESSO_TURN_IP=192.168.1.131 node tools/rimbalzotest.js
------------------------------------------------------------------ */

const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./browser');
const { pin } = require('./pin');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'http://127.0.0.1:7654';
const BRIDGE_PORT = Number(process.env.RIFLESSO_BRIDGE_PORT) || 8797;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;
const FRONT_PORT = BRIDGE_PORT + 1;
const FRONT = `http://127.0.0.1:${FRONT_PORT}`;
const TURN_PORT = Number(process.env.RIFLESSO_TURN_PORT) || 3478;
const TURN_IP = process.env.RIFLESSO_TURN_IP || lanIPv4();
const TURN_SECRET = crypto.randomBytes(16).toString('hex');
const NO_MDNS = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'riflesso-rimbalzo-'));

let ok = 0, bad = 0, skipped = 0;
const check = (cond, label, extra = '') => {
  if (cond) { ok++; console.log('  ok   ' + label + (extra ? ' · ' + extra : '')); }
  else { bad++; console.log('  NO   ' + label + (extra ? ' · ' + extra : '')); }
  return cond;
};
const skip = (label, why) => { skipped++; console.log('  --   ' + label + ' · saltato: ' + why); };
const info = (m) => console.log('  ·    ' + m);

function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '';
}

/* ---------- le stesse chiavi di net.js, RemoteLink.swift, icecheck.js ---------- */

const SALT = Buffer.from('riflesso.rendezvous.v1');
const MAGIC = Buffer.from([0x52, 0x46, 0x31]); // "RF1"
const b64url = (b) => Buffer.from(b).toString('base64url');

function roomFor(secret, kind) {
  const info = kind === 'pair' ? 'room.pair' : 'room';
  return b64url(crypto.hkdfSync('sha256', Buffer.from(secret), SALT, Buffer.from(info), 16));
}
function sealKey(secret, kind) {
  const info = kind === 'pair' ? 'seal.pair' : 'seal';
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), SALT, Buffer.from(info), 32));
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
  return JSON.parse(Buffer.concat([d.update(bytes.subarray(16, bytes.length - 16)), d.final()]).toString('utf8'));
}
const fingerprintOf = (sdp) => (sdp.match(/a=fingerprint:(\S+ \S+)/i) || [])[1] || '';

/* ---------- l'inoltro davanti al ponte ----------
   Passa tutto al ponte locale e **registra** le richieste a `/ice`. Su
   comando finge un ponte vecchio (404) o lento (6 s), o un rimbalzo muto
   (stessa credenziale, porta sbagliata): sono i casi che il telefono deve
   reggere e che un ponte vero non sa fingere. */

const front = { ice: 'pass', iceLog: [] };   // pass · missing · slow · mute

function startFront() {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const isIce = req.url.startsWith('/ice');
      if (isIce) {
        const room = new URL(req.url, FRONT).searchParams.get('room') || '';
        front.iceLog.push({ room, at: Date.now(), mode: front.ice });
        if (front.ice === 'missing') { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end('Not found'); }
        if (front.ice === 'slow') await sleep(6000);
      }
      const out = http.request({
        host: '127.0.0.1', port: BRIDGE_PORT, path: req.url, method: req.method,
        headers: Object.assign({}, req.headers, { host: `127.0.0.1:${BRIDGE_PORT}` }),
      }, (up) => {
        const back = [];
        up.on('data', (c) => back.push(c));
        up.on('end', () => {
          let payload = Buffer.concat(back);
          if (isIce && front.ice === 'mute') {
            // La porta accanto: nessuno risponde, il rimbalzo resta muto.
            payload = Buffer.from(payload.toString('utf8').replace(new RegExp(':' + TURN_PORT + '\\?', 'g'), ':' + (TURN_PORT + 7) + '?'));
          }
          const headers = Object.assign({}, up.headers);
          delete headers['content-length'];
          res.writeHead(up.statusCode, headers);
          res.end(payload);
        });
      });
      out.on('error', () => { try { res.writeHead(502); res.end(); } catch (e) {} });
      const drop = () => { if (!out.destroyed) out.destroy(); };
      req.on('aborted', drop);
      res.on('close', drop);
      out.end(body);
    });
  });
  return new Promise((r) => srv.listen(FRONT_PORT, '127.0.0.1', () => r(srv)));
}

/* ---------- il coturn locale ---------- */

function startTurn() {
  let bin = '';
  try { bin = execSync('which turnserver', { encoding: 'utf8' }).trim(); } catch (e) { return null; }
  if (!bin || !TURN_IP) return null;
  const conf = path.join(SCRATCH, 'turnserver.conf');
  fs.writeFileSync(conf, [
    `listening-ip=${TURN_IP}`, `relay-ip=${TURN_IP}`, `external-ip=${TURN_IP}`,
    `listening-port=${TURN_PORT}`, 'min-port=49200', 'max-port=49400',
    'no-tls', 'no-dtls', 'no-cli', 'fingerprint', 'use-auth-secret',
    `static-auth-secret=${TURN_SECRET}`, 'realm=riflesso',
    'user-quota=12', 'total-quota=100', 'no-multicast-peers', 'no-loopback-peers',
    'verbose', 'simple-log', `log-file=${path.join(SCRATCH, 'turn.log')}`, `pidfile=${path.join(SCRATCH, 'turn.pid')}`,
    '',
  ].join('\n'));
  const proc = spawn(bin, ['-c', conf], { stdio: 'ignore' });
  return { proc, log: () => { try { return fs.readFileSync(path.join(SCRATCH, 'turn.log'), 'utf8'); } catch (e) { return ''; } } };
}

/** Un `Binding` STUN a mano: coturn è su? */
function stunAlive(ip, port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const end = (v) => { if (done) return; done = true; try { s.close(); } catch (e) {} resolve(v); };
    s.on('message', (m) => end(m.readUInt16BE(0) === 0x0101));
    s.on('error', () => end(false));
    s.send(Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), crypto.randomBytes(12)]), port, ip);
    setTimeout(() => end(false), 2000);
  });
}

/* ---------- la parte del Mac: la pagina ponte vera, pilotata da qui ----------
   `RemoteLink.swift` prende la busta dalla cassetta, la apre, porge l'SDP a
   `RB.answer`, sigilla la risposta e la posa. Qui si fa lo stesso, in Node. */

const ICE_MAC = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.nextcloud.com:3478', 'stun:stun.sipgate.net:3478'] }];

async function fakeMac() {
  const rb = await launch(`${HOST}/host-bridge.html`, { args: NO_MDNS });
  for (let i = 0; i < 40; i++) {
    if (await rb.evalJS('typeof RB !== "undefined" && typeof RB.answer === "function"').catch(() => false)) break;
    await sleep(250);
  }
  const listeners = [];
  const mac = {
    offers: [],   // { room, kind, sdp, at }
    /** Sta appeso alla cassetta della stanza e risponde a ogni offerta, finché
        non lo si ferma. È questa attesa che tiene «viva» la stanza per `/ice`. */
    listen(room, keysOrGetter, kind) {
      const ctl = { on: true };
      (async () => {
        while (ctl.on) {
          let env = null;
          try {
            const res = await fetch(`${BRIDGE}/m/${room}/o?w=10`, { cache: 'no-store' });
            if (res.status === 200) env = Buffer.from(await res.arrayBuffer());
          } catch (e) { await sleep(300); }
          if (!env || !env.length || !ctl.on) continue;
          // Le chiavi possono arrivare dopo la busta (la stanza del gettone si
          // ascolta PRIMA che il telefono abbia il gettone, come fa il Mac):
          // la busta si tiene in mano finché non si sanno.
          const keys = typeof keysOrGetter === 'function' ? await keysOrGetter() : keysOrGetter;
          let offer;
          try { offer = unseal(keys, 'o', env); } catch (e) { info('busta non apribile nella stanza ' + room.slice(0, 6) + '…'); continue; }
          mac.offers.push({ room, kind, sdp: offer.sdp, at: Date.now() });
          try {
            const sdp = await rb.evalJS(`RB.answer(${JSON.stringify(offer.sdp)}, ${JSON.stringify(ICE_MAC)}, ${JSON.stringify(kind)})`);
            const body = seal(keys, 'a', { t: 'answer', sdp, fp: fingerprintOf(sdp), ts: Date.now(), n: offer.n });
            await fetch(`${BRIDGE}/m/${room}/a`, { method: 'POST', body });
          } catch (e) { info('la pagina ponte non ha risposto: ' + e.message); }
        }
      })();
      listeners.push(ctl);
      return ctl;
    },
    async kill() { listeners.forEach((l) => { l.on = false; }); await rb.kill(); },
  };
  return mac;
}

/* ---------- il telefono ---------- */

async function phone(url, opts = {}) {
  const b = await launch('about:blank', { args: NO_MDNS });
  if (opts.forceRelay) {
    // `Net.forceRelay` va messo **prima** che la pagina si colleghi, e la
    // pagina si collega da sola all'avvio: si intercetta il momento in cui
    // net.js pubblica `Net`, senza toccare la pagina.
    await b.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(window, 'Net', { configurable: true, get() { return undefined; },
        set(v) { v.forceRelay = true; Object.defineProperty(window, 'Net', { value: v, writable: true, configurable: true }); } });` });
  }
  await b.goto(url);
  return b;
}

async function waitFor(b, expr, pred, tries = 60, every = 500) {
  let v = null;
  for (let i = 0; i < tries; i++) {
    v = await b.evalJS(expr).catch(() => null);
    if (v && pred(v)) return v;
    await sleep(every);
  }
  return v;
}

const STATE = `({ screen: (document.querySelector('.screen:not(.hidden)') || {}).id, n: (typeof S !== 'undefined' && S.chats || []).length,
   ws: !!(typeof S !== 'undefined' && S.ws && S.ws.readyState === 1), state: Net.state, where: Net.where, detail: Net.detail,
   pair: Net.stats.pair, ms: Net.stats.msToOpen, ice: Net.ice, token: Net.token, meet: Net.meet,
   text: (document.getElementById('statusText') || {}).textContent || '', trace: Net.trace.slice() })`;

const traceLine = (st, re) => (st && st.trace || []).find((l) => re.test(l)) || '';
const gatherMs = (st) => { const m = traceLine(st, /indirizzi:/).match(/(\d+) ms$/); return m ? Number(m[1]) : -1; };

/* ---------- il giro ---------- */

(async () => {
  console.log('\n=== IL RIMBALZO, LATO TELEFONO ===\n');

  const health = await fetch(`${HOST}/health`).then((r) => r.json()).catch(() => null);
  if (!check(health && health.app === 'Riflesso', 'Riflesso acceso sulla 7654')) return done(1);

  // Il ponte locale serve `bridge/public`: deve essere la webapp di adesso.
  execSync('bash ' + JSON.stringify(path.join(ROOT, 'tools/bridge-sync.sh')), { stdio: 'ignore' });

  const turn = startTurn();
  const deno = spawn('deno', ['run', '--allow-net', '--allow-read', '--allow-env', '--unstable-kv', path.join(ROOT, 'bridge/main.ts')], {
    env: Object.assign({}, process.env, {
      PORT: String(BRIDGE_PORT), BIND: '127.0.0.1',
      TURN_HOST: turn ? `${TURN_IP}:${TURN_PORT}` : '', TURN_SECRET: turn ? TURN_SECRET : '',
    }),
    stdio: 'ignore',
  });
  const frontSrv = await startFront();
  await sleep(1500);

  const bh = await fetch(`${FRONT}/health`).then((r) => r.json()).catch(() => null);
  if (!check(bh && bh.app === 'riflesso-bridge', 'il ponte locale risponde dietro l\'inoltro', bh ? 'relay offerto: ' + bh.relay : '')) return done(2);
  let turnUp = false;
  if (turn) {
    turnUp = await stunAlive(TURN_IP, TURN_PORT);
    check(turnUp, `coturn locale in ascolto su ${TURN_IP}:${TURN_PORT}`);
  } else {
    info('turnserver non trovato (brew install coturn): i giri col rimbalzo si saltano');
  }

  // Stanza morta: la lista di oggi, senza rimbalzo. È la porta d'ingresso.
  const dead = await fetch(`${FRONT}/ice?room=${b64url(crypto.randomBytes(16))}`).then((r) => r.json()).catch(() => null);
  check(dead && dead.relay === false && dead.iceServers.length === 1, '/ice per una stanza morta: lista di oggi, relay:false');
  front.iceLog.length = 0;

  const mac = await fakeMac();
  const cleanup = { mac, deno, frontSrv, turn, token: '' };
  process.on('SIGINT', () => done(130, cleanup));

  /* ================================================================
     GIRO 1 — accoppiamento col codice, senza rimbalzo (coturn c'è, ma la
     lista lo porta: qui si guarda **quando** si chiede, e che senza bisogno la
     strada resti diretta).
     ================================================================ */
  console.log('\n-- giro 1: accoppiamento dal ponte, /ice all\'avvio, lista in tasca --');
  let code = '';
  try { code = pin(); } catch (e) { /* sotto */ }
  if (!check(code.length === 8, 'codice letto dal Mac')) return done(1, cleanup);
  const pairRoom = roomFor(code, 'pair');
  const pairKeys = { room: pairRoom, seal: sealKey(code, 'pair') };
  const pairListen = mac.listen(pairRoom, pairKeys, 'pair');
  // La stanza del gettone il Mac vero la ascolta SEMPRE, prima e a prescindere
  // da chi si accoppia: per farlo anche qui serve sapere il segreto del Mac
  // prima che il telefono lo riceva. Lo dice `/api/status` a un dispositivo
  // di appoggio, che a fine giro si scollega.
  const helper = await fetch(`${HOST}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: code, label: 'prova-rimbalzo-appoggio' }) }).then((r) => r.json()).catch(() => null);
  const helperTok = (helper && helper.token) || '';
  const meet0 = helperTok ? (await fetch(`${HOST}/api/status`, { headers: { Authorization: 'Bearer ' + helperTok } }).then((r) => r.json()).catch(() => ({}))).meet || '' : '';
  if (!check(meet0.length === 64, 'il segreto del Mac letto da un dispositivo di appoggio')) return done(1, cleanup);
  cleanup.helper = helperTok;
  const devRoom = roomFor(meet0, 'device');
  const holder = { keys: null };
  const devKeysWhenKnown = async () => { for (let i = 0; i < 120 && !holder.keys; i++) await sleep(250); return holder.keys; };
  const devListen = mac.listen(devRoom, devKeysWhenKnown, 'device');
  await sleep(600);   // le attese devono essere aperte prima che il telefono chieda /ice

  const t0 = Date.now();
  let p = await phone(`${FRONT}/#p=${code}`);
  let st = await waitFor(p, STATE, (v) => v.token && v.meet, 60);
  const paired = check(st && st.token && st.meet, 'accoppiato dal ponte locale col solo codice', st ? ('schermata ' + st.screen) : '');
  if (!paired) { console.log('    cronaca:\n      ' + (st && st.trace || []).join('\n      ')); await p.shot('rimbalzo-accoppiamento-fallito.png'); return done(1, cleanup); }
  cleanup.token = st.token;
  const token = st.token, meet = st.meet;
  check(meet === meet0 && roomFor(meet, 'device') === devRoom, 'il telefono ha ricevuto lo stesso segreto del Mac');
  holder.keys = { room: devRoom, seal: sealKey(token, 'device') };

  st = await waitFor(p, STATE, (v) => v.n > 0 && v.ws, 60);
  check(st && st.n > 0 && st.ws, 'e poi vive col gettone: elenco e diretta dentro il tubo',
    st ? `${st.n} conversazioni · canale in ${st.ms} ms · ${st.pair} · ${st.where}` : '');

  // /ice: chiesto all'avvio per la stanza del codice, PRIMA dell'offerta.
  const icePair = front.iceLog.filter((r) => r.room === pairRoom);
  const firstPairOffer = mac.offers.find((o) => o.room === pairRoom);
  check(icePair.length >= 1, '/ice chiesto per la stanza del codice', icePair.length ? `${icePair[0].at - t0} ms dopo l'apertura` : 'mai');
  check(icePair.length && firstPairOffer && icePair[0].at <= firstPairOffer.at,
    'e chiesto **prima** che l\'offerta partisse', firstPairOffer && icePair.length ? `${firstPairOffer.at - icePair[0].at} ms prima` : '');
  // Poi per la stanza del gettone, appena si sa il segreto del Mac: una sola
  // volta, e prima dell'offerta col gettone.
  const iceDev = front.iceLog.filter((r) => r.room === devRoom);
  const firstDevOffer = mac.offers.find((o) => o.room === devRoom);
  check(iceDev.length === 1, '/ice chiesto UNA volta per la stanza del gettone (prefetch, poi in tasca)', iceDev.length + ' richieste');
  check(iceDev.length && firstDevOffer && iceDev[0].at <= firstDevOffer.at, 'e prima dell\'offerta col gettone');
  const rooms = new Set(front.iceLog.map((r) => r.room));
  check([...rooms].every((r) => r === pairRoom || r === devRoom), 'nessuna stanza sconosciuta chiesta a /ice', [...rooms].length + ' stanze');
  check(st && st.ice && st.ice.from === 'ponte' && st.ice.room === devRoom && st.ice.relay === !!turnUp,
    'la lista usata viene dal ponte, per la stanza del gettone' + (turnUp ? ', col rimbalzo' : ''), JSON.stringify(st && st.ice));
  const listed = traceLine(st, /lista ICE dal ponte/);
  check(/con rimbalzo/.test(listed) === !!turnUp, 'la cronaca dice se il ponte ha dato il rimbalzo', listed);
  check(st && st.where !== 'relay' && !/rimbalzo|relay/.test(st.pair), 'in casa la coppia vincente NON è il rimbalzo (anche se in lista)', st && st.pair);
  const g1 = traceLine(st, /indirizzi:/);
  check(turnUp ? /rimbalzo|raccolta finita/.test(g1) : /pubblico|raccolta finita/.test(g1), 'attesa degli indirizzi: la regola giusta è scattata', g1);

  const gone1 = await p.evalJS(`(async () => (await Net.fetch('/api/status', { headers: { Authorization: 'Bearer ' + Net.token } })).status)()`).catch(() => 0);
  check(gone1 === 200, 'una richiesta API passa nel tubo', 'stato ' + gone1);
  pairListen.on = false;
  await p.kill();
  await sleep(500);

  /* ================================================================
     GIRO 2 — ponte vecchio: /ice non esiste. Si parte con la lista di oggi.
     ================================================================ */
  console.log('\n-- giro 2: ponte senza la rotta /ice (404) --');
  front.ice = 'missing';
  front.iceLog.length = 0;
  p = await phone(`${FRONT}/#k=${token}&m=${meet}`);
  st = await waitFor(p, STATE, (v) => v.n > 0 && v.ws, 60);
  check(st && st.n > 0 && st.ws, 'si collega lo stesso', st ? `${st.ms} ms · ${st.pair}` : '');
  check(st && st.ice && /ripiego/.test(st.ice.from) && st.ice.relay === false, 'con la lista di oggi, e lo dice', JSON.stringify(st && st.ice));
  check(!!traceLine(st, /non ha la rotta/), 'la cronaca nomina il motivo', traceLine(st, /lista ICE/));
  check(/pubblico|raccolta finita/.test(traceLine(st, /indirizzi:/)), 'attesa: primo indirizzo pubblico + 250 ms', traceLine(st, /indirizzi:/));
  await p.kill();
  await sleep(500);

  /* ================================================================
     GIRO 3 — ponte lento: /ice risponde dopo 6 s. Non si aspetta più di 2,5.
     ================================================================ */
  console.log('\n-- giro 3: ponte lento su /ice (6 s) --');
  front.ice = 'slow';
  front.iceLog.length = 0;
  const t3 = Date.now();
  p = await phone(`${FRONT}/#k=${token}&m=${meet}`);
  st = await waitFor(p, STATE, (v) => v.n > 0 && v.ws, 60);
  const opened3 = Date.now() - t3;
  check(st && st.n > 0 && st.ws, 'si collega lo stesso', `${opened3} ms dall'apertura della pagina`);
  check(!!traceLine(st, /il ponte tarda/), 'senza aspettare il ponte oltre 2,5 s, e lo dice', traceLine(st, /il ponte tarda/));
  check(opened3 < 6000, 'il canale è aperto prima che il ponte lento abbia risposto');
  await p.kill();
  await sleep(500);
  front.ice = 'pass';

  /* ================================================================
     GIRO 4 — col rimbalzo vero: strada diretta vietata (`Net.forceRelay`),
     la coppia deve passare da coturn e la riga di stato deve dirlo.
     ================================================================ */
  console.log('\n-- giro 4: il rimbalzo vero (coturn locale, strada diretta vietata) --');
  if (!turnUp) {
    skip('offerta con candidato relay', 'coturn assente');
    skip('coppia vincente = rimbalzo, riga di stato «rimbalzo»', 'coturn assente');
  } else {
    front.iceLog.length = 0;
    const before = mac.offers.length;
    p = await phone(`${FRONT}/#k=${token}&m=${meet}`, { forceRelay: true });
    st = await waitFor(p, STATE, (v) => v.n > 0 && v.ws, 60);
    check(st && st.n > 0 && st.ws, 'si collega passando dal rimbalzo', st ? `${st.ms} ms · ${st.pair}` : (st && st.detail) || '');
    const offer4 = mac.offers.slice(before).find((o) => o.room === devRoom);
    check(offer4 && / typ relay /.test(offer4.sdp), 'l\'offerta porta un candidato relay',
      offer4 ? (offer4.sdp.match(/a=candidate:.*typ relay.*/g) || []).length + ' candidati relay' : 'nessuna offerta');
    check(offer4 && !/ typ (host|srflx) /.test(offer4.sdp), 'e nessun altro (strada diretta vietata: la prova vale)');
    check(st && st.where === 'relay', 'Net.where dice relay', st && st.where);
    check(st && /^(rimbalzo|relay) · /.test(st.pair), 'Net.stats.pair comincia con «rimbalzo»', st && st.pair);
    check(st && /rimbalzo|relay/i.test(st.text), 'la riga di stato dice «rimbalzo»', st && st.text);
    check(/rimbalzo|raccolta finita/.test(traceLine(st, /indirizzi:/)), 'attesa: rimbalzo + 250 ms, o raccolta già finita', traceLine(st, /indirizzi:/));
    const r = await p.evalJS(`(async () => { const t0 = performance.now(); const res = await Net.fetch('/api/chats', { headers: { Authorization: 'Bearer ' + Net.token } }); const t = await res.text(); return { status: res.status, byte: t.length, ms: Math.round(performance.now() - t0) }; })()`).catch((e) => ({ errore: e.message }));
    check(r.status === 200, 'l\'elenco passa intero dal rimbalzo', r.status ? `${r.byte} byte in ${r.ms} ms` : r.errore);
    await sleep(1500);
    const tlog = turn.log();
    const allocs = (tlog.match(/session \d+: (new|realm)/gi) || []).length;
    check(allocs > 0, 'coturn ha registrato un\'allocazione', allocs + ' sessioni');
    await p.shot('rimbalzo-relay.png');
    await p.kill();
    await sleep(500);
  }

  /* ================================================================
     GIRO 5 — rimbalzo in lista ma muto (porta sbagliata): si parte 1,5 s dopo
     il primo indirizzo pubblico, non dopo gli otto secondi del tetto.
     ================================================================ */
  console.log('\n-- giro 5: rimbalzo in lista ma muto --');
  if (!turnUp) {
    skip('attesa col rimbalzo muto', 'coturn assente (la lista non lo porterebbe)');
  } else {
    front.ice = 'mute';
    front.iceLog.length = 0;
    p = await phone(`${FRONT}/#k=${token}&m=${meet}`);
    st = await waitFor(p, STATE, (v) => v.n > 0 && v.ws, 60);
    check(st && st.n > 0 && st.ws, 'si collega lo stesso, in diretta', st ? `${st.ms} ms · ${st.pair}` : '');
    const g5 = traceLine(st, /indirizzi:/);
    const ms5 = gatherMs(st);
    check(/rimbalzo muto|raccolta finita/.test(g5), 'la regola scattata è «pubblico, rimbalzo muto» (o raccolta finita)', g5);
    check(ms5 >= 0 && ms5 < 6000, 'ben sotto il tetto degli otto secondi', ms5 + ' ms');
    check(st && st.where !== 'relay', 'e non dice rimbalzo', st && st.where);
    await p.kill();
    front.ice = 'pass';
  }

  devListen.on = false;
  return done(0, cleanup);
})().catch((e) => { console.error('errore nel collaudo:', e); done(2); });

async function done(code, c) {
  if (c) {
    // Il telefono di prova e il dispositivo di appoggio lasciano il posto sul
    // Mac, come negli altri collaudi.
    for (const tok of [c.token, c.helper]) {
      if (tok) await fetch(`${HOST}/api/forget`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {});
    }
    if (c.mac) await c.mac.kill().catch(() => {});
    if (c.frontSrv) c.frontSrv.close();
    if (c.deno) c.deno.kill();
    if (c.turn) c.turn.proc.kill();
  }
  await sleep(300);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const tot = ok + bad;
  console.log('\n=== ' + (bad === 0 ? `tutti i controlli superati (${tot})` : `${bad} controlli falliti su ${tot}`) +
    (skipped ? ` · ${skipped} saltati` : '') + ' ===');
  process.exit(code || (bad ? 1 : 0));
}
