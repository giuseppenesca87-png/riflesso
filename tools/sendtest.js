#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   PIVOT §9.4 e §9.5 — le due prove che contano davvero:

   4. si invia un messaggio dal telefono, la risposta arriva in
      streaming e il transcript resta coerente;
   5. si scrive nella chat DAL MAC mentre il telefono e' aperto, e il
      messaggio nuovo compare da solo.

   Gira SEMPRE su una sessione di prova nostra, mai su una chat vera.
------------------------------------------------------------------ */

const { spawn } = require('child_process');
const fs = require('fs');
const { launch, sleep } = require('./browser');

const BASE = process.env.RIFLESSO_URL || 'http://localhost:7654';
const PIN = process.env.RIFLESSO_PIN || '';
const CHAT = process.env.RIFLESSO_TEST_CHAT || '';
const CWD = process.env.RIFLESSO_TEST_CWD || '';
const TRANSCRIPT = process.env.RIFLESSO_TEST_FILE || '';

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function main() {
  if (!CHAT) { bad('manca RIFLESSO_TEST_CHAT'); process.exit(2); }

  const b = await launch(BASE);
  await sleep(1400);
  await b.evalJS(`I18n.set('en')`);

  // accoppiamento
  if (await b.evalJS(`!document.getElementById('pair').classList.contains('hidden')`)) {
    await b.evalJS(`(() => {
      const i = document.getElementById('pinInput');
      i.value = '${PIN}';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1600);
  }

  // apertura della chat di prova col collegamento diretto
  await b.goto(BASE + '/#chat=' + CHAT);
  await sleep(2600);
  const opened = await b.evalJS(`(() => ({
    open: !document.getElementById('chat').classList.contains('hidden'),
    title: document.getElementById('chatTitle').textContent,
    items: document.getElementById('messages').children.length,
  }))()`);
  opened.open && opened.items > 0
    ? ok(`chat di prova aperta: «${opened.title}» con ${opened.items} blocchi`)
    : bad('la chat di prova non si apre: ' + JSON.stringify(opened));

  const sizeBefore = TRANSCRIPT && fs.existsSync(TRANSCRIPT) ? fs.statSync(TRANSCRIPT).size : 0;

  /* ---------- §9.4 invio vero ---------- */

  const marker = 'PROVA-INVIO-' + Date.now().toString().slice(-6);
  const prompt = `Rispondi con una riga di testo che contenga esattamente ${marker}, `
               + `poi una riga con **grassetto** e un elenco di due voci. Non usare strumenti.`;

  await b.evalJS(`(() => {
    const t = document.getElementById('msg');
    t.value = ${JSON.stringify(prompt)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
  })()`);
  await sleep(500);

  const echo = await b.evalJS(`document.querySelectorAll('#messages .row.me').length`);
  echo > 0 ? ok('il messaggio compare subito come bolla tua') : bad('nessuna bolla in uscita');

  // si aspetta che il testo cominci ad arrivare parola per parola
  let sawStreaming = false, streamShot = false, sawWorking = false;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const st = await b.evalJS(`(() => {
      const live = document.getElementById('live');
      const bub = live.querySelector('.bubble');
      return {
        working: !!live.querySelector('.working'),
        len: bub ? bub.textContent.length : 0,
        stop: !document.getElementById('stopBtn').classList.contains('hidden'),
      };
    })()`);
    if (st.working) sawWorking = true;
    if (st.len > 0) sawStreaming = true;
    if (st.len > 25 && !streamShot) {
      streamShot = true;
      info('catturo mentre il testo si forma… (' + st.len + ' caratteri finora)');
      info('immagine: ' + await b.shot('invio-streaming.png'));
    }
    if (!st.stop && sawWorking) break;   // finito
  }

  sawWorking ? ok('l\'indicatore «Claude sta lavorando…» compare') : bad('nessun indicatore di lavoro');
  sawStreaming ? ok('la risposta arriva in streaming, mentre si forma') : bad('nessuno streaming ricevuto');

  await sleep(3000);   // il sorvegliante sostituisce la bozza con le righe vere

  const after = await b.evalJS(`(() => {
    const box = document.getElementById('messages');
    const claude = [...box.querySelectorAll('.row.claude .bubble')];
    const last = claude[claude.length - 1];
    return {
      claudeBubbles: claude.length,
      text: last ? last.textContent.slice(0, 240) : '',
      hasMarker: last ? last.textContent.includes(${JSON.stringify(marker)}) : false,
      bold: last ? last.querySelectorAll('b').length : 0,
      li: last ? last.querySelectorAll('li').length : 0,
      liveEmpty: document.getElementById('live').textContent.trim() === '',
      // Si conta sul marcatore, che e' unico per ogni giro: la sessione di
      // prova viene riusata e contiene gia' le domande dei giri precedenti.
      duplicates: [...box.querySelectorAll('.row.me .bubble')]
        .filter(x => x.textContent.includes(${JSON.stringify(marker)})).length,
      note: document.getElementById('chatNote').classList.contains('hidden')
        ? '' : document.getElementById('chatNote').textContent,
      sub: document.getElementById('chatSub').textContent,
    };
  })()`);

  after.hasMarker
    ? ok('la risposta e\' arrivata e contiene il marcatore ' + marker)
    : bad('marcatore non trovato nella risposta. Testo: ' + after.text.slice(0, 120));
  after.bold > 0 && after.li >= 2
    ? ok('la risposta definitiva e\' resa in markdown (grassetto + elenco)')
    : bad(`markdown mancante nella risposta (b=${after.bold}, li=${after.li})`);
  after.liveEmpty ? ok('la bozza in diretta sparisce a fine risposta') : bad('bozza rimasta a schermo');
  after.duplicates === 1
    ? ok('il messaggio inviato compare una volta sola (niente doppioni)')
    : bad(`il messaggio compare ${after.duplicates} volte`);
  if (after.note) info('avviso mostrato: ' + after.note);
  info('modello dichiarato in cima: ' + after.sub);
  info('immagine: ' + await b.shot('invio-completato.png'));

  if (TRANSCRIPT && fs.existsSync(TRANSCRIPT)) {
    const sizeAfter = fs.statSync(TRANSCRIPT).size;
    sizeAfter > sizeBefore
      ? ok(`il transcript e' cresciuto: ${sizeBefore} → ${sizeAfter} byte`)
      : bad('il transcript non e\' cambiato: il messaggio non e\' stato scritto');
    // coerenza: tutte le righe restano JSON valido
    const lines = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(l => l.trim());
    let broken = 0;
    for (const l of lines) { try { JSON.parse(l); } catch (e) { broken++; } }
    broken === 0 ? ok(`transcript coerente: ${lines.length} righe, tutte leggibili`)
                 : bad(`${broken} righe rotte nel transcript`);
  }

  /* ---------- §9.5 aggiornamento dal vivo ---------- */

  info('');
  info('ora scrivo nella chat DAL MAC, mentre il telefono resta aperto…');
  const before = await b.evalJS(`document.getElementById('messages').children.length`);
  const marker2 = 'DAL-MAC-' + Date.now().toString().slice(-6);

  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  const cli = spawn('claude', [
    '--resume', CHAT, '-p', '--output-format', 'stream-json', '--verbose',
    '--model', 'claude-haiku-4-5-20251001',
    `Rispondi solo con: ${marker2}`,
  ], { cwd: CWD, env, stdio: 'ignore' });

  const done = new Promise(res => cli.on('exit', res));
  let appeared = false;
  for (let i = 0; i < 180 && !appeared; i++) {
    await sleep(500);
    appeared = await b.evalJS(
      `document.getElementById('messages').textContent.includes(${JSON.stringify(marker2)})`);
  }
  await done;
  // un attimo perche' il sorvegliante chiuda il giro
  for (let i = 0; i < 20 && !appeared; i++) {
    await sleep(700);
    appeared = await b.evalJS(
      `document.getElementById('messages').textContent.includes(${JSON.stringify(marker2)})`);
  }

  const nAfter = await b.evalJS(`document.getElementById('messages').children.length`);
  appeared
    ? ok(`scritto dal Mac, comparso da solo sul telefono senza ricaricare (${before} → ${nAfter} blocchi)`)
    : bad('il messaggio scritto dal Mac NON e\' comparso da solo');
  info('immagine: ' + await b.shot('diretta-dal-mac.png'));

  /* ---------- F2: non si scrive in una chat che il Mac sta usando ----------
     Il momento e' quello giusto: il Mac ha appena scritto in questa chat, qui
     sopra. Ci si e' finiti al primo tentativo, mandando il messaggio
     dentro la conversazione aperta davanti al Mac — e due scritture insieme
     biforcano il transcript senza dare errore. */

  info('');
  info('la chat l\'ha appena scritta il Mac: provo a inviare lo stesso…');
  if (TRANSCRIPT && fs.existsSync(TRANSCRIPT)) {
    // Il Desktop tocca il file anche solo tenendo la chat aperta: si rifa'
    // quel gesto, cosi' la prova non dipende da quanto e' durato il passo prima.
    const now = new Date();
    fs.utimesSync(TRANSCRIPT, now, now);
    await b.evalJS(`(() => {
      const t = document.getElementById('msg');
      t.value = 'Questo messaggio non deve partire.';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('composer').requestSubmit();
    })()`);
    let refused = { note: '' };
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      refused = await b.evalJS(`(() => {
        const n = document.getElementById('chatNote');
        return {
          note: n.classList.contains('hidden') ? '' : n.textContent,
          echoes: document.querySelectorAll('#messages [data-echo="1"]').length,
          draft: document.getElementById('msg').value,
          working: !!document.getElementById('live').querySelector('.working'),
        };
      })()`);
      if (refused.note) break;
    }
    /in uso adesso sul Mac/.test(refused.note)
      ? ok('l\'invio in una chat viva viene rifiutato, e il telefono lo dice')
      : bad('nessun rifiuto: ' + JSON.stringify(refused));
    refused.echoes === 0 && !refused.working
      ? ok('la bolla sparisce: non si finge che il messaggio sia partito')
      : bad('la bolla del messaggio rifiutato e\' rimasta a schermo');
    String(refused.draft).includes('non deve partire')
      ? ok('il testo torna nel riquadro, non si perde')
      : bad('il testo scritto e\' andato perso: "' + refused.draft + '"');
    info('immagine: ' + await b.shot('invio-rifiutato.png'));
    await b.evalJS(`(() => { document.getElementById('msg').value = ''; })()`);
  }

  /* ---------- errori ---------- */

  const realErrors = b.consoleErrors.filter(e => !/favicon|manifest|icon-/.test(e));
  b.exceptions.length === 0 ? ok('zero eccezioni JavaScript') : bad(b.exceptions.length + ' eccezioni');
  b.exceptions.slice(0, 4).forEach(e => info(String(e).slice(0, 200)));
  realErrors.length === 0 ? ok('zero errori in console') : bad(realErrors.length + ' errori in console');
  realErrors.slice(0, 6).forEach(e => info(e.slice(0, 200)));

  await b.kill();

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nel collaudo:', e); process.exit(2); });
