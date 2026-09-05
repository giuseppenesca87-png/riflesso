#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   ALLEGATI — la parte che si puo' provare senza toccare Claude.

   Il percorso di un allegato ha tre pezzi (VESTE §3): il telefono che lo
   sceglie, il trasporto che lo porta sul Mac, e il Mac che lo appende dentro
   Claude Desktop. Qui si prova il **secondo**, per intero e sul serio:

   · un file va su a pezzi e arriva **identico al byte** (impronta SHA-256);
   · un file oltre il tetto viene **rifiutato con un codice**, non in silenzio;
   · un nome ostile (`../../etc/passwd`) non diventa un percorso;
   · un pezzo fuori ordine viene rifiutato;
   · mandare un messaggio con un allegato che non esiste non manda niente.

   Il terzo pezzo — l'incolla dentro il compositore — si prova con
   `Riflesso --attachprobe <file>`, che e' l'unico modo di provarlo davvero:
   ci vuole Claude Desktop aperto.

   Uso:  node tools/allegatest.js
         (il codice lo chiede a «Riflesso --print-pin»; RIFLESSO_PIN=… lo forza)
------------------------------------------------------------------ */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pin } = require('./pin');

const BASE = process.env.RIFLESSO_URL || 'http://127.0.0.1:7654';
const PEZZO = 384 * 1024;

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function token() {
  const r = await fetch(BASE + '/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin(), label: 'prova-allegati' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('accoppiamento fallito: ' + JSON.stringify(j));
  return j.token;
}

/** Manda un file a pezzi, come fa `uploadPending` nella webapp. */
async function upload(tok, name, mime, buf, { chunk = PEZZO, sabota = null } = {}) {
  const total = Math.max(1, Math.ceil(buf.length / chunk));
  let id = '';
  let last = null;
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * chunk, Math.min((i + 1) * chunk, buf.length));
    const body = { id, i: sabota === i ? i + 5 : i, n: total, name, mime,
                   size: buf.length, b: slice.toString('base64') };
    const r = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify(body),
    });
    last = await r.json();
    if (!last.ok) return last;
    id = last.id;
  }
  return last;
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function main() {
  const tok = await token();
  ok('accoppiato per la prova');

  // ---- 1. un file di media misura, a piu' pezzi, arriva identico
  const grande = crypto.randomBytes(1_100_000);   // 3 pezzi
  const r1 = await upload(tok, 'foto della prova.jpg', 'image/jpeg', grande);
  if (!r1.ok || !r1.done) {
    bad('caricamento a pezzi fallito: ' + JSON.stringify(r1));
  } else {
    ok(`caricato in ${Math.ceil(grande.length / PEZZO)} pezzi: ${r1.got} byte, id ${r1.id.slice(0, 8)}…`);
    const dir = path.join(os.tmpdir(), 'riflesso-allegati', r1.id);
    const file = path.join(dir, r1.name);
    if (!fs.existsSync(file)) {
      bad('il file non e\' sul disco del Mac: ' + file);
    } else {
      const got = fs.readFileSync(file);
      sha(got) === sha(grande)
        ? ok(`arrivato identico al byte (sha256 ${sha(got).slice(0, 16)}…)`)
        : bad(`il file e' arrivato diverso: ${got.length} byte contro ${grande.length}`);
      const mode = (fs.statSync(file).mode & 0o777).toString(8);
      mode === '600' ? ok('e sta in una cartella solo sua, leggibile solo dall\'utente')
                     : info('permessi del file: ' + mode);
    }
  }

  // ---- 2. il nome non diventa un percorso
  const r2 = await upload(tok, '../../../../etc/passwd', 'text/plain', Buffer.from('niente'));
  r2.ok && !r2.name.includes('/') && !r2.name.includes('..')
    ? ok(`un nome ostile diventa innocuo: «../../../../etc/passwd» → «${r2.name}»`)
    : bad('il nome non e\' stato ripulito: ' + JSON.stringify(r2));

  // ---- 3. troppo grande: si dice, non si fallisce in silenzio
  const enorme = Buffer.alloc(600 * 1024);
  const r3 = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ i: 0, n: 1, name: 'enorme.bin', mime: 'application/octet-stream',
                           size: 50 * 1024 * 1024, b: enorme.toString('base64') }),
  });
  const j3 = await r3.json();
  j3.code === 'upload_too_big' && j3.max
    ? ok(`oltre il tetto si sente dire «${j3.code}» (massimo ${Math.round(j3.max / 1048576)} MB), non un silenzio`)
    : bad('nessun rifiuto chiaro per un file enorme: ' + JSON.stringify(j3));

  // ---- 4. un pezzo fuori ordine non passa
  const r4 = await upload(tok, 'sballato.bin', 'application/octet-stream',
                          crypto.randomBytes(500_000), { chunk: 200_000, sabota: 1 });
  r4.code === 'upload_out_of_order'
    ? ok('un pezzo fuori ordine viene rifiutato invece di scrivere spazzatura')
    : bad('un pezzo fuori ordine e\' passato: ' + JSON.stringify(r4));

  // ---- 5. mandare con un allegato che non esiste non manda niente
  const risposta = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:7654/ws?token=${encodeURIComponent(tok)}`);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('nessuna risposta')); }, 8000);
    ws.onopen = async () => {
      // Serve una chat che esista davvero, altrimenti il rifiuto sarebbe
      // «transcript_missing» e non proverebbe niente.
      const chats = await (await fetch(BASE + '/api/chats', {
        headers: { Authorization: 'Bearer ' + tok } })).json();
      const c = (chats.items || []).find(x => x.open);
      if (!c) { clearTimeout(t); ws.close(); resolve({ skip: true }); return; }
      ws.send(JSON.stringify({ t: 'sendChat', id: c.id, text: 'questa non deve partire',
                               file: 'non-esiste-proprio' }));
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'chatDone' || (m.t === 'chatNote' && m.code)) {
        clearTimeout(t); ws.close(); resolve(m);
      }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('websocket')); };
  }).catch(e => ({ errore: e.message }));

  if (risposta.skip) {
    info('nessuna chat apribile: salto la prova del rifiuto');
  } else if (risposta.code === 'upload_missing' && risposta.ok === false) {
    ok('un messaggio con un allegato inesistente viene rifiutato: «upload_missing», e non parte niente');
  } else {
    bad('rifiuto mancato o diverso: ' + JSON.stringify(risposta));
  }

  // Il finto dispositivo lascia il posto.
  await fetch(BASE + '/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nella prova:', e); process.exit(2); });
