#!/usr/bin/env node --experimental-websocket
'use strict';

/* PIVOT §9.6 — riavvio pulito: se l'host si spegne e riparte, il telefono
   se ne accorge, si ricollega da solo e NON richiede di nuovo il PIN. */

const { spawn, execSync } = require('child_process');
const { launch, sleep } = require('./browser');

const BASE = process.env.RIFLESSO_URL || 'http://localhost:7654';
const PIN = process.env.RIFLESSO_PIN || '';
const HOST_CMD = process.env.RIFLESSO_HOST || '';
const WEBAPP = process.env.RIFLESSO_WEBAPP || '';

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };

async function waitHealth(up, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (up && r.ok) return true;
    } catch (e) {
      if (!up) return true;
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  const b = await launch(BASE);
  await sleep(1300);
  await b.evalJS(`I18n.set('en')`);

  if (await b.evalJS(`!document.getElementById('pair').classList.contains('hidden')`)) {
    await b.evalJS(`(() => {
      const i = document.getElementById('pinInput');
      i.value = '${PIN}';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1800);
  }
  (await b.evalJS(`!document.getElementById('list').classList.contains('hidden')`))
    ? ok('accoppiato prima del riavvio') : bad('non si e\' accoppiato');

  // giu' l'host
  try { execSync('pkill -f RiflessoHost'); } catch (e) {}
  await waitHealth(false);
  await sleep(2500);
  const noticed = await b.evalJS(`!document.getElementById('dot').classList.contains('on')`);
  noticed ? ok('la webapp si accorge della caduta') : bad('la caduta passa inosservata');

  // su l'host
  const child = spawn('sh', ['-c', HOST_CMD], {
    env: { ...process.env, RIFLESSO_WEBAPP: WEBAPP },
    stdio: 'ignore', detached: true,
  });
  child.unref();
  (await waitHealth(true)) ? ok('l\'host riparte') : bad('l\'host non riparte');

  // si deve ricollegare da solo, senza chiedere niente
  let back = false;
  for (let i = 0; i < 40 && !back; i++) {
    await sleep(700);
    back = await b.evalJS(`document.getElementById('dot').classList.contains('on')`);
  }
  back ? ok('si ricollega da sola') : bad('non si ricollega');

  const stillPaired = await b.evalJS(
    `document.getElementById('pair').classList.contains('hidden')`);
  stillPaired ? ok('non richiede di nuovo il PIN') : bad('richiede di nuovo il PIN');

  // e l'elenco chat torna a funzionare. Un host appena acceso rilegge 600
  // file di sessione: qualche secondo di attesa e' normale, non un guasto.
  await b.evalJS(`(() => {
    const s = document.getElementById('chatSearch');
    s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  let rows = 0;
  for (let i = 0; i < 30 && rows === 0; i++) {
    await sleep(700);
    rows = await b.evalJS(`document.querySelectorAll('.chatrow').length`);
  }
  rows > 0 ? ok(`l'elenco chat torna a popolarsi dopo il riavvio (${rows} righe)`)
           : bad('elenco vuoto dopo il riavvio');

  // Mentre l'host e' spento le richieste falliscono: e' la prova stessa.
  const expected = /favicon|manifest|icon-|websocket|ERR_CONNECTION_REFUSED|Failed to load resource/i;
  const realErrors = b.consoleErrors.filter(e => !expected.test(e));
  realErrors.length === 0 ? ok('nessun errore in console oltre alla caduta prevista')
                          : bad(realErrors.length + ' errori: ' + realErrors.slice(0, 3).join(' | '));

  await b.kill();
  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'riavvio pulito: tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nel collaudo:', e); process.exit(2); });
