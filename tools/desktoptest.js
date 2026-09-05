#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   SYNC — la prova del giro nuovo: il telefono manda, **il Desktop
   lavora**.

   Si guida la webapp vera in Chrome, si scrive nella chat di PROVA e
   si controlla che:

   1. il messaggio venga consegnato dentro Claude Desktop (lo dice il
      log del Desktop: `sendMessage: sessionId=…`) e proprio nella
      sessione giusta;
   2. la risposta compaia sul telefono senza fare altro, perche' il
      sorvegliante del transcript la vede arrivare;
   3. **nessuna chat vera venga toccata**: le impronte dei loro file
      devono restare identiche al byte.

   Gira SEMPRE su una sessione di prova nostra. Il controllo 3 non e'
   una formalita': la prima versione di questo percorso ha mandato un
   messaggio in una chat vera, ed e' cosi' che ce ne siamo accorti.
------------------------------------------------------------------ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./browser');

const BASE = process.env.RIFLESSO_URL || 'http://localhost:7654';
const PIN = process.env.RIFLESSO_PIN || '';
const CHAT = process.env.RIFLESSO_TEST_CHAT || '';
const SESSION = process.env.RIFLESSO_TEST_SESSION || ('local_' + CHAT);
const DESKTOP_LOG = path.join(os.homedir(), 'Library/Logs/Claude/main.log');
const PROJECTS = path.join(os.homedir(), '.claude/projects');

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

/* Le impronte di tutte le chat che NON sono la nostra: nessuna deve muoversi. */
function fingerprints() {
  const out = {};
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl') || f.startsWith(CHAT)) continue;
      const p = path.join(full, f);
      try { out[p] = fs.statSync(p).size; } catch { /* sparito nel frattempo */ }
    }
  }
  return out;
}

/* Il log del Desktop letto **da un punto in poi**: e' la sua dichiarazione di
   che cosa ha ricevuto e in quale sessione. Va letto per posizione nel file,
   non per coda: la coda scorre e i confronti si sfasano. */
function logSince(offset) {
  const size = fs.statSync(DESKTOP_LOG).size;
  if (size <= offset) return '';
  const fd = fs.openSync(DESKTOP_LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

async function main() {
  if (!CHAT) { bad('manca RIFLESSO_TEST_CHAT'); process.exit(2); }
  if (!fs.existsSync(DESKTOP_LOG)) { bad('Claude Desktop non ha un log: è in esecuzione?'); process.exit(2); }

  const before = fingerprints();
  const logBefore = fs.statSync(DESKTOP_LOG).size;
  /* Le chat che si stavano gia' muovendo per conto loro (una routine, una
     sessione al lavoro sul Mac): il loro file cresce comunque e non e' colpa
     nostra. Si segnano adesso per non accusarsene dopo. */
  const alreadyBusy = new Set(Object.keys(before).filter(
    (p) => Date.now() - fs.statSync(p).mtimeMs < 120000));
  if (alreadyBusy.size) info(alreadyBusy.size + ' conversazioni stanno già lavorando per conto loro');
  const marker = 'DESKTOP-' + Math.floor(Math.random() * 900000 + 100000);

  const b = await launch(BASE);
  await sleep(1400);
  await b.evalJS(`I18n.set('en')`);
  if (await b.evalJS(`!document.getElementById('pair').classList.contains('hidden')`)) {
    await b.evalJS(`(() => {
      const i = document.getElementById('pinInput');
      i.value = '${PIN}';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1600);
  }

  await b.goto(BASE + '/#chat=' + CHAT);
  await sleep(2600);
  const opened = await b.evalJS(`(() => ({
    open: !document.getElementById('chat').classList.contains('hidden'),
    title: document.getElementById('chatTitle').textContent,
    items: document.getElementById('messages').children.length,
  }))()`);
  opened.open && opened.items > 0
    ? ok(`chat di prova aperta sul telefono: «${opened.title}» (${opened.items} blocchi)`)
    : bad('la chat di prova non si apre: ' + JSON.stringify(opened));

  /* ---------- si scrive dal «telefono» ---------- */
  await b.evalJS(`(() => {
    const m = document.getElementById('msg');
    m.value = ${JSON.stringify('Rispondi solo con: ' + marker + '. Non usare strumenti.')};
    m.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
  })()`);
  info('messaggio partito dal telefono: ' + marker);

  /* ---------- lo consegna il Desktop? ---------- */
  let sent = [];
  for (let i = 0; i < 90 && !sent.length; i++) {
    await sleep(1000);
    sent = [...logSince(logBefore).matchAll(/LocalSessions\.sendMessage: sessionId=(\S+?),/g)]
      .map((m) => m[1]);
  }
  if (!sent.length) {
    bad('il Desktop non ha ricevuto nessun messaggio');
  } else if (sent.every((s) => s === SESSION)) {
    ok('consegnato dentro Claude Desktop, nella sessione giusta (' + SESSION + ')');
  } else {
    bad('MESSAGGI FINITI IN ALTRE SESSIONI: ' + sent.filter((s) => s !== SESSION).join(', '));
  }

  /* ---------- la risposta arriva sul telefono da sola ---------- */
  let seen = false;
  for (let i = 0; i < 90 && !seen; i++) {
    await sleep(1000);
    seen = await b.evalJS(`document.getElementById('messages').textContent.includes('${marker}')`);
  }
  seen ? ok('la risposta del Desktop è comparsa sul telefono da sola')
       : bad('la risposta non è arrivata sul telefono entro 90s');

  /* Lo spinner deve spegnersi: il Desktop dichiara la fine del turno nel suo
     log, e l'host lo aspetta. Uno spinner che gira per sempre e' una bugia
     sullo schermo, quindi qui gli si da' tempo e poi lo si pretende. */
  let spinning = true;
  for (let i = 0; i < 40 && spinning; i++) {
    await sleep(1000);
    spinning = await b.evalJS(`document.getElementById('live').textContent.includes('Working')`);
  }
  spinning ? bad('lo spinner «Claude is working» non si è mai spento')
           : ok('lo spinner si è spento quando il Desktop ha finito il turno');

  /* ---------- nessuna chat vera toccata ---------- */
  const after = fingerprints();
  const moved = Object.keys(before).filter(
    (p) => after[p] !== undefined && after[p] !== before[p] && !alreadyBusy.has(p));
  if (!moved.length) {
    ok('nessun altro transcript è cambiato per causa nostra');
  } else {
    bad('sono cambiati ' + moved.length + ' transcript che non c\'entravano:');
    moved.slice(0, 5).forEach((p) => info('  ' + path.basename(p) + ' ' + before[p] + ' → ' + after[p]));
  }

  await b.kill();
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} controlli falliti.` : '\ntutti i controlli superati.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
