#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   PIVOT §9.1-§9.3 e §9.6 — la webapp dentro Chrome vero, a misura di
   iPhone: l'elenco chat mostra conversazioni vere? aprendone una i
   messaggi si leggono bene? markdown, codice, strumenti compressi?
   E zero errori in console.
------------------------------------------------------------------ */

const { launch, sleep } = require('./browser');
const { pin } = require('./pin');

const BASE = process.env.RIFLESSO_URL || 'http://localhost:7654';

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function main() {
  const b = await launch(BASE);
  await sleep(1200);
  await b.evalJS(`I18n.set('en')`);

  // Il collaudo si presenta sempre con **la stessa identita'**. Prima ogni giro
  // ne inventava una nuova: se il giro moriva a meta', la pulizia in fondo non
  // arrivava mai e sul Mac restava un «Mac» in piu'. Tre giri storti di fila
  // avevano lasciato tre fantasmi nell'elenco del pannello. Cosi' il posto e'
  // uno solo e il giro dopo se lo riprende.
  await b.evalJS(`localStorage.setItem('riflesso.deviceId', 'c0110a0dc0110a0dc0110a0dc0110a0d')`);

  // ---- 1. la pagina si carica
  const title = await b.evalJS('document.title');
  title ? ok('la pagina si carica — ' + title) : bad('pagina vuota');

  // ---- 2. accoppiamento
  if (await b.evalJS(`!document.getElementById('pair').classList.contains('hidden')`)) {
    // Il codice lo dice l'app in esecuzione (`Riflesso --print-pin`), oppure
    // `RIFLESSO_PIN` se chi lancia ce l'ha gia'. Non piu' da `/api/pin`.
    let PIN = '';
    try { PIN = pin(); } catch (e) { bad('serve il PIN: ' + e.message); await b.kill(); process.exit(1); }
    await b.evalJS(`(() => {
      const i = document.getElementById('pinInput');
      i.value = '${PIN}';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1600);
  }
  const paired = await b.evalJS(`!document.getElementById('list').classList.contains('hidden')`);
  paired ? ok('PIN accettato, si vede l\'elenco chat') : bad('accoppiamento fallito');

  // ---- 3. l'elenco chat
  await sleep(1600);
  const list = await b.evalJS(`(() => {
    const rows = [...document.querySelectorAll('.chatrow')];
    return {
      n: rows.length,
      count: document.getElementById('listCount').textContent,
      first: rows.slice(0, 3).map(r => ({
        title: r.querySelector('.chatrow-title').textContent.trim(),
        when: r.querySelector('.chatrow-when').textContent.trim(),
        prev: r.querySelector('.chatrow-prev').textContent.trim().slice(0, 70),
      })),
      jsonish: rows.filter(r => /^\\s*(\\{"|\\[\\{)/.test(r.querySelector('.chatrow-prev').textContent)).length,
      overflow: rows.filter(r => r.scrollWidth > r.clientWidth + 2).length,
      // Le piu' recenti in cima — **dentro la loro sezione**.
      //
      // Prima qui bastava «la prima riga dice ora»: l'elenco era piatto.
      // Da quando ci sono i gruppi (come sul Mac: prima i gruppi con un
      // nome, poi il resto) la riga piu' recente in assoluto puo'
      // stare a meta' schermo, sotto un gruppo che non ha novita'. Quello
      // che deve restare vero e' l'ordine **dentro** ogni sezione, che e'
      // poi la cosa che si guarda davvero.
      ordered: (() => {
        const sezioni = (S.groups || []).map(g => S.chats.filter(c => c.group === g.id));
        const ids = new Set((S.groups || []).map(g => g.id));
        sezioni.push(S.chats.filter(c => !c.group || !ids.has(c.group)));
        return sezioni.every(sec => sec.every((c, i) => i === 0 || sec[i - 1].at >= c.at));
      })(),
      gruppi: (S.groups || []).map(g => g.name),
      // Ogni conversazione compare **una volta sola**: se una riga finisse
      // sia nel gruppo sia in fondo, il conto qui non tornerebbe.
      inGruppo: S.chats.filter(c => c.group).length,
      // Con le fissate e i non raggruppati ogni riga finisce in una sezione:
      // la somma delle sezioni deve fare l'elenco intero.
      totale: S.chats.length,
    };
  })()`);
  list.n > 0 ? ok(`elenco chat: ${list.n} righe (${list.count})`) : bad('elenco chat vuoto');
  list.first.forEach(f => info(`· ${f.title} — ${f.when} — ${f.prev}`));
  list.jsonish === 0 ? ok('nessuna anteprima e\' JSON grezzo') : bad(`${list.jsonish} anteprime sembrano JSON`);
  list.overflow === 0 ? ok('nessuna riga sfonda lo schermo') : bad(`${list.overflow} righe sfondano`);
  list.ordered ? ok('le conversazioni piu\' recenti stanno in cima, dentro la loro sezione')
               : bad('ordinamento sbagliato');
  info('immagine: ' + await b.shot('chat-elenco.png'));

  // ---- 3b. i gruppi, con gli stessi nomi e la stessa divisione del Mac
  // Sul Mac la barra laterale mette prima i gruppi con un nome e poi quello
  // che resta: qui deve vedersi uguale. Se il Mac
  // non ha gruppi — un'altra macchina, un'altra versione del Desktop — non
  // c'e' niente da controllare e l'elenco resta piatto: e' il caso normale
  // di chi non usa i gruppi del Desktop, e non e' un errore.
  if (list.gruppi.length) {
    const g = await b.evalJS(`(() => {
      const kids = [...document.getElementById('chatList').children];
      const teste = kids.filter(k => k.classList.contains('groupsep'));
      return {
        nomi: teste.map(h => h.querySelector('.groupsep-name').textContent),
        conte: teste.map(h => Number(h.querySelector('.groupsep-n').textContent)),
        // la prima riga dell'elenco e' un'intestazione, non una chat
        primaEUnaTesta: kids.length > 0 && kids[0].classList.contains('groupsep'),
        // e nessuna intestazione taglia il testo fuori dallo schermo
        sfondano: teste.filter(h => h.scrollWidth > h.clientWidth + 2).length,
      };
    })()`);
    // L'elenco del Mac ha tre cose, non solo i gruppi: le **fissate** in cima
    // (fuori dai gruppi, anche quando un gruppo ce l'hanno), poi i gruppi nel
    // loro ordine, e in fondo i **non raggruppati**. Le due sezioni di bordo
    // ci sono solo se hanno dentro qualcosa, quindi si tolgono prima di
    // confrontare i gruppi veri.
    const bordo = new Set(['Pinned', 'Fissato', 'Ungrouped', 'Non raggruppato']);
    const soloGruppi = g.nomi.filter(n => !bordo.has(n));
    JSON.stringify(soloGruppi) === JSON.stringify(list.gruppi)
      ? ok(`i gruppi del Mac sono qui, con gli stessi nomi e nello stesso ordine: ${soloGruppi.join(' · ')}`)
      : bad(`gruppi diversi da quelli del Mac: ${JSON.stringify(soloGruppi)} invece di ${JSON.stringify(list.gruppi)}`);

    const primo = g.nomi[0];
    !g.nomi.some(n => bordo.has(n)) || primo === 'Pinned' || primo === 'Fissato'
      ? ok('le fissate stanno in cima, fuori dai gruppi')
      : bad(`in cima c'e' «${primo}» invece delle fissate`);

    // Ogni conversazione compare **una volta sola**: la somma delle sezioni
    // deve fare l'elenco intero, non solo le raggruppate.
    const somma = g.conte.reduce((a, x) => a + x, 0);
    somma === list.totale
      ? ok(`le ${somma} conversazioni stanno ognuna in una sezione, una volta sola`)
      : bad(`conteggio delle sezioni sballato: ${somma} contro ${list.totale}`);
    g.primaEUnaTesta ? ok('le sezioni vengono prima, come nella barra laterale del Mac')
                     : bad('la prima riga dell\'elenco non e\' un gruppo');
    g.sfondano === 0 ? ok('nessuna intestazione di gruppo sfonda lo schermo')
                     : bad(`${g.sfondano} intestazioni sfondano`);

    // e una sezione si richiude al tocco, senza portarsi via le altre
    const chiusa = await b.evalJS(`(() => {
      const prima = document.querySelectorAll('.chatrow').length;
      document.querySelector('.groupsep').click();
      const dopo = document.querySelectorAll('.chatrow').length;
      document.querySelector('.groupsep').click();
      return { prima, dopo, tornate: document.querySelectorAll('.chatrow').length };
    })()`);
    chiusa.dopo < chiusa.prima && chiusa.tornate === chiusa.prima
      ? ok(`una sezione si richiude e si riapre al tocco (${chiusa.prima} → ${chiusa.dopo} → ${chiusa.tornate})`)
      : bad('la sezione non si richiude: ' + JSON.stringify(chiusa));
  } else {
    info('questo Mac non ha gruppi: l\'elenco resta piatto, ed e\' giusto cosi\'');
  }

  // ---- 4. la ricerca filtra
  // Solo lettere e numeri: un titolo puo' cominciare con un simbolo.
  const clean = (list.first[0] || {}).title || '';
  const term = (clean.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/)[0] || 'a').slice(0, 5);
  const setSearch = async (v) => {
    await b.evalJS(`(() => {
      const s = document.getElementById('chatSearch');
      s.value = ${JSON.stringify(v)};
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(900);
  };
  await setSearch(term);
  const filtered = await b.evalJS(`document.querySelectorAll('.chatrow').length`);
  filtered > 0 && filtered <= list.n
    ? ok(`la ricerca filtra: "${term}" → ${filtered} di ${list.n}`)
    : bad(`ricerca sballata: ${filtered}`);
  await setSearch('');

  // ---- 4b. F3: nell'elenco solo le chat, le routine dietro il menu
  const counts = await b.evalJS(`S.counts`);
  info(`sul Mac: ${counts.chats} chat · ${counts.routines} routine programmate`);
  list.n === counts.chats && counts.routines > counts.chats
    ? ok(`l'elenco mostra le ${counts.chats} conversazioni, non tutte le ${counts.chats + counts.routines} sessioni`)
    : bad(`l'elenco mostra ${list.n} righe con ${counts.chats} chat e ${counts.routines} routine`);
  const noRoutines = await b.evalJS(`S.chats.filter(c => c.routine).length`);
  noRoutines === 0 ? ok('nessuna routine fra le conversazioni') : bad(`${noRoutines} routine nell'elenco`);

  // e la sezione «Routine», spenta di default, si raggiunge dal menu
  await b.evalJS(`document.getElementById('settingsBtn').click()`);
  await sleep(500);
  const btnLabel = await b.evalJS(`document.getElementById('routinesBtn').textContent`);
  await b.evalJS(`document.getElementById('routinesBtn').click()`);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await b.evalJS(`S.listReady && S.listKind === 'routine'`)) break;
  }
  const routineView = await b.evalJS(`(() => ({
    name: document.getElementById('listName').textContent,
    n: document.querySelectorAll('.chatrow').length,
    back: !document.getElementById('listBack').classList.contains('hidden'),
    allRoutine: S.chats.length > 0 && S.chats.every(c => c.routine),
  }))()`);
  routineView.name === 'Routines' && routineView.n > 0 && routineView.allRoutine
    ? ok(`dal menu («${btnLabel.trim()}») si aprono le routine: ${routineView.n} righe, tutte programmate`)
    : bad('la sezione Routine non si apre: ' + JSON.stringify(routineView));
  info('immagine: ' + await b.shot('chat-routine.png'));
  routineView.back ? ok('dalle routine si torna indietro') : bad('nessun modo di tornare alle chat');
  await b.evalJS(`document.getElementById('listBack').click()`);
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (await b.evalJS(`S.listKind === 'chat' && S.chats.length > 0`)) break;
  }
  (await b.evalJS(`S.listKind === 'chat' && document.getElementById('listName').textContent === 'Chats'`))
    ? ok('e si torna alle conversazioni') : bad('non si torna alle conversazioni');

  // ---- 5. si entra in una conversazione vera
  const opened = await b.evalJS(`(() => {
    const row = document.querySelector('.chatrow:not(.closed)');
    if (!row) return null;
    const t = row.querySelector('.chatrow-title').textContent.trim();
    row.click();
    return t;
  })()`);
  if (!opened) bad('nessuna chat apribile');
  await sleep(2600);

  const chat = await b.evalJS(`(() => {
    const box = document.getElementById('messages');
    const bubbles = [...box.querySelectorAll('.bubble')];
    const wide = [...box.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 4
      && !e.closest('.code') && !e.closest('.tablewrap') && !e.classList.contains('tool-brief'));
    return {
      open: !document.getElementById('chat').classList.contains('hidden'),
      title: document.getElementById('chatTitle').textContent,
      sub: document.getElementById('chatSub').textContent,
      items: box.children.length,
      me: box.querySelectorAll('.row.me').length,
      claude: box.querySelectorAll('.row.claude').length,
      tools: box.querySelectorAll('.tool').length,
      thinks: box.querySelectorAll('.fold.think').length,
      codes: box.querySelectorAll('.code').length,
      tables: box.querySelectorAll('.tablewrap').length,
      lists: box.querySelectorAll('ul,ol').length,
      bolds: box.querySelectorAll('b').length,
      days: box.querySelectorAll('.daysep').length,
      rawJson: bubbles.filter(x => /^\\s*[{\\[]"/.test(x.textContent)).length,
      overflowing: wide.length,
      docWide: document.documentElement.scrollWidth,
      toolOneLine: [...box.querySelectorAll('.tool-head')].every(h => h.clientHeight < 44),
      bodiesHidden: [...box.querySelectorAll('.tool-body')].every(x => x.classList.contains('hidden')),
      // F5: righe di primo livello che si scorrono davvero, contro il lavoro
      // che ci sta dentro raggruppato.
      groups: box.querySelectorAll(':scope > .toolgroup').length,
      groupsClosed: [...box.querySelectorAll('.toolgroup-body')].every(x => x.classList.contains('hidden')),
      topRows: box.children.length,
      workInside: box.querySelectorAll('.toolgroup-body > .tool, .toolgroup-body > .fold').length,
      workOutside: box.querySelectorAll(':scope > .tool, :scope > .fold.think').length,
    };
  })()`);

  chat.open ? ok(`conversazione aperta: «${chat.title}» (${chat.sub})`) : bad('non si e\' aperta');
  chat.items > 0 ? ok(`${chat.items} blocchi a schermo`) : bad('conversazione vuota');
  info(`bolle: ${chat.me} tue · ${chat.claude} di Claude · strumenti ${chat.tools} · `
     + `ragionamenti ${chat.thinks} · codice ${chat.codes} · tabelle ${chat.tables}`);
  info(`markdown: elenchi ${chat.lists} · grassetti ${chat.bolds} · separatori di giorno ${chat.days}`);
  chat.rawJson === 0 ? ok('nessuna bolla mostra JSON grezzo') : bad(`${chat.rawJson} bolle con JSON`);
  chat.toolOneLine ? ok('gli strumenti stanno in una riga sola') : bad('strumenti troppo alti');
  chat.bodiesHidden ? ok('gli strumenti partono chiusi, non invadono') : bad('strumenti gia\' aperti');
  chat.docWide <= 402 ? ok(`niente scorrimento orizzontale (${chat.docWide}px)`) : bad(`la pagina sfonda: ${chat.docWide}px`);
  chat.overflowing === 0 ? ok('nessun testo esce dal suo riquadro') : bad(`${chat.overflowing} elementi escono`);
  info('immagine: ' + await b.shot('chat-conversazione.png'));

  // ---- 5c. il chip in cima dice modello **e** impegno
  // «Opus 4.8» da solo non dice se sta pensando o correndo, ed e' meta' della
  // risposta che stai per ricevere. Haiku l'impegno non ce l'ha: li' non si
  // scrive niente, invece di inventarlo.
  const chip = await b.evalJS(`(() => {
    const c = document.getElementById('modelBtn');
    const bar = c.parentElement;
    return {
      modello: (c.querySelector('.mc-model') || {}).textContent || '',
      impegno: (c.querySelector('.mc-effort') || {}).textContent || '',
      statoNoto: !!(S.chat && S.chat.effort),
      haiku: /haiku/i.test((S.chat && S.chat.model) || ''),
      dentro: c.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1,
      // il titolo della chat non deve sparire per far posto al chip
      titoloLargo: document.getElementById('chatTitle').clientWidth,
      aria: c.getAttribute('aria-label'),
    };
  })()`);
  chip.modello ? ok(`il chip dice il modello: «${chip.modello}»`) : bad('il chip non dice il modello');
  if (chip.haiku) {
    chip.impegno === '' ? ok('Haiku non ha impegno, e infatti il chip non ne mostra')
                        : bad('il chip mostra un impegno per Haiku: ' + chip.impegno);
  } else if (chip.statoNoto) {
    chip.impegno ? ok(`e anche l'impegno: «${chip.modello} · ${chip.impegno}»`)
                 : bad('il Mac dice l\'impegno ma il chip non lo mostra');
  } else {
    info('questa conversazione non ha un impegno registrato nell\'indice del Desktop');
  }
  chip.dentro && chip.titoloLargo > 80
    ? ok(`il chip sta dentro la barra e lascia ${chip.titoloLargo}px al titolo`)
    : bad(`il chip non ci sta: titolo ${chip.titoloLargo}px, dentro=${chip.dentro}`);

  // ---- 5d. si puo' allegare: il bottone c'e' e apre un vero campo file
  const all = await b.evalJS(`(() => {
    const b = document.getElementById('attachBtn');
    const i = document.getElementById('fileInput');
    const r = b.getBoundingClientRect();
    return { c: !!b, tipo: i && i.type, w: Math.round(r.width), h: Math.round(r.height),
             accetta: (i && i.getAttribute('accept') || '').includes('image/') };
  })()`);
  all.c && all.tipo === 'file' && all.accetta
    ? ok(`si puo' allegare: bottone ${all.w}×${all.h} su un campo file che accetta le foto`)
    : bad('manca il modo di allegare: ' + JSON.stringify(all));
  all.w >= 40 && all.h >= 40 ? ok('e il bottone e\' grande abbastanza per un pollice')
                             : bad(`bottone troppo piccolo: ${all.w}×${all.h}`);

  // ---- 5e. il tasto della voce: c'e' dove puo' funzionare, e da nessun'altra parte
  // Su `localhost` Chrome considera la pagina un contesto sicuro e sa
  // registrare in `audio/mp4`: il tasto deve esserci, fra il ＋ e il campo.
  // Dove il microfono non puo' funzionare (http sulla rete di casa) deve
  // sparire, e le Impostazioni devono dire della dettatura della tastiera.
  const voce = await b.evalJS(`(() => {
    const m = document.getElementById('micBtn');
    const r = m.getBoundingClientRect();
    const possibile = window.isSecureContext && !!navigator.mediaDevices
      && typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported('audio/mp4');
    const kids = [...document.getElementById('composer').children].filter(e => !e.classList.contains('hidden') && e.type !== 'file').map(e => e.id);
    const hint = document.getElementById('dictationHint').textContent;
    return { c: !!m, visibile: !m.classList.contains('hidden'), possibile, w: Math.round(r.width), h: Math.round(r.height),
             ordine: kids, aria: m.getAttribute('aria-label'), hint, svg: !!m.querySelector('svg') };
  })()`);
  voce.c ? ok('il tasto della voce esiste') : bad('manca il tasto della voce');
  voce.visibile === voce.possibile
    ? ok(`e si vede solo dove puo' funzionare (qui ${voce.possibile ? 'si': 'no'}: ${voce.visibile ? 'visibile' : 'nascosto'})`)
    : bad(`tasto ${voce.visibile ? 'visibile' : 'nascosto'} ma il microfono ${voce.possibile ? 'funzionerebbe' : 'non puo\' funzionare'}`);
  if (voce.visibile) {
    voce.w >= 40 && voce.h >= 40 ? ok(`grande quanto gli altri: ${voce.w}×${voce.h}`) : bad(`tasto della voce troppo piccolo: ${voce.w}×${voce.h}`);
    JSON.stringify(voce.ordine) === JSON.stringify(['attachBtn', 'micBtn', 'msg', 'sendBtn'])
      ? ok('sta fra il ＋ e il campo di scrittura') : bad('ordine della barra: ' + voce.ordine.join(' '));
    /dictat|detta/i.test(voce.aria) ? ok(`ha un nome per chi non vede: «${voce.aria}»`) : bad('aria-label del microfono: ' + voce.aria);
    voce.svg ? ok('l\'icona e\' un disegno, non un\'emoji') : bad('icona del microfono mancante');
  }
  /Dictation|Dettatura/.test(voce.hint) && (voce.possibile ? !/isn’t shown|non c’è/.test(voce.hint) : /isn’t shown|non c’è/.test(voce.hint))
    ? ok('le Impostazioni dicono la verita\' sulla dettatura per questa strada')
    : bad('riga della dettatura nelle Impostazioni: «' + voce.hint.slice(0, 80) + '»');

  // ---- 5b. F5: il lavoro consecutivo sta in una riga sola
  info(`righe di primo livello ${chat.topRows}: ${chat.groups} gruppi che ne contengono `
     + `${chat.workInside}, piu' ${chat.workOutside} righe di lavoro isolate`);
  if (chat.groups > 0) {
    ok(`${chat.groups} file di strumenti raggruppate: ${chat.workInside} righe diventano ${chat.groups}`);
    chat.groupsClosed ? ok('i gruppi partono chiusi') : bad('un gruppo e\' gia\' aperto');
    const label = await b.evalJS(`document.querySelector('.toolgroup .tool-name').textContent`);
    /^\d+ (commands|tools|comandi|strumenti)$/.test(label.trim())
      ? ok(`la riga del gruppo dice «⚙ ${label.trim()} ▾»`) : bad('etichetta del gruppo: ' + label);
    // e si apre al tocco
    await b.evalJS(`document.querySelector('.toolgroup > .tool-head').click()`);
    await sleep(400);
    const opened5 = await b.evalJS(
      `!document.querySelector('.toolgroup-body').classList.contains('hidden')`);
    opened5 ? ok('il gruppo si apre al tocco e mostra l\'elenco') : bad('il gruppo non si apre');
    info('immagine: ' + await b.shot('chat-gruppo-aperto.png'));
    await b.evalJS(`document.querySelector('.toolgroup > .tool-head').click()`);
  } else {
    info('questa conversazione non ha file di strumenti consecutivi');
  }

  // ---- 6. uno strumento si apre al tocco
  // Il selettore scende dentro `.tool`: la testa di un gruppo e' anche lei una
  // `.tool-head`, e senza questo si finirebbe per aprire il gruppo sbagliato.
  if (chat.tools > 0) {
    const SEL = `(document.querySelector('#messages > .tool') `
              + `|| document.querySelector('#messages .tool'))`;
    const before = await b.evalJS(`${SEL}.querySelector('.tool-body').classList.contains('hidden')`);
    await b.evalJS(`${SEL}.querySelector('.tool-head').click()`);
    await sleep(400);
    const after = await b.evalJS(`${SEL}.querySelector('.tool-body').classList.contains('hidden')`);
    (before && !after) ? ok('lo strumento si apre al tocco') : bad('lo strumento non si apre');
    info('immagine: ' + await b.shot('chat-strumento-aperto.png'));
    await b.evalJS(`${SEL}.querySelector('.tool-head').click()`);
  }

  // ---- 7. carica messaggi precedenti
  if (await b.evalJS(`!document.getElementById('moreWrap').classList.contains('hidden')`)) {
    const n0 = await b.evalJS(`document.getElementById('messages').children.length`);
    await b.evalJS(`document.getElementById('moreBtn').click()`);
    await sleep(2400);
    const n1 = await b.evalJS(`document.getElementById('messages').children.length`);
    n1 > n0 ? ok(`«carica precedenti» aggiunge davvero: ${n0} → ${n1} blocchi`)
            : bad(`«carica precedenti» non aggiunge nulla (${n0})`);
  } else {
    info('chat corta: niente da caricare all\'indietro');
  }

  // ---- 8. il markdown, su un testo costruito apposta
  const mdCheck = await b.evalJS(`(() => {
    const src = [
      '# Titolo', '', 'Testo con **grassetto**, *corsivo* e \\\`codice\\\`.', '',
      '| Voce | Valore |', '|---|---|', '| uno | 1 |', '| due | 2 |', '',
      '- primo', '- secondo', '', '> citazione', '',
      '\\\`\\\`\\\`bash', 'echo ciao', '\\\`\\\`\\\`', '',
      'Link: [esempio](https://example.com)',
    ].join('\\n');
    const d = document.createElement('div');
    d.className = 'bubble claude';
    d.innerHTML = md(src);
    document.getElementById('messages').appendChild(d);
    const a = d.querySelector('a');
    return {
      h1: d.querySelectorAll('h1').length, b: d.querySelectorAll('b').length,
      i: d.querySelectorAll('i').length, table: d.querySelectorAll('table').length,
      rows: d.querySelectorAll('tbody tr').length, li: d.querySelectorAll('li').length,
      quote: d.querySelectorAll('blockquote').length, pre: d.querySelectorAll('pre').length,
      copy: d.querySelectorAll('.copy').length,
      lang: (d.querySelector('.code-lang') || {}).textContent,
      link: a ? a.getAttribute('href') : null,
      scrollableTable: (() => { const w = d.querySelector('.tablewrap');
        return w ? getComputedStyle(w).overflowX : ''; })(),
      leftovers: /\\u0001/.test(d.textContent),
    };
  })()`);
  const mdOK = mdCheck.h1 === 1 && mdCheck.b >= 1 && mdCheck.i >= 1 && mdCheck.table === 1
    && mdCheck.rows === 2 && mdCheck.li === 2 && mdCheck.quote === 1 && mdCheck.pre === 1
    && mdCheck.copy === 1 && mdCheck.link === 'https://example.com' && !mdCheck.leftovers;
  mdOK ? ok('markdown reso: titoli, grassetto, corsivo, tabella, elenco, citazione, codice, link')
       : bad('markdown incompleto: ' + JSON.stringify(mdCheck));
  mdCheck.scrollableTable === 'auto'
    ? ok('le tabelle scorrono dentro il loro riquadro')
    : bad('tabella non scorrevole: ' + mdCheck.scrollableTable);
  if (mdCheck.lang) info('il blocco di codice mostra il linguaggio: ' + mdCheck.lang);
  info('immagine: ' + await b.shot('chat-markdown.png'));
  await b.evalJS(`document.getElementById('messages').lastChild.remove()`);

  // ---- 10. si torna all'elenco
  await b.evalJS(`document.getElementById('backBtn').click()`);
  await sleep(900);
  (await b.evalJS(`!document.getElementById('list').classList.contains('hidden')`))
    ? ok('il tasto indietro riporta all\'elenco') : bad('non si torna all\'elenco');

  // ---- 10b. rientrare nella stessa chat non la riscarica
  // Le ultime tre conversazioni restano in memoria: al ritorno si ridisegna
  // da li' e al Mac si chiede solo la coda (`openChat` con `end`). Quattro
  // rientri costavano 147 KB dove ne bastavano 37 (misurato il 04/09/2026).
  const reqChat = () => b.evalJS(
    `performance.getEntriesByType('resource').filter(e => /\\/api\\/chat\\//.test(e.name) && !/image/.test(e.name)).length`);
  const c0 = await reqChat();
  await b.evalJS(`(() => { const row = document.querySelector('.chatrow:not(.closed)'); if (row) row.click(); })()`);
  await sleep(1500);
  const again = await b.evalJS(`({ open: !document.getElementById('chat').classList.contains('hidden'),
                                   items: document.getElementById('messages').children.length })`);
  const c1 = await reqChat();
  again.open && again.items > 0 && c1 === c0
    ? ok(`rientrando nella stessa chat non si riscarica niente: ${again.items} blocchi dalla memoria, zero richieste`)
    : bad(`rientro nella chat: ${c1 - c0} richieste, ${again.items} blocchi`);
  await b.evalJS(`document.getElementById('backBtn').click()`);
  await sleep(600);

  // ---- 11. errori
  await sleep(600);
  b.exceptions.length === 0 ? ok('zero eccezioni JavaScript') : bad(b.exceptions.length + ' eccezioni');
  b.exceptions.slice(0, 5).forEach(e => info(String(e).slice(0, 200)));
  const realErrors = b.consoleErrors.filter(e => !/favicon|manifest|icon-/.test(e));
  realErrors.length === 0 ? ok('zero errori in console') : bad(realErrors.length + ' errori in console');
  realErrors.slice(0, 8).forEach(e => info(e.slice(0, 200)));

  // ---- 12. il finto dispositivo di questa prova lascia il posto
  // Ogni giro ne accoppiava uno nuovo e lo lasciava nell'elenco del pannello,
  // per un browser che non esiste più. Si scollega **solo** sé stesso.
  const gone = await b.evalJS(`(async () => {
    const r = await Net.fetch('/api/forget', {
      method: 'POST', headers: { Authorization: 'Bearer ' + Net.token } });
    return r.status;
  })()`).catch(e => 'errore: ' + e.message);
  gone === 200 ? ok('il dispositivo di prova si scollega da solo a fine giro')
               : bad('il dispositivo di prova resta accoppiato · ' + gone);

  await b.kill();
  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nel collaudo:', e); process.exit(2); });
