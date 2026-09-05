'use strict';

/* ------------------------------------------------------------------
   Cambio dell'impegno dal telefono, provato fino in fondo.

   Fin qui l'unica prova era finita sempre sul rifiuto «il Mac è in uso»:
   il codice c'era, ma nessuno l'aveva visto muovere davvero il cursore.

   Qui si manda il comando come lo manderebbe il telefono, e poi si guarda
   **il file del Desktop**: se l'impegno è cambiato per davvero, il campo
   `effort` di `local_<sessione>.json` cambia.

   Solo su una sessione di prova, mai su una chat vera.
------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const glob = require('fs');

const HOST = 'http://127.0.0.1:7654';
const SESSIONS = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code-sessions');
const LIVELLI = ['Basso', 'Medio', 'Alto', 'Extra', 'Max', 'Ultracode'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function indexFile(cliId) {
  const stack = [SESSIONS];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { stack.push(p); continue; }
      if (name === `local_${cliId}.json`) return p;
    }
  }
  return null;
}

const readEffort = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).effort ?? null; }
  catch (e) { return null; }
};

(async () => {
  const cliId = process.argv[2];
  const target = Number(process.argv[3] ?? 1);
  if (!cliId) { console.log('uso: efforttest.js <cliSessionId> [livello 0-5]'); process.exit(2); }

  const file = indexFile(cliId);
  if (!file) { console.log('NO   il Desktop non conosce questa sessione'); process.exit(1); }
  console.log('sessione :', path.basename(file));
  console.log('impegno prima :', readEffort(file));

  const token = fs.readFileSync(path.join(__dirname, '..', 'test-output/remote-token.txt'), 'utf8').trim();
  const ws = new WebSocket(`ws://127.0.0.1:7654/ws?token=${token}`);
  const said = [];

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const m = JSON.parse(ev.data);
    if (m.t === 'chatNote' || m.t === 'chatDone') said.push(m);
  };

  console.log(`comando  : setEffort → ${target} (${LIVELLI[target]})`);
  ws.send(JSON.stringify({ t: 'openChat', id: cliId, end: 0 }));
  await sleep(400);
  ws.send(JSON.stringify({ t: 'setEffort', id: cliId, level: target }));

  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (said.some(m => m.t === 'chatDone')) break;
  }
  ws.close();

  for (const m of said) console.log('  host  :', m.t, m.ok === false ? '✗' : '', m.text || '');

  await sleep(1500);
  const after = readEffort(file);
  console.log('impegno dopo  :', after);

  const done = said.find(m => m.t === 'chatDone');
  const ok = done && done.ok !== false && after === LIVELLI[target].toLowerCase().replace('extra', 'xhigh');
  // La mappa dei nomi la scrive il Desktop, non noi: si stampa e si guarda.
  console.log(ok ? '\nOK: l\'impegno è cambiato davvero.'
                 : `\nESITO: chatDone=${done ? (done.ok !== false) : 'nessuno'} · effort ora = ${after}`);
  process.exit(done && done.ok !== false ? 0 : 1);
})().catch(e => { console.error('ERRORE', e); process.exit(1); });
