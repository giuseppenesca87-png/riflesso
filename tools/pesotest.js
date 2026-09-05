#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   IL PESO — quanto viaggia davvero fra Mac e telefono, misurato sul filo.

   Il 04/09/2026 la pagina pesava 208.270 byte, in chiaro, e alla seconda
   apertura tornava tutta di nuovo: zero `Content-Encoding`, zero `ETag`, zero
   304. Qui si controlla che non torni cosi':

   · ogni file di testo della webapp parte in **gzip** quando lo si accetta;
   · ogni file ha un'**ETag**, e con `If-None-Match` risponde **304** vuoto;
   · le risposte JSON grandi (`/api/chats`, la conversazione) sono compresse;
   · le PNG e le risposte piccole restano com'erano (comprimerle costa).

   Stampa i numeri: apertura, riapertura, elenco chat, elenco routine. Sono le
   misure 2, 3 e 4 del resoconto, ripetibili.

   Usa `http.request` e non `fetch`: `fetch` di Node decomprime da solo e
   nasconde proprio i byte che si vogliono contare.

   Uso:  node tools/pesotest.js
------------------------------------------------------------------ */

const http = require('http');
const { pin } = require('./pin');

const BASE = new URL(process.env.RIFLESSO_URL || 'http://127.0.0.1:7654');

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

/** Una richiesta grezza: byte del corpo **come arrivano**, e le intestazioni. */
function raw(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: BASE.hostname, port: BASE.port, path: pathname, method: 'GET',
      headers: Object.assign({ Connection: 'close' }, headers || {}),
    }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({
        status: res.statusCode, bytes: n, headers: res.headers,
        headBytes: res.rawHeaders.join('\r\n').length + 20,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function token() {
  const r = await fetch(BASE.origin + '/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin(), label: 'prova-peso', id: 'ba1a0cebba1a0cebba1a0cebba1a0ceb' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('accoppiamento fallito: ' + JSON.stringify(j));
  return j.token;
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

async function main() {
  const tok = await token();
  const auth = { Authorization: 'Bearer ' + tok };
  const GZ = { 'Accept-Encoding': 'gzip, br' };

  // Quello che il telefono scarica aprendo la pagina: gli stessi undici
  // file della misura del 04/09.
  const files = ['/', '/style.css', '/app.js', '/net.js', '/i18n.js', '/tunnel.js',
                 '/manifest.webmanifest', '/icon-180.png', '/icon-512.png'];

  console.log('\n== apertura: ogni file, in chiaro e in gzip ==');
  let plainTotal = 0, gzTotal = 0, openTotal = 0;
  const etags = {};
  for (const f of files) {
    const plain = await raw(f);
    const gz = await raw(f, GZ);
    plainTotal += plain.bytes;
    gzTotal += gz.bytes;
    openTotal += gz.bytes + gz.headBytes;
    etags[f] = gz.headers.etag;
    const compressible = !/\.png$/.test(f);
    const enc = gz.headers['content-encoding'] || '';
    info(`${f.padEnd(24)} ${String(plain.bytes).padStart(7)} → ${String(gz.bytes).padStart(7)} byte  ${enc || 'in chiaro'}  etag=${gz.headers.etag || 'NESSUNA'}`);
    if (compressible && plain.bytes >= 1024) {
      enc === 'gzip' && gz.bytes < plain.bytes * 0.6
        ? ok(`${f} parte in gzip: ${plain.bytes} → ${gz.bytes} byte (-${Math.round(100 - gz.bytes * 100 / plain.bytes)}%)`)
        : bad(`${f} non e' compresso come dovrebbe: ${enc || 'niente'} ${gz.bytes}/${plain.bytes}`);
    } else {
      enc === '' ? ok(`${f} resta com'e' (${plain.bytes} byte): comprimerlo non pagherebbe`)
                 : bad(`${f} e' stato compresso inutilmente`);
    }
    plain.headers.etag ? ok(`${f} ha un'impronta: ${plain.headers.etag}`) : bad(`${f} senza ETag`);
    plain.headers['cache-control'] === 'no-cache' || info(`${f}: Cache-Control ${plain.headers['cache-control']}`);
  }
  info(`pagina intera: ${plainTotal} byte in chiaro → ${gzTotal} byte in gzip (-${Math.round(100 - gzTotal * 100 / plainTotal)}%)`);
  gzTotal < plainTotal * 0.45 ? ok(`apertura completa: ${gzTotal} byte sul filo invece di ${plainTotal} (${kb(gzTotal)} contro ${kb(plainTotal)})`)
                              : bad(`apertura ancora pesante: ${gzTotal} byte`);

  console.log('\n== riapertura: If-None-Match su ogni file ==');
  let reopenBody = 0, reopenTotal = 0, n304 = 0;
  for (const f of files) {
    const r = await raw(f, Object.assign({ 'If-None-Match': etags[f] || '"x"' }, GZ));
    reopenBody += r.bytes;
    reopenTotal += r.bytes + r.headBytes;
    if (r.status === 304) n304++;
    else info(`${f} → ${r.status} con ${r.bytes} byte`);
  }
  n304 === files.length ? ok(`riapertura: ${n304} risposte 304 su ${files.length}, ${reopenBody} byte di corpo`)
                        : bad(`riapertura: solo ${n304} 304 su ${files.length}`);
  info(`riapertura intera, intestazioni comprese: ~${reopenTotal} byte (${kb(reopenTotal)})`);
  const wrong = await raw('/app.js', { 'If-None-Match': '"non-e-questa"' });
  wrong.status === 200 && wrong.bytes > 1000 ? ok('un\'impronta diversa riscarica il file (200)') : bad('impronta diversa → ' + wrong.status);

  console.log('\n== le risposte JSON ==');
  const chats = await raw('/api/chats?q=', auth);
  const chatsGz = await raw('/api/chats?q=', Object.assign({}, auth, GZ));
  info(`/api/chats: ${chats.bytes} → ${chatsGz.bytes} byte (${chatsGz.headers['content-encoding'] || 'in chiaro'})`);
  chatsGz.headers['content-encoding'] === 'gzip' && chatsGz.bytes < chats.bytes * 0.5
    ? ok(`l'elenco chat viaggia in gzip: ${chats.bytes} → ${chatsGz.bytes} byte`)
    : bad('l\'elenco chat non e\' compresso');
  const rout = await raw('/api/chats?q=&kind=routine', auth);
  const routGz = await raw('/api/chats?q=&kind=routine', Object.assign({}, auth, GZ));
  info(`/api/chats?kind=routine: ${rout.bytes} → ${routGz.bytes} byte`);
  routGz.headers['content-encoding'] === 'gzip' && routGz.bytes < rout.bytes * 0.4
    ? ok(`l'elenco routine viaggia in gzip: ${rout.bytes} → ${routGz.bytes} byte (-${Math.round(100 - routGz.bytes * 100 / rout.bytes)}%)`)
    : bad('l\'elenco routine non e\' compresso: ' + JSON.stringify(routGz.headers));
  const status = await raw('/api/status', Object.assign({}, auth, GZ));
  !status.headers['content-encoding'] ? ok(`una risposta piccola (${status.bytes} byte) resta in chiaro`) : bad('risposta piccola compressa inutilmente');

  // Una conversazione vera, la piu' grossa fra le prime.
  const list = JSON.parse(await (await fetch(BASE.origin + '/api/chats?q=', { headers: auth })).text());
  const openable = (list.items || []).filter(c => c.open).slice(0, 5);
  let best = null;
  for (const c of openable) {
    const p = await raw('/api/chat/' + encodeURIComponent(c.id), auth);
    if (!best || p.bytes > best.plain) best = { id: c.id, title: c.title, plain: p.bytes };
  }
  if (best) {
    const g = await raw('/api/chat/' + encodeURIComponent(best.id), Object.assign({}, auth, GZ));
    info(`conversazione «${best.title}»: ${best.plain} → ${g.bytes} byte`);
    g.headers['content-encoding'] === 'gzip' && g.bytes < best.plain * 0.5
      ? ok(`una conversazione viaggia in gzip: ${best.plain} → ${g.bytes} byte (-${Math.round(100 - g.bytes * 100 / best.plain)}%)`)
      : bad('la conversazione non e\' compressa');
  }

  await fetch(BASE.origin + '/api/forget', { method: 'POST', headers: auth });

  console.log('\n== le misure ==');
  console.log(`  apertura completa      ${String(gzTotal).padStart(8)} byte  (in chiaro sarebbero ${plainTotal})`);
  console.log(`  riapertura             ${String(reopenTotal).padStart(8)} byte  (${n304} × 304, intestazioni comprese)`);
  console.log(`  elenco chat            ${String(chatsGz.bytes).padStart(8)} byte  (in chiaro ${chats.bytes})`);
  console.log(`  elenco routine         ${String(routGz.bytes).padStart(8)} byte  (in chiaro ${rout.bytes})`);

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nella prova:', e); process.exit(2); });
