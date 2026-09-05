#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   DUE STRADE — le prove a mano del 03/09 e del 04/09/2026, ripetibili.

   Nato come «una strada sola» (solo Tailscale), poi «tre strade» col ponte
   tornato; dal 04/09 sera Tailscale e' stata tolta dall'app e le strade sono
   **due**: la rete di casa e il ponte. Qui si prova che tutte e due funzionano,
   che la pagina sa da quale e' arrivata, e che **lo dice**.

   1. `/api/pin` non esiste piu': 404 dal Mac. Era il buco: dietro un inoltro
      il codice si leggeva in chiaro da chiunque. Il codice si prende da
      `Riflesso --print-pin` (socket Unix), non dall'HTTP.
   2. **Casa**: la webapp aperta sulla 7654 e' in strada `casa`, si accoppia,
      legge l'elenco, apre la diretta, e la riga di stato dice «home network».
      Sulla rete di casa il tasto della voce **non c'e'** (la pagina e' in
      http, il microfono in pagina non esiste) e le Impostazioni lo dicono.
   3. **Ponte**: un punto d'incontro locale (`bridge/main.ts` con deno, su
      127.0.0.1:8787), il Mac configurato per usarlo, e Chrome che apre la
      pagina **dal ponte**: `Net.remote` vero, `Net.road === 'ponte'`, si
      accoppia col solo codice dentro il canale WebRTC, elenco e diretta
      passano dal tubo, e la riga di stato dice «bridge · at home».
   4. **L'elenco arriva in spinta**: fermi sull'elenco per venti secondi non
      parte nessuna richiesta di `/api/chats`; il timer dei sei secondi non
      c'e' piu'.

   Serve Node 22, Riflesso installato e acceso, deno. Il Mac viene messo sul
   ponte locale per la durata della prova e poi rimesso com'era; i dispositivi
   di prova si scollegano da soli.
------------------------------------------------------------------ */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { launch, sleep } = require('./browser');
const { pin } = require('./pin');

const ROOT = path.resolve(__dirname, '..');
const LOCAL = 'http://127.0.0.1:7654';
// La porta del ponte locale: `RIFLESSO_BRIDGE_PORT` se la 8787 e' occupata da
// un altro progetto (successo il 04/09/2026: un server di sviluppo la teneva).
const BRIDGE_PORT = Number(process.env.RIFLESSO_BRIDGE_PORT) || 8787;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function status(url) {
  try { return (await fetch(url, { cache: 'no-store' })).status; }
  catch (e) { return 'errore: ' + e.message; }
}

async function hostJSON(pathname, opts = {}) {
  const res = await fetch(LOCAL + pathname, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Un gettone per parlare con l'API del Mac da questa prova. */
async function apiToken(code) {
  const r = await hostJSON('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: code, label: 'prova-due-strade', id: '7e57e57e7e57e57e7e57e57e7e57e57e' }),
  });
  return (r.body && r.body.token) || '';
}

/** Accoppia dentro Chrome, se la schermata del codice e' davanti. */
async function pairInBrowser(b, code, waitMs) {
  if (await b.evalJS(`!document.getElementById('pair').classList.contains('hidden')`) && code) {
    await b.evalJS(`(() => {
      const i = document.getElementById('pinInput');
      i.value = '${code}';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  }
  for (let i = 0; i < Math.ceil(waitMs / 500); i++) {
    if (await b.evalJS(`!document.getElementById('list').classList.contains('hidden')`)) return true;
    await sleep(500);
  }
  return false;
}

async function forgetFromBrowser(b) {
  return b.evalJS(`(async () => {
    const r = await Net.fetch('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + Net.token } });
    return r.status;
  })()`).catch(e => 'errore: ' + e.message);
}

/** Quante `/api/chats` sono partite finora da questa pagina. */
const chatRequests = (b) => b.evalJS(`performance.getEntriesByType('resource').filter(e => /\\/api\\/chats/.test(e.name)).length`);

async function main() {
  // ---- 1. il buco e' chiuso
  const s = await status(LOCAL + '/api/pin');
  s === 404 ? ok(`${LOCAL}/api/pin → 404`) : bad(`${LOCAL}/api/pin → ${s} (doveva essere 404)`);
  const hl = await (await fetch(LOCAL + '/health')).json();
  hl.app === 'Riflesso' ? ok(`/health dice Riflesso ${hl.version} (binario ${hl.build})`) : bad('/health: ' + JSON.stringify(hl));
  let code = '';
  try { code = pin(); ok(`Riflesso --print-pin risponde (${code.length} cifre)`); }
  catch (e) { bad('Riflesso --print-pin non risponde: ' + e.message); }
  const tok = await apiToken(code);
  tok ? ok('gettone di prova per l\'API') : bad('accoppiamento di prova fallito');

  // Il Mac non dichiara piu' strade dirette: quel campo non c'e' piu'.
  const stat = await hostJSON('/api/status', { headers: { Authorization: 'Bearer ' + tok } });
  stat.body && stat.body.direct === undefined
    ? ok('il Mac non dichiara piu\' strade dirette (niente `direct` in /api/status)')
    : bad('/api/status porta ancora `direct`: ' + JSON.stringify(stat.body && stat.body.direct));

  // ---- 2. CASA — la pagina dalla 7654
  {
    const b = await launch(LOCAL);
    await sleep(1200);
    await b.evalJS(`I18n.set('en')`);
    await b.evalJS(`localStorage.setItem('riflesso.deviceId', 'ca5aca5aca5aca5aca5aca5aca5aca5a')`);
    const road = await b.evalJS('({ road: Net.road, remote: Net.remote })');
    road.road === 'casa' && road.remote === false
      ? ok('casa: la pagina dalla 7654 e\' in strada «casa», senza sonda e senza tubo')
      : bad('casa: ' + JSON.stringify(road));
    const pairRoad = await b.evalJS(`document.getElementById('pairRoad').textContent`);
    /home network/.test(pairRoad) ? ok('casa: sotto il codice c\'e\' scritto «' + pairRoad + '»')
                                  : bad('casa: sotto il codice manca la strada: «' + pairRoad + '»');
    (await pairInBrowser(b, code, 4000)) ? ok('casa: accoppiato, si vede l\'elenco') : bad('casa: accoppiamento fallito');
    await sleep(2000);
    const st = await b.evalJS(`({ n: document.querySelectorAll('.chatrow').length, live: S.connected,
                                  text: document.getElementById('statusText').textContent })`);
    st.n > 0 && st.live ? ok(`casa: ${st.n} conversazioni e diretta aperta`) : bad('casa: ' + JSON.stringify(st));
    /home network · 127\.0\.0\.1:7654/.test(st.text)
      ? ok('casa: la riga di stato dice «' + st.text + '»') : bad('casa: riga di stato: «' + st.text + '»');
    const cassetti = await b.evalJS(`({
      token: !!localStorage.getItem('riflesso.token'),
      direct: localStorage.getItem('riflesso.direct'),
      remote: localStorage.getItem('riflesso.token.remote'),
    })`);
    cassetti.token && !cassetti.direct && !cassetti.remote
      ? ok('casa: un cassetto solo per il gettone, niente cassetti delle strade dirette')
      : bad('casa: cassetti: ' + JSON.stringify(cassetti));

    // ---- 4. l'elenco arriva in spinta: fermi, nessuna richiesta
    const prima = await chatRequests(b);
    await sleep(20000);
    const dopo = await chatRequests(b);
    dopo === prima ? ok(`spinta: fermi sull'elenco per 20 s non parte nessuna /api/chats (${prima} in tutto, dall'apertura)`)
                   : bad(`spinta: sono partite ${dopo - prima} /api/chats in 20 s fermi: il timer c'e' ancora`);
    // Su localhost Chrome ha il contesto sicuro: il tasto della voce c'e'.
    // Sulla rete di casa vera (http su 192.168.x.x) sparirebbe.
    const voce = await b.evalJS(`({ visible: !document.getElementById('micBtn').classList.contains('hidden'),
                                    secure: window.isSecureContext })`);
    voce.visible === voce.secure ? ok(`casa: il tasto della voce ${voce.visible ? 'c\'e\'' : 'non c\'e\''} perche' il contesto ${voce.secure ? 'e\'' : 'non e\''} sicuro`)
                                 : bad('casa: tasto della voce incoerente col contesto: ' + JSON.stringify(voce));
    (await forgetFromBrowser(b)) === 200 ? ok('casa: il dispositivo di prova si scollega') : bad('casa: resta accoppiato');
    const errs = b.consoleErrors.filter(e => !/favicon|manifest|icon-/.test(e));
    errs.length === 0 && b.exceptions.length === 0 ? ok('casa: zero errori in console') : bad('casa: errori: ' + errs.concat(b.exceptions).slice(0, 3).join(' | '));
    await b.kill();
  }

  // ---- 3. PONTE — un punto d'incontro locale, e la pagina presa da li'
  let deno = null;
  let previous = null;
  try {
    execFileSync('bash', [path.join(ROOT, 'tools/bridge-sync.sh')], { stdio: 'ignore' });
    deno = spawn('deno', ['run', `--allow-net=0.0.0.0:${BRIDGE_PORT},127.0.0.1:${BRIDGE_PORT}`, '--allow-read', '--allow-env',
                          path.join(ROOT, 'bridge/main.ts')],
      { env: Object.assign({}, process.env, { PORT: String(BRIDGE_PORT), BIND: '127.0.0.1' }), stdio: 'ignore' });
    await sleep(1500);
    const h = await fetch(BRIDGE + '/health').then(r => r.json()).catch(() => null);
    h && h.app === 'riflesso-bridge' ? ok('ponte: il punto d\'incontro locale risponde (' + BRIDGE + ')') : bad('ponte: non risponde');

    previous = (await hostJSON('/api/remote', { headers: { Authorization: 'Bearer ' + tok } })).body || {};
    const set = await hostJSON('/api/remote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ base: BRIDGE, on: true }),
    });
    set.body && set.body.ok && set.body.base === BRIDGE
      ? ok('ponte: il Mac punta al ponte locale (' + set.body.state + ')') : bad('ponte: /api/remote: ' + JSON.stringify(set.body));
    await sleep(1500);

    const b = await launch(`${BRIDGE}/#p=${code}`);
    await sleep(1200);
    await b.evalJS(`I18n.set('en')`);
    let ps = null;
    for (let i = 0; i < 80; i++) {
      ps = await b.evalJS(`({ screen: document.querySelector('.screen:not(.hidden)')?.id, road: Net.road,
                             remote: Net.remote, state: Net.state, where: Net.where,
                             err: document.getElementById('pairError').textContent })`);
      if (ps.screen === 'list') break;
      await sleep(500);
    }
    ps.remote === true && ps.road === 'ponte' ? ok('ponte: la pagina arriva dal ponte e lo sa (Net.remote vero, strada «ponte»)')
                                              : bad('ponte: ' + JSON.stringify(ps));
    ps.screen === 'list' ? ok('ponte: accoppiato col solo codice dentro il canale WebRTC')
                         : bad('ponte: accoppiamento fallito: ' + JSON.stringify(ps));
    let alive = null;
    for (let i = 0; i < 40; i++) {
      alive = await b.evalJS(`({ n: S.chats.length, ws: !!(S.ws && S.ws.readyState === 1), state: Net.state, where: Net.where,
                                text: document.getElementById('statusText').textContent, ms: Net.stats.msToOpen })`);
      if (alive.n > 0 && alive.ws) break;
      await sleep(500);
    }
    alive.n > 0 && alive.ws ? ok(`ponte: ${alive.n} conversazioni e diretta dentro il tubo (canale aperto in ${alive.ms} ms)`)
                            : bad('ponte: ' + JSON.stringify(alive));
    alive.text.includes(`bridge · at home (127.0.0.1:${BRIDGE_PORT})`)
      ? ok('ponte: la riga di stato dice «' + alive.text + '»') : bad('ponte: riga di stato: «' + alive.text + '»');
    info('immagine: ' + await b.shot('strade-ponte-elenco.png'));
    // Dal ponte la pagina non salta piu' da nessuna parte: resta sulla sua origine.
    const origin = await b.evalJS('location.origin');
    origin === BRIDGE ? ok('ponte: la pagina resta sulla sua origine, nessun salto verso altre strade')
                      : bad('ponte: la pagina e\' finita su ' + origin);

    // ---- 3b. senza il segreto della stanza si torna al codice, dicendo perche'
    // E' il guasto del 04/09/2026 (il Mac aveva rigenerato il segreto e il
    // telefono bussava a una stanza vuota per sempre). Qui si simula togliendo
    // `riflesso.meet` dal cassetto e riaprendo la pagina: dopo tre fallimenti
    // di fila (`senza-incontro`) la pagina deve buttare il gettone e chiedere
    // il codice, non ritentare all'infinito.
    const tokB = await b.evalJS('Net.token');
    await b.evalJS(`localStorage.removeItem('riflesso.meet')`);
    await b.goto(BRIDGE + '/');
    let back = null, waited = 0;
    for (; waited < 90; waited++) {
      await sleep(1000);
      back = await b.evalJS(`({ screen: (document.querySelector('.screen:not(.hidden)') || {}).id,
                                err: document.getElementById('pairError').textContent,
                                token: !!localStorage.getItem('riflesso.token') })`).catch(() => null);
      if (back && back.screen === 'pair' && back.err) break;
    }
    back && back.screen === 'pair' && !back.token
      ? ok(`senza il segreto della stanza la pagina torna al codice e butta il gettone (in ${waited + 1} s)`)
      : bad('senza il segreto la pagina non torna al codice: ' + JSON.stringify(back));
    back && /code once more|riscrivere il codice/.test(back.err || '')
      ? ok('e dice perche\': «' + back.err + '»') : bad('torna al codice senza spiegazione: ' + JSON.stringify(back));
    const errs = b.consoleErrors.filter(e => !/favicon|manifest|icon-/.test(e));
    errs.length === 0 && b.exceptions.length === 0 ? ok('ponte: zero errori in console') : bad('ponte: errori: ' + errs.concat(b.exceptions).slice(0, 3).join(' | '));
    // Il gettone della pagina e' stato buttato: si scollega dal Mac con la copia presa prima.
    const goneB = await hostJSON('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tokB } });
    goneB.status === 200 ? ok('ponte: il dispositivo di prova si scollega') : bad('ponte: resta accoppiato · ' + goneB.status);
    await b.kill();
  } finally {
    if (previous) {
      await hostJSON('/api/remote', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ base: previous.base || '', on: previous.on !== false }),
      }).catch(() => {});
      info('il Mac e\' tornato sul ponte di prima: ' + (previous.base || '(nessuno)'));
    }
    if (deno) deno.kill();
  }

  // ---- 5. il gettone della prova lascia il posto
  const gone = await hostJSON('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
  gone.status === 200 ? ok('il gettone di prova si scollega da solo') : bad('il gettone di prova resta · ' + gone.status);

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nel collaudo:', e); process.exit(2); });
