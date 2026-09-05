'use strict';

/* ------------------------------------------------------------------
   La barra «Claude sta lavorando», su un turno vero.

   Fin qui era stata vista solo con righe finte scritte a mano. Qui si manda
   un messaggio davvero — su una conversazione **di prova**, mai su una sua —
   e si guarda cosa arriva al telefono:

     · i token crescono mentre risponde;
     · lo strumento compare e poi sparisce;
     · alla fine la barra se ne va (`active: false`).

   uso: node --experimental-websocket tools/workingtest.js <cliSessionId>
------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const cliId = process.argv[2];
  if (!cliId) { console.log('serve il cliSessionId di una chat di PROVA'); process.exit(2); }

  const token = fs.readFileSync(path.join(__dirname, '..', 'test-output/remote-token.txt'), 'utf8').trim();
  const ws = new WebSocket(`ws://127.0.0.1:7654/ws?token=${token}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const working = [];      // ogni chatWorking ricevuto
  const events = [];
  let done = null;

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const m = JSON.parse(ev.data);
    if (m.chat && m.chat !== cliId) return;
    if (m.t === 'chatWorking') {
      working.push(m);
      const riga = m.active
        ? `  ${String(m.secs).padStart(3)}s · ${String(m.tokens).padStart(6)} token`
          + (m.tool ? ` · ⚙ ${m.tool}${m.tools ? ' ×' + m.tools : ''}` : '')
        : '  — la barra sparisce —';
      console.log(riga);
      return;
    }
    if (m.t === 'chatDone') { done = m; }
    if (['chatNote', 'chatDone', 'chatStart', 'chatAppend'].includes(m.t)) events.push(m.t);
  };

  ws.send(JSON.stringify({ t: 'openChat', id: cliId, end: 0 }));
  await sleep(600);

  const testo = 'Prova di Riflesso. Esegui `date` con Bash, poi scrivi una riga sola: pronto.';
  console.log('invio    :', testo, '\n');
  ws.send(JSON.stringify({ t: 'sendChat', id: cliId, text: testo }));

  for (let i = 0; i < 400 && !done; i++) await sleep(500);
  await sleep(4000);   // l'ultima barra arriva dopo il chatDone
  ws.close();

  const attive = working.filter(w => w.active);
  const conStrumento = attive.filter(w => w.tool);
  const tokens = attive.map(w => w.tokens);
  const cresciuti = tokens.length > 1 && Math.max(...tokens) > Math.min(...tokens);
  const spenta = working.length > 0 && working[working.length - 1].active === false;

  console.log('\n--- esito ---');
  console.log('barre ricevute      :', working.length, `(${attive.length} attive)`);
  console.log('token cresciuti     :', cresciuti ? `sì (${Math.min(...tokens)} → ${Math.max(...tokens)})` : 'NO');
  console.log('strumento comparso  :', conStrumento.length
    ? `sì (${[...new Set(conStrumento.map(w => w.tool))].join(', ')})` : 'NO');
  console.log('barra sparita alla fine:', spenta ? 'sì' : 'NO');
  console.log('risposta finale     :', done ? (done.ok === false ? 'RIFIUTATA: ' + done.text : 'ok') : 'nessuna');

  process.exit(cresciuti && spenta && done && done.ok !== false ? 0 : 1);
})().catch(e => { console.error('ERRORE', e); process.exit(1); });
