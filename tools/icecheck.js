'use strict';

/* ------------------------------------------------------------------
   Che indirizzi mette il Mac nella risposta — misurati, non immaginati.

   Fa la parte del telefono senza essere un telefono: posa nella stanza del
   codice un'offerta finta ma valida, aspetta la risposta vera del Mac, la apre
   e stampa **ogni candidato**, con tipo, famiglia e indirizzo. Non apre nessun
   collegamento: serve solo a leggere quello che il Mac dichiara di essere.

   È la domanda a cui non si può rispondere a occhio: se gli indirizzi di casa
   escono offuscati (`xxxx.local`, il travestimento mDNS dei browser), da fuori
   sono carta straccia — un telefono in 4G non può risolverli — e resta in piedi
   solo la strada IPv4 col rimbalzo del NAT.

       node tools/icecheck.js                 # col codice letto dal Mac
       node tools/icecheck.js --stun          # anche: quali STUN rispondono, e su che famiglia
       node tools/icecheck.js --turn          # il collaudo del rimbalzo (coturn): vedi più sotto
       node tools/icecheck.js --turn --local  # lo stesso, contro un coturn e un ponte accesi qui

   Vuole Riflesso acceso (per il codice) e il ponte raggiungibile. La parte
   `--turn` no: parla da sola con coturn e col ponte, senza Mac.
------------------------------------------------------------------ */

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns').promises;

const { pin } = require('./pin');

const HOST = 'http://127.0.0.1:7654';
// Il ponte da interrogare: il tuo (`RIFLESSO_BRIDGE=https://…`), oppure uno
// locale (`PORT=8787 BIND=127.0.0.1 deno run … bridge/main.ts`).
const BRIDGE = (process.env.RIFLESSO_BRIDGE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SALT = Buffer.from('riflesso.rendezvous.v1');
const MAGIC = Buffer.from([0x52, 0x46, 0x31]); // "RF1"

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- le stesse chiavi di net.js e RemoteLink.swift ---------- */

function derive(secret, kind) {
  const info = kind === 'pair'
    ? { room: 'room.pair', seal: 'seal.pair' }
    : { room: 'room', seal: 'seal' };
  const ikm = Buffer.from(secret, 'utf8');
  const room = b64url(Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, Buffer.from(info.room), 16)));
  const seal = Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, Buffer.from(info.seal), 32));
  return { room, seal };
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

/* ---------- un'offerta finta ma buona ----------
   Non deve funzionare: deve solo essere abbastanza vera perché WebKit accetti
   di rispondere. Nessun candidato dentro: quelli che interessano sono i suoi. */

function fakeOffer() {
  const hex = crypto.randomBytes(32).toString('hex').toUpperCase().match(/../g).join(':');
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:' + crypto.randomBytes(3).toString('hex'),
    'a=ice-pwd:' + crypto.randomBytes(12).toString('hex'),
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 ' + hex,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

/* ---------- leggere una risposta SDP ---------- */

/** Una riga `a=candidate:` a pezzi. Il quinto campo è l'indirizzo: se finisce
    per `.local` è il travestimento mDNS, cioè un nome che solo la rete di casa
    sa sciogliere. */
function candidates(sdp) {
  const out = [];
  for (const raw of sdp.replace(/\r\n/g, '\n').split('\n')) {
    const l = raw.trim();
    if (!l.startsWith('a=candidate:')) continue;
    const f = l.slice('a=candidate:'.length).split(/\s+/);
    const address = f[4];
    const type = (l.match(/ typ (\w+)/) || [])[1] || '?';
    const mdns = /\.local$/i.test(address);
    const family = mdns ? 'mDNS' : (address.includes(':') ? 'IPv6' : 'IPv4');
    out.push({ type, family, address, port: f[5], proto: f[2], mdns, line: l });
  }
  return out;
}

/* ---------- STUN a mano, per sapere chi risponde e su che famiglia ---------- */

function stunProbe(host, port, family, reuse) {
  return new Promise(async (resolve) => {
    let addr;
    try {
      const r = await dns.lookup(host, { family });
      addr = r.address;
    } catch (e) {
      return resolve({ host, family, ok: false, why: family === 6 ? 'nessun AAAA' : 'nessun A' });
    }
    const sock = reuse || dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    const tid = crypto.randomBytes(12);
    const req = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]);
    const t0 = Date.now();
    const done = (r) => {
      clearTimeout(timer);
      sock.removeAllListeners('message');
      if (!reuse) { try { sock.close(); } catch (e) {} }
      resolve(r);
    };
    const timer = setTimeout(() => done({ host, addr, family, ok: false, why: 'nessuna risposta in 2,5 s' }), 2500);
    sock.on('error', (e) => done({ host, addr, family, ok: false, why: e.code || e.message }));
    sock.on('message', (msg) => {
      // XOR-MAPPED-ADDRESS (0x0020): l'unico attributo che ci interessa.
      let i = 20;
      while (i + 4 <= msg.length) {
        const t = msg.readUInt16BE(i), len = msg.readUInt16BE(i + 2);
        const v = msg.subarray(i + 4, i + 4 + len);
        if (t === 0x0020 && v.length >= 8) {
          const fam = v[1];
          const xport = v.readUInt16BE(2) ^ 0x2112;
          let ip;
          if (fam === 0x01) {
            const b = Buffer.from(v.subarray(4, 8));
            for (let k = 0; k < 4; k++) b[k] ^= req[4 + k];
            ip = [...b].join('.');
          } else {
            const key = Buffer.concat([req.subarray(4, 8), tid]);
            const b = Buffer.from(v.subarray(4, 20));
            for (let k = 0; k < 16; k++) b[k] ^= key[k];
            ip = b.toString('hex').match(/..../g).join(':').replace(/\b:?(?:0+:?){2,}/, '::');
          }
          return done({ host, addr, family, ok: true, ms: Date.now() - t0, mapped: `${ip}:${xport}` });
        }
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      done({ host, addr, family, ok: false, why: 'risposta senza indirizzo' });
    });
    sock.send(req, port, addr);
  });
}

/* ---------- il giro ---------- */

const STUN_LIST = [
  ['stun.l.google.com', 19302],
  ['stun1.l.google.com', 19302],
  ['stun.nextcloud.com', 3478],
  ['stun.sipgate.net', 3478],
];

async function stunReport() {
  console.log('\n== STUN: chi risponde, e su che famiglia ==');
  for (const [host, port] of STUN_LIST) {
    for (const family of [4, 6]) {
      const r = await stunProbe(host, port, family);
      const tag = `  ${r.ok ? 'ok  ' : 'NO  '} ${host}:${port} v${family}`.padEnd(46);
      console.log(tag + (r.ok ? `${r.ms} ms · mi vede come ${r.mapped}` : r.why));
    }
  }
}

/** **Che NAT c'è davanti.** La domanda a cui non si risponde a occhio, e da cui
    dipende tutto: si chiede lo stesso a due STUN diversi **dalla stessa porta**.
    Se rispondono lo stesso indirizzo, il NAT tiene una porta sola per chi sta
    dentro e il buco si può fare (mappatura indipendente dalla destinazione). Se
    rispondono porte diverse è **simmetrico**: ogni destinazione ha una porta
    nuova, quindi non c'è nessuna porta da dire all'altro, e il collegamento
    diretto in IPv4 non esiste — serve il rimbalzo. */
async function natReport() {
  console.log('\n== che NAT c\'è davanti (stessa porta, due STUN) ==');
  const pairs = [['stun.l.google.com', 19302], ['stun.nextcloud.com', 3478]];
  for (const family of [4, 6]) {
    const sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    await new Promise((r) => sock.bind(0, r));
    const seen = [];
    for (const [host, port] of pairs) {
      const got = await stunProbe(host, port, family, sock);
      if (got.ok) seen.push(got.mapped);
    }
    try { sock.close(); } catch (e) {}
    const label = `  IPv${family}`.padEnd(10);
    if (seen.length < 2) { console.log(label + 'non misurabile: ' + (seen[0] || 'nessuna risposta')); continue; }
    const same = seen[0] === seen[1];
    console.log(label + (same
      ? `mappatura indipendente · ${seen[0]} · il buco si può fare`
      : `**simmetrico** · ${seen[0]} ≠ ${seen[1]} · in diretta non si passa`));
  }
}

/* ==================================================================
   --turn: IL COLLAUDO DEL RIMBALZO (coturn), passo 1.6 del mandato.

   Fa la parte del telefono senza browser: parla STUN/TURN a mano, in UDP e in
   TCP, con la credenziale a scadenza che conia il ponte (TURN REST: nome
   `<scadenza>:<8 caratteri>`, password HMAC-SHA1 del segreto). Prova, e
   FALLISCE se non è così:

     - allocazione vera, nei suoi due giri (401 con realm e nonce, poi 200),
       in UDP e in TCP, con l'indirizzo di rimbalzo = relay-ip e la porta nel
       recinto 49200-49400;
     - credenziale sbagliata → rifiutata; credenziale scaduta → rifiutata;
     - permesso verso 192.168.1.1, 172.17.0.1, 10.0.0.5, 127.0.0.1, l'IPv4
       della macchina e l'IPv6 della macchina → tutti rifiutati;
     - allocazione IPv6 → rifiutata (il rimbalzo parla solo IPv4: è ciò che
       chiude la strada «coturn puntato contro la macchina stessa»);
     - permesso verso 8.8.8.8 → CONCESSO. È la superficie che resta (una sponda
       verso Internet, frenata a 250 kB/s), e deve restare visibile qui;
     - /ice per una stanza morta → nessun rimbalzo; /ice senza le variabili →
       la lista di oggi; /ice per una stanza VIVA → una credenziale che coturn
       accetta davvero (la catena intera, ponte → coturn).

   DUE TRAPPOLE, per chi rifà queste prove e ci perde una serata:

     1. Con coturn su 127.0.0.1 il browser BUTTA VIA il candidato di rimbalzo
        in silenzio, senza errore: l'offerta esce senza `typ relay` e sembra
        che il rimbalzo non funzioni. Questo collaudo non passa dal browser e
        non se ne accorge: per la prova nel browser coturn va messo su un
        indirizzo che non sia di loopback (`--local` usa quello di installa.sh,
        cioè l'indirizzo dell'interfaccia di rete, per esempio 192.168.1.131).
     2. Su una macchina sola, con i nomi automatici delle reti locali accesi
        (i candidati `xxxx.local`, il travestimento mDNS dei browser), la
        coppia telefono+Mac fallisce per un motivo che non c'entra niente col
        rimbalzo — i due lati non sanno sciogliere i nomi l'uno dell'altro — e
        sembra una bocciatura del rimbalzo. Non lo è.

   Da dove prende i dati:
     --local           accende qui un coturn (brew) e DUE ponti Deno — uno con
                       TURN_HOST/TURN_SECRET, uno senza — dopo aver fatto
                       girare bridge/coturn/installa.sh in test-output/rimbalzo/.
                       È la prova completa, senza VPS.
     senza --local     legge bridge/coturn/.env (o RIFLESSO_TURN_ENV=<file>, o
                       le variabili TURN_HOST, TURN_SECRET, TURN_IPV4,
                       TURN_IPV6) e interroga il ponte RIFLESSO_BRIDGE. Per la
                       prova «senza variabili» accende comunque un Deno locale
                       nudo, se c'è.
   ================================================================== */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STUN_MAGIC = 0x2112a442;
const ATTR = {
  USERNAME: 0x0006, MI: 0x0008, ERROR: 0x0009, XPEER: 0x0012, REALM: 0x0014,
  NONCE: 0x0015, XRELAY: 0x0016, RAF: 0x0017, RTRANS: 0x0019, XMAPPED: 0x0020,
  LIFETIME: 0x000d, FP: 0x8028,
};
const MSG = { BINDING: 0x0001, ALLOCATE: 0x0003, REFRESH: 0x0004, CREATEPERM: 0x0008 };
const TURN_PORTS = { min: 49200, max: 49400 };   // come turnserver.conf
const ICE_OGGI = ['stun:stun.l.google.com:19302', 'stun:stun.nextcloud.com:3478', 'stun:stun.sipgate.net:3478'];

/* ---------- .env di bridge/coturn ---------- */

function leggiEnv(file) {
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

/* ---------- STUN/TURN: solo quello che serve, scritto a mano ----------
   Niente dipendenze: sono venti righe di codifica, e così il collaudo dice
   esattamente cosa ha mandato e cosa ha ricevuto. */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function ip4Bytes(s) { return Buffer.from(s.split('.').map(Number)); }
function ip6Bytes(s) {
  // espande `::`, che è l'unica cosa che rende un IPv6 scomodo da leggere
  let [a, b] = s.split('::');
  const left = a ? a.split(':') : [];
  const right = b ? b.split(':') : [];
  const fill = b === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
  const words = [...left, ...fill, ...right];
  const out = Buffer.alloc(16);
  words.forEach((w, i) => out.writeUInt16BE(parseInt(w || '0', 16), i * 2));
  return out;
}
function tlv(t, v) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(t, 0); h.writeUInt16BE(v.length, 2);
  return Buffer.concat([h, v, Buffer.alloc((4 - (v.length % 4)) % 4)]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

/** XOR-*-ADDRESS: famiglia, porta e indirizzo mascherati col magic cookie (e,
    per IPv6, anche con l'id di transazione). */
function xorAddr(tid, ip, port) {
  const v6 = ip.includes(':');
  const raw = v6 ? ip6Bytes(ip) : ip4Bytes(ip);
  const key = Buffer.concat([u32(STUN_MAGIC), tid]);
  const b = Buffer.alloc(4 + raw.length);
  b[0] = 0; b[1] = v6 ? 0x02 : 0x01;
  b.writeUInt16BE(port ^ 0x2112, 2);
  for (let i = 0; i < raw.length; i++) b[4 + i] = raw[i] ^ key[i];
  return b;
}
function unxorAddr(tid, v) {
  const key = Buffer.concat([u32(STUN_MAGIC), tid]);
  const port = v.readUInt16BE(2) ^ 0x2112;
  const n = v[1] === 0x02 ? 16 : 4;
  const raw = Buffer.alloc(n);
  for (let i = 0; i < n; i++) raw[i] = v[4 + i] ^ key[i];
  const ip = n === 4 ? [...raw].join('.') : raw.toString('hex').match(/..../g).join(':');
  return { ip, port };
}

/** Un messaggio STUN completo: attributi, poi MESSAGE-INTEGRITY (se c'è una
    chiave) calcolata con la lunghezza che la comprende, poi FINGERPRINT. */
function build(type, tid, attrs, key) {
  let body = Buffer.concat(attrs.map(([t, v]) => tlv(t, v)));
  const head = (len) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(type, 0); h.writeUInt16BE(len, 2); h.writeUInt32BE(STUN_MAGIC, 4); tid.copy(h, 8);
    return h;
  };
  if (key) {
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head(body.length + 24), body])).digest();
    body = Buffer.concat([body, tlv(ATTR.MI, mac)]);
  }
  const msg = Buffer.concat([head(body.length + 8), body]);
  return Buffer.concat([msg, tlv(ATTR.FP, u32(crc32(msg) ^ 0x5354554e))]);
}

function parse(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== STUN_MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const tid = buf.subarray(8, 20);
  const attrs = [];
  let i = 20;
  while (i + 4 <= 20 + len && i + 4 <= buf.length) {
    const t = buf.readUInt16BE(i), l = buf.readUInt16BE(i + 2);
    attrs.push({ t, v: buf.subarray(i + 4, i + 4 + l) });
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  const get = (t) => (attrs.find((a) => a.t === t) || {}).v;
  const cls = ((type >> 4) & 0x1) | ((type >> 7) & 0x2);   // 0 richiesta · 2 successo · 3 errore
  let error = null;
  const e = get(ATTR.ERROR);
  if (cls === 3 && e) error = { code: (e[2] & 0x07) * 100 + e[3], reason: e.subarray(4).toString('utf8') };
  return { type, tid, success: cls === 2, error, get, str: (t) => (get(t) ? get(t).toString('utf8') : '') };
}

/* ---------- trasporto: UDP o TCP, stessa faccia ---------- */

function apriUdp(host, port) {
  const sock = dgram.createSocket('udp4');
  const cbs = [];
  sock.on('message', (m) => cbs.forEach((f) => f(m)));
  sock.on('error', () => {});
  return {
    nome: 'UDP',
    send: (b) => sock.send(b, port, host),
    on: (f) => cbs.push(f),
    off: (f) => { const i = cbs.indexOf(f); if (i >= 0) cbs.splice(i, 1); },
    close: () => { try { sock.close(); } catch (e) {} },
    ritrasmette: true,
  };
}
function apriTcp(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const cbs = [];
    let acc = Buffer.alloc(0);
    sock.on('connect', () => resolve({
      nome: 'TCP',
      send: (b) => sock.write(b),
      on: (f) => cbs.push(f),
      off: (f) => { const i = cbs.indexOf(f); if (i >= 0) cbs.splice(i, 1); },
      close: () => { try { sock.destroy(); } catch (e) {} },
      ritrasmette: false,
    }));
    sock.on('error', (e) => reject(e));
    sock.on('data', (d) => {
      // sul TCP i messaggi arrivano in fila: si tagliano con la lunghezza dell'intestazione
      acc = Buffer.concat([acc, d]);
      while (acc.length >= 20) {
        const n = 20 + acc.readUInt16BE(2);
        if (acc.length < n) break;
        const one = acc.subarray(0, n); acc = acc.subarray(n);
        cbs.forEach((f) => f(one));
      }
    });
  });
}

/** Una transazione: manda, aspetta la risposta con lo stesso id. In UDP si
    ritrasmette (è il suo mestiere perdere pacchetti); tre secondi in tutto. */
function transazione(tr, msg) {
  const tid = msg.subarray(8, 20);
  return new Promise((resolve) => {
    let tries = 0;
    const onMsg = (b) => {
      const p = parse(b);
      if (p && p.tid.equals(tid)) { clearTimeout(timer); tr.off(onMsg); resolve(p); }
    };
    tr.on(onMsg);
    let timer;
    const go = () => {
      tries++;
      tr.send(msg);
      timer = setTimeout(() => {
        if (tries < 3 && tr.ritrasmette) return go();
        tr.off(onMsg); resolve(null);
      }, 1000);
    };
    go();
  });
}

/* ---------- la credenziale del ponte, rifatta qui ---------- */

function credenziale(secret, ttlS) {
  const tag = b64url(crypto.randomBytes(6));   // 8 caratteri, senza «:»
  const username = `${Math.floor(Date.now() / 1000) + ttlS}:${tag}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/* ---------- il cliente TURN, il minimo indispensabile ---------- */

class ClienteTurn {
  constructor(tr) { this.tr = tr; this.auth = null; }

  /** I due giri. Torna { ok, code, reason, relayed, lifetime, primo }.
      `family` 6 chiede un rimbalzo IPv6 (REQUESTED-ADDRESS-FAMILY). */
  async alloca(cred, family) {
    const base = [[ATTR.RTRANS, Buffer.from([17, 0, 0, 0])]];
    if (family === 6) base.push([ATTR.RAF, Buffer.from([0x02, 0, 0, 0])]);
    const tid1 = crypto.randomBytes(12);
    const r1 = await transazione(this.tr, build(MSG.ALLOCATE, tid1, base));
    if (!r1) return { ok: false, code: 0, reason: 'nessuna risposta al primo giro' };
    const primo = r1.error ? r1.error.code : (r1.success ? 200 : -1);
    if (primo !== 401) return { ok: false, code: primo, reason: 'il primo giro doveva dare 401', primo };
    const realm = r1.str(ATTR.REALM), nonce = r1.str(ATTR.NONCE);
    const key = crypto.createHash('md5').update(`${cred.username}:${realm}:${cred.credential}`).digest();
    this.auth = { username: cred.username, realm, nonce, key };
    const tid2 = crypto.randomBytes(12);
    const r2 = await transazione(this.tr, build(MSG.ALLOCATE, tid2, [
      ...base, [ATTR.USERNAME, Buffer.from(cred.username)], [ATTR.REALM, Buffer.from(realm)], [ATTR.NONCE, Buffer.from(nonce)],
    ], key));
    if (!r2) return { ok: false, code: 0, reason: 'nessuna risposta al secondo giro', primo };
    if (!r2.success) return { ok: false, code: r2.error ? r2.error.code : -1, reason: r2.error ? r2.error.reason : '?', primo };
    const rel = r2.get(ATTR.XRELAY);
    const lt = r2.get(ATTR.LIFETIME);
    return { ok: true, code: 200, primo, relayed: rel ? unxorAddr(tid2, rel) : null, lifetime: lt ? lt.readUInt32BE(0) : 0 };
  }

  async #autenticata(type, attrsDi) {
    const a = this.auth;
    const tid = crypto.randomBytes(12);
    const msg = build(type, tid, [
      ...attrsDi(tid), [ATTR.USERNAME, Buffer.from(a.username)], [ATTR.REALM, Buffer.from(a.realm)], [ATTR.NONCE, Buffer.from(a.nonce)],
    ], a.key);
    const r = await transazione(this.tr, msg);
    if (!r) return { ok: false, code: 0, reason: 'nessuna risposta' };
    if (r.error && r.error.code === 438 && r.str(ATTR.NONCE)) {   // nonce scaduto: si riprova col nuovo
      this.auth.nonce = r.str(ATTR.NONCE);
      return this.#autenticata(type, attrsDi);
    }
    return r.success ? { ok: true, code: 200 } : { ok: false, code: r.error ? r.error.code : -1, reason: r.error ? r.error.reason : '?' };
  }

  /** CreatePermission verso un indirizzo: 200 se il recinto lo lascia passare,
      403 se è negato, 443 se la famiglia non è quella del rimbalzo. */
  permesso(ip) { return this.#autenticata(MSG.CREATEPERM, (tid) => [[ATTR.XPEER, xorAddr(tid, ip, 3478)]]); }

  /** Refresh con vita zero: l'allocazione si chiude subito e non resta a
      occupare la quota fino alla scadenza. */
  rilascia() { return this.auth ? this.#autenticata(MSG.REFRESH, () => [[ATTR.LIFETIME, u32(0)]]) : Promise.resolve(); }
}

/* ---------- STUN Binding: per sapere quando coturn è sveglio ---------- */

async function aspettaCoturn(host, port, maxMs) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const tr = apriUdp(host, port);
    const r = await transazione(tr, build(MSG.BINDING, crypto.randomBytes(12), []));
    tr.close();
    if (r && r.success) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/* ---------- il ponte: /ice ---------- */

async function chiediIce(bridge, room) {
  const res = await fetch(`${bridge}/ice?room=${encodeURIComponent(room)}`, { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
const urlsDi = (body) => (body && Array.isArray(body.iceServers) ? body.iceServers : [])
  .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter(Boolean);
const relayDi = (body) => (body && Array.isArray(body.iceServers) ? body.iceServers : [])
  .find((s) => urlsDi({ iceServers: [s] }).some((u) => /^turns?:/.test(u)));

/* ---------- --local: coturn (brew) e due ponti Deno accesi qui ---------- */

async function accendiLocale(turnPort, bridgePort) {
  const dir = path.join(ROOT, 'test-output', 'rimbalzo');
  fs.mkdirSync(dir, { recursive: true });
  const installa = path.join(ROOT, 'bridge', 'coturn', 'installa.sh');
  const inst = spawnSync('bash', [installa, '--dest', dir, '--rigenera', '--zitto'], { encoding: 'utf8' });
  if (inst.status !== 0) throw new Error('installa.sh: ' + (inst.stderr || inst.stdout));
  const env = leggiEnv(path.join(dir, '.env'));
  const conf = path.join(dir, 'turnserver.local.conf');
  const log = fs.createWriteStream(path.join(dir, 'turnserver.log'));
  // Lo stesso file che andrebbe nel container, più le tre cose che nel
  // container sono tmpfs o `docker logs`. La porta si può spostare se la 3478
  // è occupata (RIFLESSO_TURN_PORT).
  const turn = spawn('turnserver', ['-c', conf, '--static-auth-secret=' + env.TURN_SECRET,
    '--listening-port=' + turnPort, '--pidfile=' + path.join(dir, 'turnserver.pid'),
    '--userdb=' + path.join(dir, 'turndb'), '-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
  turn.stdout.pipe(log); turn.stderr.pipe(log);
  const procs = [turn];
  const deno = (port, extra) => {
    const p = spawn('deno', ['run', '--allow-net', '--allow-read', '--allow-env', '--unstable-kv', path.join(ROOT, 'bridge/main.ts')],
      { env: Object.assign({}, process.env, { PORT: String(port), BIND: '127.0.0.1' }, extra), stdio: 'ignore' });
    procs.push(p);
    return `http://127.0.0.1:${port}`;
  };
  // Le variabili TURN_* di chi lancia non devono contaminare il ponte «nudo».
  const nudo = { TURN_HOST: '', TURN_SECRET: '' };
  const conVar = deno(bridgePort, { TURN_HOST: `${env.TURN_HOST}:${turnPort}`, TURN_SECRET: env.TURN_SECRET });
  const senzaVar = deno(bridgePort + 1, nudo);
  const sveglio = await aspettaCoturn(env.TURN_HOST, turnPort, 6000);
  const salute = async (b) => { for (let i = 0; i < 30; i++) { try { if ((await fetch(b + '/health')).ok) return true; } catch (e) {} await new Promise((r) => setTimeout(r, 200)); } return false; };
  const okA = await salute(conVar), okB = await salute(senzaVar);
  return {
    cfg: { host: env.TURN_HOST, port: turnPort, secret: env.TURN_SECRET, ipv4: env.TURN_IPV4, ipv6: env.TURN_IPV6, conVar, senzaVar },
    sveglio, okA, okB, dir,
    spegni: () => procs.forEach((p) => { try { p.kill(); } catch (e) {} }),
  };
}

/* ---------- il collaudo ---------- */

async function collaudoTurn() {
  const locale = process.argv.includes('--local');
  const results = [];
  const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
  const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
  const info = (m) => console.log('     ' + m);

  console.log('== il collaudo del rimbalzo (coturn) ==');
  console.log('   due trappole, prima di leggere un [NO]:');
  console.log('   1. coturn su 127.0.0.1 → il browser butta via il candidato di rimbalzo in silenzio;');
  console.log('   2. una macchina sola coi nomi .local accesi → la coppia fallisce per l\'mDNS, non per il rimbalzo.');

  let cfg, spegni = () => {}, dir = '';
  if (locale) {
    const turnPort = Number(process.env.RIFLESSO_TURN_PORT) || 3478;
    const bridgePort = Number(process.env.RIFLESSO_BRIDGE_PORT) || 8797;
    const acceso = await accendiLocale(turnPort, bridgePort);
    cfg = acceso.cfg; spegni = acceso.spegni; dir = acceso.dir;
    acceso.sveglio ? ok(`coturn locale sveglio su ${cfg.host}:${cfg.port} (installa.sh → ${path.relative(ROOT, dir)}/)`)
                   : bad(`coturn locale non risponde su ${cfg.host}:${cfg.port} (registro: ${path.relative(ROOT, dir)}/turnserver.log)`);
    acceso.okA && acceso.okB ? ok(`due ponti Deno: con variabili ${cfg.conVar} · senza ${cfg.senzaVar}`)
                             : bad(`ponti Deno: con variabili ${acceso.okA} · senza ${acceso.okB}`);
    if (!acceso.sveglio) { spegni(); return results; }
  } else {
    const envFile = process.env.RIFLESSO_TURN_ENV || path.join(ROOT, 'bridge', 'coturn', '.env');
    const env = fs.existsSync(envFile) ? leggiEnv(envFile) : {};
    const host = process.env.TURN_HOST || env.TURN_HOST || '';
    const m = host.match(/^([A-Za-z0-9.-]+?)(?::(\d{1,5}))?$/);
    if (!m || !(process.env.TURN_SECRET || env.TURN_SECRET)) {
      console.error(`manca TURN_HOST/TURN_SECRET: lancia bridge/coturn/installa.sh, o passa RIFLESSO_TURN_ENV, o usa --local`);
      process.exit(2);
    }
    cfg = { host: m[1], port: Number(m[2] || 3478), secret: process.env.TURN_SECRET || env.TURN_SECRET,
            ipv4: process.env.TURN_IPV4 || env.TURN_IPV4 || m[1], ipv6: process.env.TURN_IPV6 || env.TURN_IPV6 || '',
            conVar: BRIDGE, senzaVar: '' };
    info(`coturn ${cfg.host}:${cfg.port} · ponte ${cfg.conVar} · indirizzi della macchina ${cfg.ipv4} / ${cfg.ipv6 || '(nessun IPv6)'}`);
    // Un ponte nudo locale per la prova «senza variabili», se Deno c'è.
    try {
      const port = (Number(process.env.RIFLESSO_BRIDGE_PORT) || 8797) + 1;
      const p = spawn('deno', ['run', '--allow-net', '--allow-read', '--allow-env', '--unstable-kv', path.join(ROOT, 'bridge/main.ts')],
        { env: Object.assign({}, process.env, { PORT: String(port), BIND: '127.0.0.1', TURN_HOST: '', TURN_SECRET: '' }), stdio: 'ignore' });
      p.on('error', () => {});
      spegni = () => { try { p.kill(); } catch (e) {} };
      for (let i = 0; i < 25; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { cfg.senzaVar = `http://127.0.0.1:${port}`; break; } } catch (e) {} await new Promise((r) => setTimeout(r, 200)); }
    } catch (e) { /* niente Deno: la prova si salta e lo si dice */ }
  }

  const aperte = [];   // allocazioni da rilasciare alla fine

  // 1. allocazione vera, UDP e TCP
  for (const via of ['UDP', 'TCP']) {
    let tr;
    try { tr = via === 'UDP' ? apriUdp(cfg.host, cfg.port) : await apriTcp(cfg.host, cfg.port); }
    catch (e) { bad(`${via} ${cfg.host}:${cfg.port} non raggiungibile: ${e.code || e.message}`); continue; }
    const c = new ClienteTurn(tr);
    const r = await c.alloca(credenziale(cfg.secret, 600));
    if (r.ok) {
      aperte.push(c);
      const dentro = r.relayed && r.relayed.ip === cfg.host && r.relayed.port >= TURN_PORTS.min && r.relayed.port <= TURN_PORTS.max;
      dentro ? ok(`${via}: allocazione in due giri (401 → 200) · rimbalzo ${r.relayed.ip}:${r.relayed.port} · vita ${r.lifetime} s`)
             : bad(`${via}: allocata ma il rimbalzo è ${r.relayed ? r.relayed.ip + ':' + r.relayed.port : '?'} (atteso ${cfg.host}:${TURN_PORTS.min}-${TURN_PORTS.max})`);
    } else {
      bad(`${via}: allocazione fallita · ${r.code} ${r.reason}`);
      tr.close();
    }
  }
  const udp = aperte.find((c) => c.tr.nome === 'UDP');

  // 2. credenziali sbagliate e scadute
  {
    const tr = apriUdp(cfg.host, cfg.port);
    const r = await new ClienteTurn(tr).alloca(credenziale(cfg.secret + 'x', 600));
    tr.close();
    !r.ok && r.code === 401 ? ok(`credenziale con segreto sbagliato → ${r.code} rifiutata`) : bad(`credenziale sbagliata: ${JSON.stringify(r)}`);
  }
  {
    const tr = apriUdp(cfg.host, cfg.port);
    const r = await new ClienteTurn(tr).alloca(credenziale(cfg.secret, -120));
    tr.close();
    !r.ok && r.code === 401 ? ok(`credenziale scaduta (due minuti fa) → ${r.code} rifiutata`) : bad(`credenziale scaduta: ${JSON.stringify(r)}`);
  }

  // 3. allocazione IPv6: il rimbalzo parla solo IPv4
  {
    const tr = apriUdp(cfg.host, cfg.port);
    const r = await new ClienteTurn(tr).alloca(credenziale(cfg.secret, 600), 6);
    tr.close();
    !r.ok && r.code >= 400 ? ok(`allocazione IPv6 → ${r.code} ${r.reason} (il rimbalzo esce solo dall'IPv4)`)
                           : bad(`allocazione IPv6 ${r.ok ? 'CONCESSA: coturn si prende un IPv6, e può essere puntato contro la macchina' : JSON.stringify(r)}`);
  }

  // 4. il recinto: i permessi negati, e l'unico concesso
  if (udp) {
    const negati = ['192.168.1.1', '172.17.0.1', '10.0.0.5', '127.0.0.1', cfg.ipv4, cfg.ipv6].filter(Boolean);
    for (const ip of negati) {
      const r = await udp.permesso(ip);
      const chi = ip === cfg.ipv4 ? ' (l\'IPv4 della macchina)' : ip === cfg.ipv6 ? ' (l\'IPv6 della macchina)' : '';
      !r.ok && r.code >= 400 ? ok(`permesso verso ${ip}${chi} → ${r.code} ${r.reason}`)
                             : bad(`permesso verso ${ip}${chi} ${r.ok ? 'CONCESSO' : JSON.stringify(r)}`);
    }
    if (!cfg.ipv6) info('nessun IPv6 della macchina in .env: quella prova non si fa (TURN_IPV6)');
    const r = await udp.permesso('8.8.8.8');
    r.ok ? ok('permesso verso 8.8.8.8 → concesso: la sponda verso Internet resta, frenata a 250 kB/s')
         : bad(`permesso verso 8.8.8.8 rifiutato (${r.code} ${r.reason}): il recinto chiude anche la strada buona`);
  } else {
    bad('senza allocazione UDP non si provano i permessi');
  }

  // 5. il ponte: /ice
  const stanzaMorta = b64url(crypto.randomBytes(16));
  try {
    const r = await chiediIce(cfg.conVar, stanzaMorta);
    if (r.status === 404) bad(`/ice non esiste sul ponte ${cfg.conVar} (404)`);
    else if (r.status !== 200) bad(`/ice stanza morta → ${r.status}`);
    else !relayDi(r.body) && r.body.relay !== true
      ? ok(`/ice per una stanza morta → nessun rimbalzo (relay:${r.body.relay}, ${urlsDi(r.body).length} STUN)`)
      : bad(`/ice per una stanza morta CONSEGNA un rimbalzo: ${JSON.stringify(r.body)}`);
  } catch (e) { bad(`/ice sul ponte ${cfg.conVar}: ${e.message}`); }

  if (cfg.senzaVar) {
    try {
      const r = await chiediIce(cfg.senzaVar, stanzaMorta);
      const urls = urlsDi(r.body);
      const uguale = r.status === 200 && urls.length === ICE_OGGI.length && ICE_OGGI.every((u) => urls.includes(u)) && r.body.relay === false;
      uguale ? ok('/ice senza le variabili → esattamente la lista di oggi (tre STUN, relay:false)')
             : bad(`/ice senza le variabili → ${r.status} ${JSON.stringify(r.body)}`);
    } catch (e) { bad(`/ice sul ponte nudo ${cfg.senzaVar}: ${e.message}`); }
  } else {
    info('nessun ponte «nudo» a portata (serve Deno): la prova «/ice senza variabili» si salta');
  }

  // 6. la catena intera: stanza VIVA → credenziale del ponte → coturn la accetta.
  // La stanza si tiene viva con un'attesa aperta alla cassetta, come fa il Mac.
  if (locale || process.env.RIFLESSO_TURN_VIVA) {
    const viva = b64url(crypto.randomBytes(16));
    const ac = new AbortController();
    const attesa = fetch(`${cfg.conVar}/m/${viva}/o?w=20`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await chiediIce(cfg.conVar, viva);
      const srv = relayDi(r.body);
      if (!srv) bad(`/ice per una stanza viva → nessun rimbalzo: ${JSON.stringify(r.body)}`);
      else {
        const forma = /^\d{10}:[A-Za-z0-9_-]{8}$/.test(srv.username || '');
        forma ? ok(`/ice per una stanza viva → rimbalzo ${urlsDi({ iceServers: [srv] }).join(' ')} · utente ${srv.username}`)
              : bad(`/ice: nome utente non nella forma <scadenza>:<8 caratteri>: ${srv.username}`);
        const tr = apriUdp(cfg.host, cfg.port);
        const c = new ClienteTurn(tr);
        const a = await c.alloca({ username: srv.username, credential: srv.credential });
        a.ok ? ok(`la credenziale coniata dal ponte apre un'allocazione vera su coturn (${a.relayed.ip}:${a.relayed.port})`)
             : bad(`coturn rifiuta la credenziale del ponte: ${a.code} ${a.reason} (segreti diversi fra ponte e coturn?)`);
        if (a.ok) aperte.push(c); else tr.close();
      }
    } catch (e) { bad(`stanza viva: ${e.message}`); }
    ac.abort(); await attesa;
  }

  // chiusura: si rilasciano le allocazioni, così la quota torna libera
  for (const c of aperte) { await c.rilascia(); c.tr.close(); }
  spegni();
  if (dir) info(`registro di coturn: ${path.relative(ROOT, dir)}/turnserver.log`);
  return results;
}

async function main() {
  const wantStun = process.argv.includes('--stun');

  if (process.argv.includes('--turn')) {
    const results = await collaudoTurn();
    const falliti = results.filter((r) => !r).length;
    console.log(`\n${results.length - falliti}/${results.length} prove superate`);
    process.exit(falliti ? 1 : 0);
  }

  let secret, kind;
  if (process.env.RIFLESSO_TOKEN) {
    secret = process.env.RIFLESSO_TOKEN; kind = 'device';
  } else {
    // Il codice lo dice `Riflesso --print-pin` (socket Unix): `/api/pin` non
    // esiste piu'.
    try { secret = pin(); } catch (e) {
      console.error('Riflesso non risponde: accendilo, o passa RIFLESSO_TOKEN. ' + e.message);
      process.exit(2);
    }
    kind = 'pair';
  }

  const keys = derive(secret, kind);
  console.log(`ponte   ${BRIDGE}`);
  console.log(`stanza  ${keys.room}  (${kind})`);

  const health = await (await fetch(`${BRIDGE}/health`)).json();
  console.log(`salute  kv=${health.kv}`);

  const nonce = b64url(crypto.randomBytes(8));
  const sdp = fakeOffer();
  const fp = (sdp.match(/a=fingerprint:(\S+ \S+)/) || [])[1];
  const body = seal(keys, 'o', { t: 'offer', sdp, fp, ts: Date.now(), n: nonce });

  const t0 = Date.now();
  const put = await fetch(`${BRIDGE}/m/${keys.room}/o`, { method: 'POST', body });
  if (!put.ok && put.status !== 204) {
    console.error('il ponte ha detto ' + put.status);
    process.exit(2);
  }
  console.log(`\nofferta posata: ${body.length} byte`);

  let answer = null;
  const until = Date.now() + 30000;
  while (!answer && Date.now() < until) {
    const res = await fetch(`${BRIDGE}/m/${keys.room}/a?w=10`, { cache: 'no-store' });
    if (res.status === 204) continue;
    if (!res.ok) { console.error('il ponte ha detto ' + res.status); process.exit(2); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) continue;
    const got = unseal(keys, 'a', buf);
    if (got.n !== nonce) { console.log('  (risposta di un altro giro, ignorata)'); continue; }
    answer = { obj: got, bytes: buf.length };
  }
  if (!answer) {
    console.error('\nnessuna risposta in 30 s: il Mac non sta ascoltando quella stanza.');
    process.exit(1);
  }

  console.log(`risposta ricevuta: ${answer.bytes} byte, ${Date.now() - t0} ms`);

  const cands = candidates(answer.obj.sdp);
  console.log(`\n== i candidati del Mac (${cands.length}) ==`);
  if (!cands.length) console.log('  nessuno: la risposta non porta indirizzi.');
  for (const c of cands) {
    console.log(`  ${c.type.padEnd(6)} ${c.family.padEnd(5)} ${c.address}:${c.port} ${c.proto}`);
  }

  const usable = cands.filter((c) => !c.mdns && c.family === 'IPv6');
  const srflx = cands.filter((c) => c.type === 'srflx');
  const mdns = cands.filter((c) => c.mdns);
  console.log('\n== il verdetto ==');
  console.log(`  offuscati mDNS (inutili da fuori):  ${mdns.length}`);
  console.log(`  IPv6 utilizzabili da fuori:         ${usable.length}`);
  console.log(`  srflx (IPv4 pubblico dal NAT):      ${srflx.length}`);
  if (!usable.length && srflx.length) {
    console.log('\n  Da fuori resta **solo** la strada IPv4 col rimbalzo del NAT.');
    console.log('  Se il NAT dell\'operatore è simmetrico, quella strada non esiste,');
    console.log('  e senza IPv6 utilizzabile non ne restano altre.');
  }

  if (wantStun) { await stunReport(); await natReport(); }
}

main().catch((e) => { console.error(e); process.exit(2); });
