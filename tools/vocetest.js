#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   LA VOCE — la parte che si prova senza un microfono in mano.

   Il tasto della voce ha tre pezzi: il telefono che registra, il tubo a
   pezzi che porta l'audio sul Mac (lo stesso degli allegati), e il Mac che
   trascrive (`Trascrizione.swift`, `POST /api/transcribe`). Qui si provano il
   secondo e il terzo **per intero e sul serio**, con una voce vera: quella
   di macOS (`say`), registrata in `audio/mp4` come farebbe il telefono.

   · un file m4a italiano va su a pezzi e torna come **testo giusto**;
   · l'inglese, se il modello c'e'; se non c'e', il Mac lo dice e lo scarica
     invece di restare appeso;
   · un identificativo inesistente, un file che non e' audio e una lingua
     che non esiste vengono **rifiutati con un codice**, non in silenzio.

   Il primo pezzo — il tasto in pagina — lo controlla `uitest.js`; il
   microfono vero si prova con l'iPhone in mano, dal ponte.

   Uso:  node tools/vocetest.js
         (il codice lo chiede a «Riflesso --print-pin»; RIFLESSO_PIN=… lo forza)
------------------------------------------------------------------ */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pin } = require('./pin');

const BASE = process.env.RIFLESSO_URL || 'http://127.0.0.1:7654';
const OUT = path.resolve(__dirname, '..', 'test-output', 'voce');
const PEZZO = 384 * 1024;

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function token() {
  const r = await fetch(BASE + '/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin(), label: 'prova-voce', id: 'b0cab0cab0cab0cab0cab0cab0cab0ca' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('accoppiamento fallito: ' + JSON.stringify(j));
  return j.token;
}

/** A pezzi, come `uploadBlob` nella webapp. */
async function upload(tok, name, mime, buf) {
  const total = Math.max(1, Math.ceil(buf.length / PEZZO));
  let id = '';
  let last = null;
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * PEZZO, Math.min((i + 1) * PEZZO, buf.length));
    const r = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ id, i, n: total, name, mime, size: buf.length, b: slice.toString('base64') }),
    });
    last = await r.json();
    if (!last.ok) return last;
    id = last.id;
  }
  return last;
}

async function transcribe(tok, id, lang) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ id, lang }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j, ms: Date.now() - t0 };
}

/** Una voce vera di macOS, in `audio/mp4` (AAC), come registra il telefono. */
function speak(voice, text, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const aiff = path.join(OUT, name + '.aiff');
  const m4a = path.join(OUT, name + '.m4a');
  execFileSync('say', ['-v', voice, '-o', aiff, text], { stdio: 'ignore' });
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', aiff, m4a], { stdio: 'ignore' });
  fs.unlinkSync(aiff);
  return fs.readFileSync(m4a);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

async function main() {
  const tok = await token();
  ok('accoppiato per la prova');

  // ---- 1. italiano: parlato vero → testo giusto
  const fraseIT = 'Ciao, questa è una prova di dettatura per Riflesso. Apri le impostazioni e controlla le api.';
  let it = null;
  try { it = speak('Alice', fraseIT, 'prova-it'); } catch (e) { info('say/afconvert non disponibili: ' + e.message); }
  if (it) {
    const up = await upload(tok, 'voce.m4a', 'audio/mp4', it);
    up.ok && up.done ? ok(`audio italiano caricato a pezzi: ${up.got} byte`) : bad('caricamento fallito: ' + JSON.stringify(up));
    const r = await transcribe(tok, up.id, 'it-IT');
    if (r.status === 200 && r.body && r.body.ok) {
      const testo = norm(r.body.text);
      info(`testo: «${r.body.text}» in ${r.ms} ms`);
      testo.includes('prova') && testo.includes('riflesso') && testo.includes('impostazioni')
        ? ok(`trascritto giusto in ${r.ms} ms (${it.length} byte di audio)`)
        : bad('trascrizione diversa dal parlato: «' + r.body.text + '»');
      r.ms < 5000 ? ok('in meno di cinque secondi') : bad(`troppo lento: ${r.ms} ms`);
    } else if (r.body && r.body.code === 'transcribe_unsupported_os') {
      bad('questo Mac non ha il motore (serve macOS 26): ' + JSON.stringify(r.body));
    } else {
      bad('trascrizione fallita: ' + r.status + ' ' + JSON.stringify(r.body));
    }
    // L'audio e' stato consumato: ritrascrivere lo stesso id deve dire che non c'e' piu'.
    const again = await transcribe(tok, up.id, 'it-IT');
    again.status === 400 && again.body && again.body.code === 'upload_missing'
      ? ok('l\'audio si butta dopo la trascrizione: lo stesso id non vale due volte')
      : bad('l\'audio resta sul Mac dopo la trascrizione: ' + JSON.stringify(again.body));
  }

  // ---- 2. inglese: se il modello c'e' trascrive, se no lo dice e lo scarica
  let en = null;
  try { en = speak('Samantha', 'This is a dictation test for Riflesso. Open the settings and check the API.', 'prova-en'); }
  catch (e) { info('voce inglese non disponibile: ' + e.message); }
  if (en) {
    const up = await upload(tok, 'voce.m4a', 'audio/mp4', en);
    const r = await transcribe(tok, up.id, 'en-US');
    if (r.status === 200 && r.body && r.body.ok) {
      const testo = norm(r.body.text);
      info(`inglese: «${r.body.text}» in ${r.ms} ms`);
      testo.includes('riflesso') || testo.includes('settings')
        ? ok('anche l\'inglese si trascrive sul Mac') : bad('inglese diverso dal parlato: «' + r.body.text + '»');
    } else if (r.body && r.body.code === 'transcribe_installing') {
      ok('il modello inglese manca: il Mac lo dice («transcribe_installing») e lo scarica, invece di restare appeso');
    } else {
      bad('inglese: ' + r.status + ' ' + JSON.stringify(r.body));
    }
  }

  // ---- 3. i rifiuti hanno un codice
  const missing = await transcribe(tok, 'non-esiste-proprio', 'it-IT');
  missing.status === 400 && missing.body && missing.body.code === 'upload_missing'
    ? ok('un audio mai caricato viene rifiutato: «upload_missing»')
    : bad('rifiuto mancato per un audio inesistente: ' + JSON.stringify(missing.body));

  const nonAudio = await upload(tok, 'voce.m4a', 'audio/mp4', Buffer.from('questo non e\' un file audio, e\' testo'.repeat(40)));
  const ba = await transcribe(tok, nonAudio.id, 'it-IT');
  ba.status === 422 && ba.body && ba.body.code === 'transcribe_bad_audio'
    ? ok('un file che non e\' audio viene rifiutato: «transcribe_bad_audio», non un silenzio')
    : bad('rifiuto mancato per un file non audio: ' + ba.status + ' ' + JSON.stringify(ba.body));

  if (it) {
    const up = await upload(tok, 'voce.m4a', 'audio/mp4', it);
    const nl = await transcribe(tok, up.id, 'xx-XX');
    nl.status === 422 && nl.body && nl.body.code === 'transcribe_no_language'
      ? ok('una lingua che non esiste viene rifiutata: «transcribe_no_language»')
      : bad('rifiuto mancato per una lingua inesistente: ' + nl.status + ' ' + JSON.stringify(nl.body));
  }

  // ---- 4. senza gettone non si trascrive niente
  const anon = await fetch(BASE + '/api/transcribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x', lang: 'it-IT' }),
  });
  anon.status === 401 ? ok('senza gettone: 401') : bad('senza gettone risponde ' + anon.status);

  // Il finto dispositivo lascia il posto.
  await fetch(BASE + '/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nella prova:', e); process.exit(2); });
