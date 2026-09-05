#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   IL PONTE VERO — la prova contro il ponte configurato sul Mac, quello
   sulla propria macchina, non uno locale.

   E' la situazione di chi e' fuori casa: Chrome apre la pagina **dal
   ponte** (l'indirizzo che il Mac ha nel pannello, riga «Ponte»)
   col codice dopo il cancelletto, come farebbe il QR; si accoppia dentro il
   canale WebRTC, legge l'elenco, apre la diretta. Il Mac deve essere acceso e
   in ascolto sul ponte (nel registro: «punto d'incontro: in ascolto»).

   Non tocca la configurazione del Mac. Il dispositivo di prova si scollega
   da solo. Serve Node 22 e Riflesso installato.

      node tools/pontetest.js
------------------------------------------------------------------ */

const { launch, sleep } = require('./browser');
const { pin } = require('./pin');

const LOCAL = 'http://127.0.0.1:7654';

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function hostJSON(pathname, opts = {}) {
  const res = await fetch(LOCAL + pathname, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const code = pin();
  const pair = await hostJSON('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: code, label: 'prova-ponte-vero', id: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0' }),
  });
  const tok = (pair.body && pair.body.token) || '';
  if (!tok) { bad('accoppiamento di prova fallito: ' + JSON.stringify(pair.body)); process.exit(1); }

  const remote = (await hostJSON('/api/remote', { headers: { Authorization: 'Bearer ' + tok } })).body || {};
  const base = (remote.base || '').replace(/\/+$/, '');
  if (!base) {
    info('nessun ponte configurato sul Mac: niente da provare (pannello → riga «Ponte»)');
    await hostJSON('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    process.exit(0);
  }
  info(`ponte del Mac: ${base} · stato: ${remote.state}`);
  const h = await fetch(base + '/health', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
  h && h.app === 'riflesso-bridge' ? ok('il ponte risponde: ' + JSON.stringify(h)) : bad('il ponte non risponde: ' + JSON.stringify(h));

  // Come dal QR.
  const b = await launch(`${base}/#p=${code}`);
  let ps = null;
  for (let i = 0; i < 120; i++) {
    ps = await b.evalJS(`({ screen: (document.querySelector('.screen:not(.hidden)') || {}).id, remote: Net.remote,
                           state: Net.state, where: Net.where, err: document.getElementById('pairError').textContent,
                           road: typeof Net.road === 'string' ? Net.road : '(webapp senza strade)' })`).catch(() => null);
    if (ps && ps.screen === 'list') break;
    if (ps && ps.err && !/looking|waiting|connecting|cerco|collego|aspetto/i.test(ps.err)) break;
    await sleep(500);
  }
  ps && ps.remote === true ? ok('la pagina arriva dal ponte e lo sa (Net.remote vero, strada ' + ps.road + ')')
                           : bad('la pagina non si sa dal ponte: ' + JSON.stringify(ps));
  ps && ps.screen === 'list' ? ok('accoppiato col solo codice attraverso il ponte vero')
                             : bad('accoppiamento fallito: ' + JSON.stringify(ps));
  let alive = null;
  for (let i = 0; i < 60; i++) {
    alive = await b.evalJS(`({ n: S.chats.length, ws: !!(S.ws && S.ws.readyState === 1), where: Net.where,
                              ms: Net.stats.msToOpen, pair: Net.stats.pair,
                              text: (document.getElementById('statusText') || {}).textContent || '' })`).catch(() => null);
    if (alive && alive.n > 0 && alive.ws) break;
    await sleep(500);
  }
  alive && alive.n > 0 && alive.ws
    ? ok(`elenco (${alive.n} conversazioni) e diretta dentro il tubo · canale aperto in ${alive.ms} ms · ${alive.pair} · ${alive.where}`)
    : bad('l\'app non vive dietro il ponte: ' + JSON.stringify(alive));
  if (alive && alive.text) info('riga di stato: «' + alive.text + '»');
  else info('la webapp servita dal ponte non ha la riga di stato (versione vecchia sul ponte?)');
  const page = await b.evalJS(`(document.querySelector('meta[name="riflesso-build"]') || {}).content || ''`).catch(() => '');
  info('webapp sul ponte: ' + page);
  info('immagine: ' + await b.shot('ponte-vero-elenco.png'));

  const errs = b.consoleErrors.filter(e => !/favicon|manifest|icon-/.test(e));
  errs.length === 0 && b.exceptions.length === 0 ? ok('zero errori in console') : bad('errori: ' + errs.concat(b.exceptions).slice(0, 3).join(' | '));

  const gone = await b.evalJS(`(async () => {
    const r = await Net.fetch('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + Net.token } });
    return r.status;
  })()`).catch(e => 'errore: ' + e.message);
  gone === 200 ? ok('il dispositivo di prova si scollega dal ponte') : bad('resta accoppiato · ' + gone);
  await b.kill();
  await hostJSON('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nel collaudo:', e); process.exit(2); });
