'use strict';

/* ------------------------------------------------------------------
   Riflesso — client. Nessuna dipendenza, nessun passo di build.

   Due schermate contano: l'elenco delle chat e la conversazione.
   Lo specchio dello schermo resta, ma dietro un pulsante: serve per
   i prompt di permesso e le finestre di dialogo, non per leggere.
------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const S = {
  // Il gettone lo tiene il trasporto (`net.js`): lo legge dal suo cassetto e
  // ce lo rimette.
  get token() { return Net.token; },
  set token(v) { v ? Net.setToken(v) : Net.forgetToken(); },
  ws: null,
  connected: false,
  everConnected: false,
  retry: 0,
  screen: 'pair',
  pairing: false,
  // conversazione aperta
  chat: null,            // { id, title, project, model, first, end, more }
  sending: false,
  live: {},              // blocchi in arrivo, per indice
  liveOrder: [],
  pendingEcho: [],       // messaggi appena inviati, in attesa della copia vera
  chats: [],
  // «chat» sono le sue conversazioni, «routine» quelle aperte dalle attività
  // programmate: 293 su 305. Di suo si vedono solo le prime.
  listKind: 'chat',
  counts: { chats: 0, routines: 0 },
  searchTimer: 0,
  listTimer: 0,
  threadItems: [],
  // I gruppi come li tiene il Mac: nome, ordine, e chi sta dentro.
  // Vuoto = nessun gruppo, e l'elenco resta piatto com'era.
  groups: [],
  closedGroups: {},
  // L'allegato scelto e non ancora partito: { file, url, id, name, size }
  pending: null,
};

/* ================= accoppiamento =================

   Una schermata sola, e non le importa dove sei. L'indirizzo è uno e il codice
   è uno: dalla rete di casa la richiesta va dritta al Mac, dal ponte passa
   dentro il canale diretto aperto sulla stanza del codice. Da qui la
   differenza non si vede — ma **si legge**: sotto il codice c'è scritta la
   strada. Vedi `Net.pair` in net.js.                                        */

// Deve combaciare con `AuthStore.pinDigits` (Swift). Otto e non sei perché il
// codice apre anche una porta su un indirizzo pubblico, quando c'è il ponte.
const PIN_DIGITS = 8;
const t = (k, v) => I18n.t(k, v);

function noticeText(m) {
  if (!m) return '';
  if (m.code) return I18n.notice(m.code, m);
  if (m.error && !m.text) return I18n.notice(m.error, m) || m.error;
  return m.text || '';
}

function httpError(data, fallbackKey) {
  if (data && data.code) return I18n.notice(data.code, data);
  if (data && data.error) {
    const mapped = I18n.notice(data.error, data);
    if (mapped && mapped !== data.error) return mapped;
    return data.error;
  }
  return t(fallbackKey || 'pair.rejected');
}

async function pair() {
  if (S.pairing) return;
  const code = $('pinInput').value.replace(/\D/g, '');
  if (code.length !== PIN_DIGITS) {
    $('pairError').textContent = t('pair.need_digits', { n: PIN_DIGITS });
    return;
  }
  S.pairing = true;
  $('pairBtn').disabled = true;
  $('pairBtn').textContent = t('pair.connecting');
  // Dal ponte l'appuntamento può prendersi qualche secondo: dire cosa sta
  // succedendo è meglio di un pulsante che non fa niente.
  $('pairError').textContent = Net.remote ? t('net.looking') : '';
  try {
    const data = await Net.pair(code, deviceLabel(), deviceId());
    if (data && data.ok && data.token) {
      S.token = data.token;
      // Il segreto della stanza sul ponte: da qui il telefono ricava la
      // stanza in cui il Mac lo aspetta.
      if (data.meet) Net.setMeet(data.meet);
      $('pinInput').value = '';
      $('pairError').textContent = '';
      start();
      return;
    }
    $('pairError').textContent = httpError(data, 'pair.rejected');
    $('pinInput').value = '';
  } catch (e) {
    // `Net.explain` dice **perché**, e cambia con la strada: in casa il Mac
    // non risponde sulla rete di casa, dal ponte è il ponte che non risponde
    // o il Mac non si presenta.
    $('pairError').textContent = Net.explain(e);
    $('pinInput').value = '';
  } finally {
    S.pairing = false;
    $('pairBtn').disabled = false;
    $('pairBtn').textContent = t('pair.button');
  }
}

// Lo stesso telefono deve restare **uno** sul Mac. Senza un'identita' stabile,
// ogni riaccoppiamento nasceva come dispositivo nuovo e il pannello finiva per
// contarne quattro quando l'iPhone era sempre quello. Sta nel browser, non dice
// niente di chi lo usa, e se il telefono dimentica tutto se ne fa una nuova.
function deviceId() {
  const K = 'riflesso.deviceId';
  let v = '';
  try { v = localStorage.getItem(K) || ''; } catch (_) { v = ''; }
  if (!/^[0-9a-f]{32}$/.test(v)) {
    const raw = new Uint8Array(16);
    crypto.getRandomValues(raw);
    v = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(K, v); } catch (_) {}
  }
  return v;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Browser';
}

$('pairBtn').addEventListener('click', pair);
$('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
$('pinInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, PIN_DIGITS);
  // Quante cifre mancano, senza contarle: la barra in fondo al campo è il
  // fondo del campo stesso (`.pin` in `style.css`), non un elemento in piu'.
  e.target.style.setProperty('--riempi', e.target.value.length / PIN_DIGITS);
  if (e.target.value.length === PIN_DIGITS) pair();
});

/* ================= schermate ================= */

const SCREENS = ['pair', 'list', 'chat'];

function showScreen(name) {
  S.screen = name;
  SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== name));
}

function start() {
  showScreen('list');
  connect();
  loadChats();
  loadStatus();
  openFromHash();
}

/* Collegamento diretto a una conversazione: #chat=<id>. Comodo per tenersi un
   segnalibro. Va ascoltato anche il cambio di ancora: cambiare solo il pezzo
   dopo il cancelletto non ricarica la pagina. */
function openFromHash() {
  const id = (location.hash.match(/chat=([0-9a-fA-F-]{8,})/) || [])[1];
  if (id && (!S.chat || S.chat.id !== id)) openChat(id, '');
}
window.addEventListener('hashchange', openFromHash);

/* ================= WebSocket ================= */

function connect() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  // Senza gettone non c'è niente da aprire: succede quando si è appena
  // tornati alla schermata del codice (vedi `bridgeFailed`), e il giro dei
  // tentativi non deve continuare a bussare col gettone di prima.
  if (!S.token) return;

  S.ws = Net.socket({
    onopen: () => {
      S.connected = true;
      S.retry = 0;
      setStatus(true, whereText());
      if (S.chat) send({ t: 'openChat', id: S.chat.id, end: S.chat.end });
      send({ t: 'ping', ts: Date.now() });
      // L'elenco arriva in spinta (`chatsChanged`), quindi una diretta caduta
      // e riaperta può aver perso un evento: alla riapertura si richiede.
      if (S.wasOpen && S.screen === 'list') loadChats();
      S.wasOpen = true;
    },
    onmessage: (data) => {
      if (typeof data === 'string') { onControl(JSON.parse(data)); return; }
      // Dallo specchio in poi non arrivano piu' dati binari: si ignorano.
    },
    onclose: (code) => {
      S.connected = false;
      setStatus(false, statusLine(Net.remote ? (Net.detailLabel() || t('status.disconnected')) : t('status.disconnected')));
      if (code === 1008 || (code === 1006 && S.retry === 0 && !S.everConnected)) checkToken();
      S.retry = Math.min(S.retry + 1, 10);
      // Dal ponte un nuovo tentativo rifà tutto l'appuntamento: si aspetta un
      // po' di più prima di ricominciare, invece di martellare.
      const base = Net.remote ? 1500 : 400;
      setTimeout(connect, Math.min(base * S.retry, Net.remote ? 15000 : 3000));
    },
    onerror: () => setStatus(false, statusLine(t('status.net_error'))),
  });
}

/** Lo stato, sempre con la strada accanto: «collegato · rete di casa · host». */
function statusLine(base) {
  return base + ' · ' + Net.roadLabel();
}

/** Collegato, e da dove: la strada detta in due parole. */
function whereText() {
  return statusLine(t('status.connected'));
}

async function checkToken() {
  try {
    const res = await Net.fetch('/api/status', { headers: { Authorization: 'Bearer ' + S.token } });
    if (res.status === 401) {
      Net.forgetToken();
      showScreen('pair');
      $('pairError').textContent = t('n.pin_forgotten');
    }
  } catch (e) { /* host spento: si riprova da soli */ }
}

function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

function onControl(m) {
  switch (m.t) {
    case 'pong':
      return;
    case 'info':
      S.everConnected = true;
      updateDiag(m);
      return;

    /* --- la conversazione dal vivo --- */
    case 'chatStart':      onChatStart(m); return;
    case 'chatReady':      onChatReady(m); return;
    case 'chatModel':      if (S.chat && m.chat === S.chat.id) setChatSub(m.model); return;
    case 'chatTextStart':  liveBlock(m.i, 'text'); return;
    case 'chatDelta':      liveAppend(m, 'text'); return;
    case 'chatThinking':   liveBlock(m.i, 'think'); return;
    case 'chatThinkDelta': liveAppend(m, 'think'); return;
    case 'chatTool':       liveBlock(m.i, 'tool', m.name); return;
    case 'chatToolReady':  liveToolBrief(m); return;
    case 'chatToolDone':   return;
    case 'chatBlockEnd':   return;
    case 'chatQueued':     note(noticeText(m), false, { code: m.code, data: m }); return;
    case 'chatNote':       note(noticeText(m), false, { code: m.code, data: m }); return;
    case 'chatDone':       onChatDone(m); return;
    case 'chatAppend':     onChatAppend(m); return;
    case 'chatWorking':    onChatWorking(m); return;
    // Il transcript ha cambiato file o è stato accorciato: gli offset in
    // memoria non valgono più, e la copia in memoria nemmeno. Si riscarica
    // per davvero (`fresh`), altrimenti si rientrerebbe dalla copia con gli
    // offset vecchi e il Mac risponderebbe di nuovo `chatReload`: un giro
    // senza fine.
    case 'chatReload':     if (S.chat && m.chat === S.chat.id) openChat(S.chat.id, S.chat.title, true); return;
    // L'elenco è cambiato sul Mac: si richiede solo adesso, e solo la metà
    // che si sta guardando. È quello che faceva il timer ogni sei secondi,
    // senza sapere se c'era qualcosa di nuovo.
    case 'chatsChanged':   if (S.screen === 'list' && (m.kind || 'chat') === S.listKind) scheduleListReload(); return;
  }
}

/* Più eventi ravvicinati (una risposta che arriva pezzo a pezzo tocca
   l'elenco a ogni pezzo) diventano una richiesta sola. */
function scheduleListReload() {
  clearTimeout(S.listTimer);
  S.listTimer = setTimeout(loadChats, 300);
}

/* ================= elenco chat ================= */

async function api(path) {
  try {
    const res = await Net.fetch(path, { headers: { Authorization: 'Bearer ' + S.token } });
    if (res.status === 401) { checkToken(); return null; }
    return res.json();
  } catch (e) {
    // Dal ponte una richiesta può cadere col collegamento: si dice, non si
    // resta a girare. In casa e in diretta la WebSocket se ne accorge da sola
    // e lo scrive nella riga di stato.
    if (Net.remote) setStatus(false, statusLine(Net.detailLabel() || t('status.dropped')));
    return null;
  }
}

async function loadChats() {
  const q = $('chatSearch').value.trim();
  const kind = S.listKind === 'routine' ? '&kind=routine' : '';
  const data = await api('/api/chats?q=' + encodeURIComponent(q) + kind);
  if (!data || !data.ok) return;
  // Una risposta in ritardo di un elenco che non si guarda più non deve
  // sostituire quello che si ha davanti.
  if ((data.kind || 'chat') !== S.listKind) return;
  S.chats = data.items || [];
  S.groups = Array.isArray(data.groups) ? data.groups : [];
  S.counts = { chats: data.chats || 0, routines: data.routines || 0 };
  S.listReady = data.ready !== false;
  renderChats();
  updateRoutinesBtn();
  if (data.cli === false) {
    $('cliWarn').innerHTML = t('settings.cli');
    $('cliWarn').classList.remove('hidden');
  }
  // Appena avviato l'host sta ancora leggendo i file: si richiede una volta.
  if (data.ready === false) setTimeout(loadChats, 1000);
}

/* L'elenco delle routine è una seconda pagina, non un filtro: si arriva dal
   menu e si torna indietro con la freccia. */
function setListKind(kind) {
  if (S.listKind === kind) return;
  S.listKind = kind;
  S.chats = [];
  S.listReady = false;
  $('chatSearch').value = '';
  $('listName').textContent = kind === 'routine' ? t('list.routines') : t('list.chats');
  $('chatSearch').placeholder = kind === 'routine'
    ? t('list.search_routines') : t('list.search_chats');
  $('listBack').classList.toggle('hidden', kind !== 'routine');
  renderChats();
  loadChats();
}

function updateRoutinesBtn() {
  const b = $('routinesBtn');
  if (!b) return;
  const n = S.listKind === 'routine' ? S.counts.chats : S.counts.routines;
  b.textContent = (S.listKind === 'routine' ? t('settings.back_chats') : t('settings.routines'))
    + ' (' + n + ')';
}

$('routinesBtn').addEventListener('click', () => {
  setListKind(S.listKind === 'routine' ? 'chat' : 'routine');
  closeSheets();
});
$('listBack').addEventListener('click', () => setListKind('chat'));

function countLabel(kind, n) {
  if (kind === 'routine') return n === 1 ? t('list.one_routine') : t('list.n_routines', { n });
  return n === 1 ? t('list.one_chat') : t('list.n_chats', { n });
}

/* `dentroFissate` decide **solo** se disegnare la stella.

   Nella sezione «Fissato» la stella è ridondante per costruzione: otto
   righe su tredici ce l'hanno, e stanno tutte dentro l'intestazione che
   dice già «Fissato». Otto stelle arancioni per ripetere il nome della
   sezione — e sono anche la cosa che stringe davvero i titoli, molto più
   del quadrato. Fuori da lì la stella serve, perché lì dice qualcosa che
   nessun'altra cosa dice.

   In CSS puro non si poteva: l'intestazione e le righe sono fratelli nel
   DOM, e `~` avrebbe preso anche le sezioni successive. */
function chatRowHTML(c, i, dentroFissate) {
  return `
    <button class="chatrow${c.open ? '' : ' closed'}" data-i="${i}">
      <div class="avatar" data-m="${escapeHTML(c.model)}">${escapeHTML(initials(c.title))}</div>
      <div class="chatrow-main">
        <div class="chatrow-top">
          ${c.star && !dentroFissate ? '<span class="star">★</span>' : ''}
          <span class="chatrow-title">${escapeHTML(c.title)}</span>
          <span class="chatrow-when">${escapeHTML(whenLabel(c.at))}</span>
        </div>
        <div class="chatrow-bottom">
          <span class="chatrow-prev">${c.active ? '<span class="livedot"></span>' : ''}${c.who === 'me' ? '<span class="you">' + escapeHTML(t('list.you')) + '</span>' : ''}${escapeHTML(rowPreview(c))}</span>
          ${c.turns ? `<span class="chatrow-turns">${c.turns}</span>` : ''}
        </div>
      </div>
    </button>`;
}

/* Le sezioni dell'elenco, esattamente come sul Mac.

   Sul Mac l'ordine e' questo, e non e' negoziabile:

     1. **Fissato**   — le conversazioni con la stella, tutte insieme in cima,
                        fuori dai gruppi anche quando un gruppo ce l'hanno;
     2. **i gruppi**  — nell'ordine del Desktop, senza le fissate;
     3. **Non raggruppato** — quello che resta.

   Prima le fissate finivano dentro il loro gruppo, e chi guardava vedeva
   un gruppo con dentro mezza roba che con quel gruppo non c'entrava.

   Se il Mac non manda gruppi (file assente, forma diversa, versione nuova del
   Desktop) `S.groups` e' vuoto: si torna all'elenco piatto di prima, senza
   intestazioni, e nessuno se ne accorge. */
function listSections() {
  const groups = S.listKind === 'chat' ? S.groups : [];
  const flat = () => [{ group: null, items: S.chats.map((c, i) => [c, i]) }];
  if (!groups.length) return flat();

  const pinned = [];
  const byId = new Map(groups.map(g => [g.id, []]));
  const loose = [];

  S.chats.forEach((c, i) => {
    // `pin` e' la posizione fra le fissate del Desktop; -1 vuol dire «non
    // fissata». La stella da sola non basta: serve anche l'ordine.
    if (typeof c.pin === 'number' && c.pin >= 0) { pinned.push([c, i]); return; }
    const bucket = c.group && byId.get(c.group);
    (bucket || loose).push([c, i]);
  });

  // L'ordine delle fissate lo decide il Desktop, non l'ultima attivita'.
  pinned.sort((a, b) => (a[0].pin - b[0].pin));

  const out = [];
  if (pinned.length) out.push({ group: { id: '@pin', name: t('list.pinned') }, items: pinned });
  // Un gruppo vuoto non si mostra: durante una ricerca sarebbe
  // un'intestazione che non apre niente.
  for (const g of groups) {
    const items = byId.get(g.id);
    if (items.length) out.push({ group: g, items });
  }
  // «Non raggruppato» ha un nome solo quando c'e' qualcosa sopra di lui: se
  // fosse l'unica sezione, sarebbe un'etichetta che non divide niente.
  if (loose.length) {
    out.push({ group: out.length ? { id: '@loose', name: t('list.ungrouped') } : null, items: loose });
  }
  return out.length ? out : flat();
}

function renderChats() {
  const list = $('chatList');
  $('listCount').textContent = S.chats.length ? countLabel(S.listKind, S.chats.length) : '';
  if (!S.chats.length) {
    // Appena acceso, l'host legge 600 file di sessione: ci mette qualche
    // secondo. Dire «nessuna conversazione» in quel momento sarebbe falso.
    list.innerHTML = S.listReady
      ? `<p class="empty">${escapeHTML(S.listKind === 'routine' ? t('list.empty_routine') : t('list.empty_chat'))}</p>`
      : `<p class="empty">${escapeHTML(t('list.loading'))}</p>`;
    return;
  }
  list.innerHTML = listSections().map(sec => {
    const fissate = !!(sec.group && sec.group.id === '@pin');
    const rows = sec.items.map(([c, i]) => chatRowHTML(c, i, fissate)).join('');
    if (!sec.group) return rows;
    const closed = !!S.closedGroups[sec.group.id];
    return `<button class="groupsep${closed ? ' closed' : ''}" data-g="${escapeHTML(sec.group.id)}">
        ${sec.group.star ? '<span class="star">★</span>' : ''}
        <span class="groupsep-name">${escapeHTML(sec.group.name)}</span>
        <span class="groupsep-n">${sec.items.length}</span>
        <span class="groupsep-caret">▾</span>
      </button>${closed ? '' : rows}`;
  }).join('');

  list.querySelectorAll('.chatrow').forEach(el => {
    el.addEventListener('click', () => {
      const c = S.chats[Number(el.dataset.i)];
      openChat(c.id, c.title);
    });
  });
  list.querySelectorAll('.groupsep').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.g;
      S.closedGroups[id] = !S.closedGroups[id];
      try { localStorage.setItem('riflesso.gruppichiusi', JSON.stringify(S.closedGroups)); } catch (e) {}
      renderChats();
    });
  });
}

function rowPreview(c) {
  if (c.previewCode) return I18n.notice(c.previewCode, c);
  if (c.preview) return c.preview;
  return c.open ? '—' : t('list.no_transcript');
}

function initials(t) {
  const words = String(t || '?').trim().split(/\s+/).slice(0, 2);
  return words.map(w => w[0] || '').join('').toUpperCase() || '?';
}

$('chatSearch').addEventListener('input', () => {
  clearTimeout(S.searchTimer);
  S.searchTimer = setTimeout(loadChats, 180);
});

$('settingsBtn').addEventListener('click', () => openSheet($('settingsSheet')));

/* ================= la conversazione =================

   **Rientrare in una chat non la riscarica.** Le ultime tre restano in
   memoria com'erano quando le si è lasciate (blocchi, offset, titolo): al
   ritorno si ridisegnano da lì, e al Mac si chiede solo la coda — è il
   meccanismo che c'è già: `openChat` manda `end`, il sorvegliante risponde
   con `chatAppend` per quello che è arrivato dopo. Misurato il 04/09/2026:
   quattro rientri nella stessa chat costavano 147 KB dove ne bastavano 37.

   Dopo dieci minuti la copia si butta: l'impegno e il modello si leggono dal
   Mac all'apertura, e una copia troppo vecchia li direbbe sbagliati. */

const CHAT_CACHE_MAX = 3;
const CHAT_CACHE_TTL = 10 * 60 * 1000;

function rememberChat() {
  if (!S.chat || !S.threadItems || !S.threadItems.length) return;
  S.chatCache = (S.chatCache || []).filter(c => c.chat.id !== S.chat.id);
  S.chatCache.push({ chat: S.chat, items: S.threadItems, at: Date.now() });
  while (S.chatCache.length > CHAT_CACHE_MAX) S.chatCache.shift();
}

function recallChat(id) {
  const c = (S.chatCache || []).find(x => x.chat.id === id);
  if (!c) return null;
  if (Date.now() - c.at > CHAT_CACHE_TTL) {
    S.chatCache = S.chatCache.filter(x => x !== c);
    return null;
  }
  return c;
}

function forgetChat(id) {
  S.chatCache = (S.chatCache || []).filter(x => x.chat.id !== id);
}

async function openChat(id, title, fresh) {
  // Quello che si sta lasciando resta in memoria per il ritorno.
  if (S.chat && S.chat.id !== id) rememberChat();
  $('chatTitle').textContent = title || t('chat.conversation');
  $('chatSub').textContent = t('chat.opening');
  $('messages').innerHTML = '';
  $('live').innerHTML = '';
  $('moreWrap').classList.add('hidden');
  // Un allegato scelto per un'altra conversazione non viene dietro.
  if (!S.chat || S.chat.id !== id) forgetPending();
  hideNote();
  showScreen('chat');

  if (fresh) forgetChat(id);
  const kept = recallChat(id);
  if (kept) {
    S.chat = kept.chat;
    $('composer').classList.remove('hidden');
    $('chatTitle').textContent = kept.chat.title || title || t('chat.conversation');
    setChatSub(kept.chat.model);
    $('messages').dataset.lastDay = '';
    renderItems(kept.items, 'replace');
    $('moreWrap').classList.toggle('hidden', !kept.chat.more);
    // Al Mac si chiede solo quello che è arrivato dopo `end`.
    send({ t: 'openChat', id, end: kept.chat.end });
    scrollToBottom(true);
    return;
  }

  const data = await api('/api/chat/' + encodeURIComponent(id));
  if (!data) return;
  if (!data.ok) {
    $('chatSub').textContent = '';
    $('messages').innerHTML = `<p class="empty">${escapeHTML(httpError(data, 'chat.cant_open'))}</p>`;
    $('composer').classList.add('hidden');
    return;
  }
  $('composer').classList.remove('hidden');
  // `effort` l'host lo manda da sempre in questa risposta; è che nessuno lo
  // teneva, e il chip in cima diceva solo il modello.
  S.chat = { id, title: data.title, project: data.project, model: data.model,
             effort: data.effort || '',
             first: data.first, end: data.end, more: data.more };
  $('chatTitle').textContent = data.title || title || t('chat.conversation');
  setChatSub(data.model);
  renderItems(data.items, 'replace');
  $('moreWrap').classList.toggle('hidden', !data.more);
  send({ t: 'openChat', id, end: data.end });
  scrollToBottom(true);
  // Se il Mac ce l'ha in mano adesso, meglio dirlo prima di scrivere che dopo
  // aver premuto invio.
  if (data.live) note(t('n.live_locked'), false, { key: 'n.live_locked' });
}

// «1m 12s · 3,4k token · ⚙ Bash» — la stessa informazione che da' il Mac.
function onChatWorking(m) {
  if (!S.chat || m.chat !== S.chat.id) return;
  S.lastWorking = m;
  const bar = $('working');
  if (!m.active) { bar.classList.add('hidden'); return; }
  const mins = Math.floor((m.secs || 0) / 60), secs = (m.secs || 0) % 60;
  const clock = mins ? mins + 'm ' + secs + 's' : secs + 's';
  const tok = (m.tokens || 0) >= 1000
    ? (m.tokens / 1000).toFixed(1) + 'k'
    : String(m.tokens || 0);
  let txt = t('chat.working') + ' \u00b7 ' + clock + ' \u00b7 ' + tok + ' ' + t('chat.tokens');
  if (m.tool) {
    txt += ' \u00b7 \u2699 ' + m.tool;
    if (m.tools > 1) txt += ' +' + (m.tools - 1);
  }
  $('workingText').textContent = txt;
  bar.classList.remove('hidden');
}

/* L'etichetta dell'impegno di questa chat, o '' se non ce n'\u00e8 una da dire.
   Haiku il cursore non ce l'ha: mostrarlo sarebbe inventarsi un dato. */
function effortLabel(model) {
  if (/haiku/i.test(model || '')) return '';
  const stato = String((S.chat && S.chat.effort) || '').toLowerCase();
  const e = IMPEGNI.find(x => x.stato === stato);
  return e ? t(e.nome) : '';
}

function setChatSub(model) {
  /* Il modello era scritto **due volte nella stessa barra**, a quaranta
     pixel di distanza: \u00abcode \u00b7 Opus 5\u00bb a sinistra e \u00abOpus 5 \u00b7 Max \u2304\u00bb nel
     chip a destra. Il sottotitolo dice il progetto \u2014 che il chip non dice \u2014
     e ripiega sul modello solo quando il progetto non c'\u00e8: una barra che
     cambia altezza fra una chat e l'altra \u00e8 peggio della ripetizione. */
  const bits = [];
  if (S.chat && S.chat.project) bits.push(S.chat.project);
  else if (model) bits.push(model);
  $('chatSub').textContent = bits.join(' \u00b7 ');
  // Il modello e' anche un pulsante vero nella barra: il sottotitolo
  // sottolineato da solo non si vedeva. E dice **anche l'impegno**, che \u00e8
  // met\u00e0 della risposta che stai per ricevere.
  //
  // Le due parti sono due elementi, non una stringa sola, perch\u00e9 quando lo
  // schermo \u00e8 stretto a stringersi dev'essere il nome del modello: \u00abOpus\u00bb
  // tagliato si legge lo stesso, \u00abUltracod\u2026\u00bb no.
  const impegno = effortLabel(model);
  const chip = $('modelBtn');
  chip.innerHTML =
    `<span class="mc-model">${escapeHTML(model || t('chat.model'))}</span>`
    + (impegno ? `<span class="mc-sep">\u00b7</span><span class="mc-effort">${escapeHTML(impegno)}</span>` : '')
    + `<span class="mc-caret">\u25be</span>`;
  chip.setAttribute('aria-label', impegno
    ? t('aria.model_effort', { model: model || t('chat.model'), effort: impegno })
    : t('aria.model'));
}

$('backBtn').addEventListener('click', () => {
  $('working').classList.add('hidden');
  if (S.chat) send({ t: 'closeChat', id: S.chat.id });
  // Registrazione a metà: si butta, l'audio non ha più una chat.
  if (S.voce) stopVoice();
  rememberChat();
  S.chat = null;
  showScreen('list');
  loadChats();
});

// I modelli scegliibili dal telefono. Stessa lista che l'host accetta:
// se qui comparisse qualcosa di diverso, l'host lo rifiuterebbe.
// In ordine di capacita', dal piu' capace al piu' veloce.
const MODELLI = [
  { id: 'claude-fable-5',            nome: 'Fable 5',   nota: 'model.note.fable' },
  { id: 'claude-opus-5',             nome: 'Opus 5',    nota: 'model.note.opus' },
  { id: 'claude-sonnet-5',           nome: 'Sonnet 5',  nota: 'model.note.sonnet' },
  { id: 'claude-opus-4-8',           nome: 'Opus 4.8',  nota: 'model.note.opus48' },
  { id: 'claude-haiku-4-5-20251001', nome: 'Haiku 4.5', nota: 'model.note.haiku' },
];

// Le sei posizioni del cursore dell'impegno dentro Claude, in ordine.
// I nomi sono quelli che mostra il Mac; `stato` e' come lo scrive l'indice.
const IMPEGNI = [
  { liv: 0, nome: 'effort.low',       stato: 'low' },
  { liv: 1, nome: 'effort.medium',    stato: 'medium' },
  { liv: 2, nome: 'effort.high',      stato: 'high' },
  { liv: 3, nome: 'effort.extra',     stato: 'xhigh' },
  { liv: 4, nome: 'effort.max',       stato: 'max' },
  { liv: 5, nome: 'effort.ultracode', stato: 'ultracode' },
];

function apriFoglioImpegno() {
  const attuale = (S.chat && S.chat.effort || '').toLowerCase();
  const box = $('effortList');
  box.innerHTML = '';
  // Haiku non ha il cursore dell'impegno: offrirlo sarebbe una bugia.
  const haiku = /haiku/i.test((S.chat && S.chat.model) || '');
  box.classList.toggle('hidden', haiku);
  document.querySelector('.sheet-sub').classList.toggle('hidden', haiku);
  if (haiku) return;
  IMPEGNI.forEach((e) => {
    const corrente = attuale === e.stato;
    const b = document.createElement('button');
    b.className = 'modelrow';
    b.type = 'button';
    if (corrente) b.setAttribute('aria-current', 'true');
    b.innerHTML = '<span>' + t(e.nome) + '</span>' + (corrente ? '<span class="tick">\u2713</span>' : '');
    b.addEventListener('click', () => {
      if (corrente) { closeSheets(); return; }
      send({ t: 'setEffort', id: S.chat.id, level: e.liv });
      note(t('effort.moving', { name: t(e.nome) }), false, { key: 'effort.moving', vars: { name: t(e.nome) } });
      // Si mostra subito il nuovo impegno — l'attesa si sente meno se si vede
      // cambiare — ma si tiene da parte il vecchio: il Mac può rifiutare
      // (chat sbagliata davanti, cursore che non si muove) e in quel caso il
      // chip deve tornare a dire la verità, non quello che speravamo.
      S.effortWas = S.chat.effort || '';
      S.chat.effort = e.stato;
      setChatSub(S.chat.model);
      closeSheets();
    });
    box.appendChild(b);
  });
}

function apriFoglioModello() {
  if (!S.chat) return;
  const attuale = (S.chat.model || '').toLowerCase();
  const box = $('modelList');
  box.innerHTML = '';
  MODELLI.forEach((m) => {
    const corrente = attuale && m.nome.toLowerCase() === attuale;
    const b = document.createElement('button');
    b.className = 'modelrow';
    b.type = 'button';
    if (corrente) b.setAttribute('aria-current', 'true');
    b.innerHTML = '<span>' + m.nome + ' <span class="dim">\u00b7 ' + t(m.nota) + '</span></span>'
                + (corrente ? '<span class="tick">\u2713</span>' : '');
    b.addEventListener('click', () => {
      if (corrente) { closeSheets(); return; }
      send({ t: 'setModel', id: S.chat.id, model: m.id });
      note(t('model.switching', { name: m.nome }), false, { key: 'model.switching', vars: { name: m.nome } });
      setChatSub(m.nome);
      S.chat.model = m.nome;
      closeSheets();
    });
    box.appendChild(b);
  });
  apriFoglioImpegno();
  $('effortNote').textContent = /haiku/i.test((S.chat && S.chat.model) || '')
    ? t('effort.haiku')
    : t('effort.help');
  openSheet($('modelSheet'));
}

$('chatSub').addEventListener('click', apriFoglioModello);
$('modelBtn').addEventListener('click', apriFoglioModello);

$('moreBtn').addEventListener('click', async () => {
  if (!S.chat) return;
  const btn = $('moreBtn');
  btn.disabled = true; btn.textContent = t('chat.loading');
  const data = await api('/api/chat/' + encodeURIComponent(S.chat.id) + '?before=' + S.chat.first + '&n=40');
  btn.disabled = false; btn.textContent = t('chat.load_more');
  if (!data || !data.ok) return;
  const thread = $('thread');
  const before = thread.scrollHeight;
  renderItems(data.items, 'prepend');
  S.chat.first = data.first;
  S.chat.more = data.more;
  $('moreWrap').classList.toggle('hidden', !data.more);
  // Si resta con gli occhi dov'erano, non si salta in cima.
  thread.scrollTop += thread.scrollHeight - before;
});

/* ---- disegno dei blocchi ---- */

function renderItems(items, mode) {
  const allIn = items || [];
  if (mode === 'replace') S.threadItems = allIn.slice();
  else if (mode === 'prepend') S.threadItems = allIn.concat(S.threadItems || []);
  else S.threadItems = (S.threadItems || []).concat(allIn);
  const box = $('messages');
  const frag = document.createDocumentFragment();
  let lastDay = mode === 'prepend' ? null : box.dataset.lastDay || null;
  if (mode === 'prepend') lastDay = null;

  const all = items || [];
  for (let i = 0; i < all.length; i++) {
    const it = all[i];
    const day = dayKey(it.t);
    if (day && day !== lastDay) {
      frag.appendChild(el('div', 'daysep', dayLabel(it.t)));
      lastDay = day;
    }
    // Anche a una riga per volta, il lavoro in mezzo domina la lettura: in
    // una schermata vera erano 12 righe su 16. Strumenti e ragionamenti
    // consecutivi diventano una riga sola, che si apre al tocco. Quello che
    // resta a schermo sono le domande e le risposte.
    if (WORK.has(it.k)) {
      let j = i + 1;
      while (j < all.length && WORK.has(all[j].k) && dayKey(all[j].t) === day) j++;
      const run = all.slice(i, j);
      const tools = run.filter(t => t.k === 'tool').length;
      if (run.length > 1 && tools > 0) frag.appendChild(workGroupNode(run, tools));
      else run.forEach(t => { const n = renderItem(t); if (n) frag.appendChild(n); });
      i = j - 1;
      continue;
    }
    const node = renderItem(it);
    if (node) frag.appendChild(node);
  }

  if (mode === 'replace') { box.innerHTML = ''; box.appendChild(frag); }
  else if (mode === 'prepend') { box.insertBefore(frag, box.firstChild); }
  else { box.appendChild(frag); }
  if (mode !== 'prepend') box.dataset.lastDay = lastDay || '';
}

function itemBody(it) {
  if (it && it.code) return I18n.notice(it.code, it);
  return (it && it.text) || '';
}

function renderItem(it) {
  switch (it.k) {
    case 'me': {
      const row = el('div', 'row me');
      const b = el('div', 'bubble me');
      b.innerHTML = md(it.text);
      b.dataset.raw = it.text;
      row.appendChild(b);
      return row;
    }
    case 'claude': {
      const row = el('div', 'row claude');
      const b = el('div', 'bubble claude');
      b.innerHTML = md(it.text);
      row.appendChild(b);
      return row;
    }
    case 'tool':     return toolNode(it);
    case 'think':    return foldNode('💭 ' + t('chat.thinking'), itemBody(it), 'think');
    case 'out':      return foldNode('▸ ' + t('chat.cmd_out'), itemBody(it), 'out');
    case 'image':    return imageNode(it);
    case 'file':     return el('div', 'chip', '📎 ' + (it.name || t('chat.document')));
    case 'cmd':      return el('div', 'chip', '⌘ ' + itemBody(it));
    case 'auto':     return el('div', 'chip', '⏱ ' + itemBody(it));
    // Blocchi di servizio: si sa che sono passati, ma non rubano la scena.
    case 'note':     return el('div', 'chip faint', '· ' + itemBody(it));
    case 'sys':      return el('div', 'chip warn', it.text);
    default:         return null;
  }
}

/* Ogni strumento sta in UNA riga: in una chat da 300 turni gli strumenti sono
   la maggioranza dei blocchi, e a lasciarli aperti si perde la conversazione. */
function toolNode(it) {
  const wrap = el('div', 'tool' + (it.error ? ' bad' : ''));
  const head = el('button', 'tool-head');
  head.innerHTML = `<span class="tool-ico">${it.error ? '⚠' : '⚙'}</span>`
    + `<span class="tool-name">${escapeHTML(it.name)}</span>`
    + (it.brief ? `<span class="tool-brief">${escapeHTML(it.brief)}</span>` : '')
    + `<span class="caret">▾</span>`;
  const body = el('div', 'tool-body hidden');
  let html = '';
  if (it.detail) html += codeHTML('', it.detail);
  if (it.pending) html += '<p class="tool-note">' + escapeHTML(t('chat.tool_pending')) + '</p>';
  else if (it.result !== undefined && it.result !== '') html += codeHTML(t('chat.tool_result'), String(it.result));
  body.innerHTML = html || '<p class="tool-note">' + escapeHTML(t('chat.tool_empty')) + '</p>';
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    head.classList.toggle('open');
  });
  wrap.appendChild(head); wrap.appendChild(body);
  return wrap;
}

/* Il lavoro in mezzo a due risposte: strumenti e ragionamenti. */
const WORK = new Set(['tool', 'think']);

/* Una fila di lavoro consecutivo diventa `⚙ 7 comandi ▾`, che si apre al tocco
   e dentro ha le righe di sempre, una per strumento. */
function workGroupNode(run, tools) {
  const bash = run.filter(t => t.k === 'tool' && t.name === 'Bash').length;
  const bad = run.some(t => t.error);
  const wrap = el('div', 'toolgroup' + (bad ? ' bad' : ''));
  const head = el('button', 'tool-head');
  head.innerHTML = `<span class="tool-ico">${bad ? '⚠' : '⚙'}</span>`
    + `<span class="tool-name">${tools} ${bash === tools ? t('chat.commands') : t('chat.tools')}</span>`
    + `<span class="tool-brief">${escapeHTML(groupBrief(run))}</span>`
    + `<span class="caret">▾</span>`;
  const body = el('div', 'toolgroup-body hidden');
  run.forEach(t => { const n = renderItem(t); if (n) body.appendChild(n); });
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    head.classList.toggle('open');
  });
  wrap.appendChild(head); wrap.appendChild(body);
  return wrap;
}

/* Di cosa si è occupata la fila, in poche parole: i nomi diversi, in ordine. */
function groupBrief(run) {
  const names = [];
  run.forEach((item) => {
    const n = item.k === 'think' ? t('chat.thinking') : item.name;
    if (n && !names.includes(n)) names.push(n);
  });
  return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
}

function foldNode(label, text, cls) {
  const wrap = el('div', 'fold ' + cls);
  const head = el('button', 'fold-head');
  head.innerHTML = `<span>${escapeHTML(label)}</span><span class="caret">▾</span>`;
  const body = el('div', 'fold-body hidden');
  body.innerHTML = md(text);
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    head.classList.toggle('open');
  });
  wrap.appendChild(head); wrap.appendChild(body);
  return wrap;
}

function imageNode(it) {
  const row = el('div', 'row ' + (it.who === 'user' ? 'me' : 'claude'));
  const b = el('div', 'bubble img ' + (it.who === 'user' ? 'me' : 'claude'));
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = t('chat.image');
  const path = `/api/chat/${encodeURIComponent(S.chat ? S.chat.id : '')}/image?o=${it.off}&i=${it.i}`
             + `&token=${encodeURIComponent(S.token)}`;
  // In casa e in diretta è un indirizzo; dal ponte l'immagine arriva come
  // dati dentro il tubo e diventa un indirizzo temporaneo qui nel telefono.
  Net.assetURL(path).then(u => { img.src = u; })
     .catch(() => { b.textContent = '🖼 ' + t('chat.image_bad'); });
  img.addEventListener('error', () => { b.textContent = '🖼 ' + t('chat.image_bad'); });
  b.appendChild(img);
  row.appendChild(b);
  return row;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ================= markdown ================= */

function escapeHTML(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let codeSeq = 0;
function codeHTML(label, code) {
  const id = 'code' + (++codeSeq);
  const head = label ? `<span class="code-lang">${escapeHTML(label)}</span>` : `<span class="code-lang">${escapeHTML(t('chat.code'))}</span>`;
  return `<div class="code"><div class="code-head">${head}`
       + `<button class="copy" data-code="${id}">${escapeHTML(t('chat.copy'))}</button></div>`
       + `<pre id="${id}"><code>${escapeHTML(code)}</code></pre></div>`;
}

/* Un markdown piccolo ma vero: grassetto, corsivo, titoli, elenchi, tabelle,
   citazioni, link, codice. Niente librerie, niente innerHTML non ripulito. */
function md(src) {
  if (!src) return '';
  const fences = [];
  let s = String(src).replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, info, code) => {
    fences.push({ info: String(info || '').trim(), code: code.replace(/\n$/, '') });
    return `F${fences.length - 1}`;
  });

  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return `C${codes.length - 1}`;
  });

  s = escapeHTML(s);

  const lines = s.split('\n');
  const out = [];
  let i = 0;

  const inline = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
             '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  while (i < lines.length) {
    const ln = lines[i];

    const fence = ln.trim().match(/^F(\d+)$/);
    if (fence) {
      const f = fences[Number(fence[1])];
      out.push(codeHTML(f.info, f.code));
      i++; continue;
    }
    if (!ln.trim()) { i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }

    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }

    // tabella: intestazione + riga di trattini
    if (ln.includes('|') && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i])); i++;
      }
      out.push('<div class="tablewrap"><table><thead><tr>'
        + head.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // citazione
    if (/^\s*&gt;\s?/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++;
      }
      out.push('<blockquote>' + buf.map(b => inline(b)).join('<br>') + '</blockquote>');
      continue;
    }

    // elenchi (un livello di rientro)
    const li = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const tag = ordered ? 'ol' : 'ul';
      let html = `<${tag}>`;
      let openNested = false;
      while (i < lines.length) {
        const m2 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m2) {
          // continuazione della voce precedente
          if (lines[i].trim() && /^\s{2,}/.test(lines[i])) { html += ' ' + inline(lines[i].trim()); i++; continue; }
          break;
        }
        const deep = m2[1].length >= 2;
        if (deep && !openNested) { html += `<${tag === 'ol' ? 'ol' : 'ul'} class="nested">`; openNested = true; }
        if (!deep && openNested) { html += `</${tag === 'ol' ? 'ol' : 'ul'}>`; openNested = false; }
        html += `<li>${inline(m2[3])}</li>`;
        i++;
      }
      if (openNested) html += `</${tag === 'ol' ? 'ol' : 'ul'}>`;
      html += `</${tag}>`;
      out.push(html);
      continue;
    }

    // paragrafo
    const buf = [];
    while (i < lines.length && lines[i].trim()
           && !/^(#{1,6})\s/.test(lines[i])
           && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])
           && !/^\s*&gt;/.test(lines[i])
           && !/^\s*F\d+\s*$/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) out.push('<p>' + buf.map(b => inline(b)).join('<br>') + '</p>');
    else i++;
  }

  let html = out.join('');
  html = html.replace(/C(\d+)/g, (m, n) => `<code>${escapeHTML(codes[Number(n)])}</code>`);
  return html;
}

/* Il tasto «copia». Fuori da HTTPS `navigator.clipboard` non esiste,
   e questa app gira in casa su http: serve la strada vecchia. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  const pre = document.getElementById(btn.dataset.code);
  if (!pre) return;
  const text = pre.textContent;
  const done = () => { btn.textContent = t('chat.copied'); setTimeout(() => { btn.textContent = t('chat.copy'); }, 1400); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
});

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  try { document.execCommand('copy'); done(); } catch (e) { /* niente da fare */ }
  document.body.removeChild(ta);
}

/* ================= invio e diretta ================= */

const msg = $('msg');

function autoGrow() {
  msg.style.height = 'auto';
  msg.style.height = Math.min(msg.scrollHeight, 132) + 'px';
}
msg.addEventListener('input', autoGrow);

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = msg.value.trim();
  if (!S.chat) return;
  // Un allegato senza didascalia si manda: una foto parla da sola.
  if (!text && !S.pending) return;
  if (S.uploading) return;

  let fileId = '';
  if (S.pending) {
    fileId = await uploadPending();
    // Il caricamento non è riuscito: il messaggio **non** parte, e quello che
    // aveva scritto resta nel riquadro. Il perché l'ha già detto `note`.
    if (!fileId) return;
  }

  const out = { t: 'sendChat', id: S.chat.id, text };
  if (fileId) out.file = fileId;
  send(out);
  // La bolla compare subito: l'attesa la si sente meno se si vede partire.
  const echoText = S.pending
    ? (text ? '📎 ' + S.pending.name + '\n' + text : '📎 ' + S.pending.name)
    : text;
  const row = renderItem({ k: 'me', text: echoText, t: Date.now() });
  row.dataset.echo = '1';
  // Quello che va confrontato con la copia vera è **il testo**: nel
  // transcript l'allegato è un blocco a parte, non una riga con la graffetta.
  // E se il testo non c'è, la bolla si toglie appena arriva qualcosa di vero.
  row.querySelector('.bubble').dataset.raw = text;
  if (!text) row.dataset.echoempty = '1';
  $('messages').appendChild(row);
  if (text) S.pendingEcho.push(text);
  msg.value = '';
  clearPending();
  autoGrow();
  scrollToBottom(true);
});

/* ================= allegati =================

   Tre pezzi: qui si sceglie il file e lo si vede; `uploadPending` lo porta
   sul Mac **a pezzi**; il Mac lo appende dentro Claude Desktop.

   I pezzi non sono un vezzo: la richiesta che l'host accetta si ferma a un
   mega, e dal ponte la stessa richiesta viaggia dentro il canale diretto,
   dove le buste sono piccole. Spezzare vuol dire che la strada è **una
   sola** in casa, in diretta e dal ponte: il trasporto non si tocca. */

// Il tetto lo dice l'host (`Uploads.maxBytes`), ma il telefono deve saperlo
// **prima** di cominciare: dire «troppo grande» dopo tre minuti di
// caricamento è peggio che non farlo partire.
const MAX_ALLEGATO = 10 * 1024 * 1024;
// Un pezzo, prima di diventare base64. Sopra il mezzo mega la richiesta
// codificata sfonderebbe il limite dell'host.
const PEZZO = 384 * 1024;
// Una foto dell'iPhone pesa 3-8 MB e non serve a nessuno a quella misura:
// si rimpicciolisce qui, prima di partire. Sopra questa soglia si ridimensiona.
const FOTO_MAX_LATO = 2000;
const FOTO_SOGLIA = 900 * 1024;

function humanSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' kB';
  return n + ' B';
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
// Toglierlo a mano vuol dire toglierlo: non deve ricomparire da solo se poi
// un invio viene rifiutato.
$('pfDrop').addEventListener('click', forgetPending);

/** L'allegato esce di scena per davvero. Da chiamare anche cambiando
    conversazione: una foto scelta per una chat non deve seguirti in
    un'altra — è esattamente il modo di mandarla nel posto sbagliato. */
function forgetPending() {
  clearPending();
  S.lastPending = null;
  if (S.thumbURL) { URL.revokeObjectURL(S.thumbURL); S.thumbURL = ''; }
}

$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  // Il campo si svuota subito: riscegliere lo **stesso** file non farebbe
  // scattare `change` una seconda volta.
  e.target.value = '';
  if (!f) return;
  clearPending();

  let blob = f;
  let name = f.name || t('chat.photo');
  if (/^image\//i.test(f.type) && f.size > FOTO_SOGLIA) {
    const smaller = await shrinkImage(f).catch(() => null);
    if (smaller) { blob = smaller; name = name.replace(/\.(heic|heif|png|webp)$/i, '.jpg'); }
  }
  if (blob.size > MAX_ALLEGATO) {
    note(t('chat.file_too_big', { max: humanSize(MAX_ALLEGATO) }), true,
         { key: 'chat.file_too_big', vars: { max: humanSize(MAX_ALLEGATO) } });
    return;
  }
  S.pending = { blob, name, size: blob.size, type: blob.type || f.type || 'application/octet-stream' };
  showPending();
});

/* Una foto scattata adesso non serve a 4032 pixel dentro una conversazione:
   si ridisegna più piccola su una tela e riparte come JPEG. Il vantaggio
   vero è fuori casa, dove ogni mega è un minuto. Se il browser non sa
   leggerla (certi HEIC) si torna al file originale, non si blocca niente. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, FOTO_MAX_LATO / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => {
        // Se il «piccolo» pesa più del grande, tanto vale mandare l'originale.
        if (b && b.size < file.size) resolve(b); else reject(new Error('inutile'));
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('illeggibile')); };
    img.src = url;
  });
}

function showPending() {
  const p = S.pending;
  $('pfName').textContent = p.name;
  $('pfSize').textContent = humanSize(p.size);
  $('pfBar').style.width = '0%';
  const thumb = $('pfThumb');
  if (S.thumbURL) { URL.revokeObjectURL(S.thumbURL); S.thumbURL = ''; }
  if (/^image\//i.test(p.type)) {
    S.thumbURL = URL.createObjectURL(p.blob);
    thumb.style.backgroundImage = `url(${S.thumbURL})`;
    thumb.style.backgroundSize = 'cover';
    thumb.style.backgroundPosition = 'center';
    thumb.textContent = '';
  } else {
    thumb.style.backgroundImage = '';
    thumb.textContent = '📎';
  }
  $('pendingFile').classList.remove('hidden');
  $('attachBtn').dataset.on = '1';
  // Il riquadro dell'allegato ruba due righe al filo: se si stava leggendo
  // il fondo, il fondo deve restare a vista.
  if (nearBottom()) scrollToBottom(false);
}

function clearPending() {
  // L'ultimo scelto resta da parte finché non se ne sceglie un altro: se la
  // consegna viene rifiutata dal Mac, `returnDraft` lo rimette dov'era.
  if (S.pending) S.lastPending = S.pending;
  S.pending = null;
  S.uploading = false;
  $('pendingFile').classList.add('hidden');
  $('attachBtn').dataset.on = '0';
}

/** Porta un file sul Mac, un pezzo per volta — lo stesso tubo per gli
    allegati e per la voce. Torna l'identificativo che il Mac gli ha dato, o
    '' se il Mac ha detto di no (e lo si è già detto a chi guarda). Un guasto
    di rete invece **lancia**: chi chiama decide cosa dire. */
async function uploadBlob(blob, name, mime, onProgress) {
  const total = Math.max(1, Math.ceil(blob.size / PEZZO));
  let id = '';
  for (let i = 0; i < total; i++) {
    const slice = blob.slice(i * PEZZO, Math.min((i + 1) * PEZZO, blob.size));
    const b64 = await blobToBase64(slice);
    const res = await Net.fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ id, i, n: total, name, mime, size: blob.size, b: b64 }),
    });
    const data = await res.json();
    if (!data || !data.ok) {
      note(httpError(data, 'chat.upload_failed'), true,
           data && data.code ? { code: data.code, data } : { key: 'chat.upload_failed' });
      return '';
    }
    id = data.id;
    if (onProgress) onProgress((i + 1) / total);
  }
  return id;
}

/** L'allegato scelto sale sul Mac. Torna l'identificativo, o '' se non ce
    l'ha fatta — dicendo perché. */
async function uploadPending() {
  const p = S.pending;
  if (!p) return '';
  S.uploading = true;
  $('sendBtn').disabled = true;
  try {
    return await uploadBlob(p.blob, p.name, p.type, (frac) => {
      $('pfBar').style.width = Math.round(frac * 100) + '%';
    });
  } catch (e) {
    const f = Net.failure(e);
    note(t(f.key, f.vars), true, f);
    return '';
  } finally {
    S.uploading = false;
    $('sendBtn').disabled = false;
  }
}

/* `FileReader` dà `data:<mime>;base64,<roba>`: si tiene solo la coda. Il
   pezzo viaggia dentro un JSON, quindi come testo. */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('lettura-fallita'));
    r.readAsDataURL(blob);
  });
}

/* Il messaggio non è partito: si toglie la bolla e si rimette nel riquadro
   quello che aveva scritto. Nessuno deve riscriverlo a memoria. */
function returnDraft() {
  const echo = $('messages').querySelector('[data-echo="1"]');
  if (!echo) return;
  const text = echo.querySelector('.bubble') ? echo.querySelector('.bubble').dataset.raw : '';
  echo.remove();
  const k = S.pendingEcho.indexOf(String(text || '').trim());
  if (k !== -1) S.pendingEcho.splice(k, 1);
  if (text && !msg.value.trim()) { msg.value = text; autoGrow(); }
  // Anche l'allegato torna al suo posto: la foto è ancora qui in memoria, e
  // farla riscegliere dalla galleria per un rifiuto del Mac è una piccola
  // crudeltà evitabile.
  if (S.lastPending && !S.pending) { S.pending = S.lastPending; showPending(); }
}

msg.addEventListener('keydown', (e) => {
  // Sul telefono Invio va a capo; da tastiera vera invia.
  if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('stopBtn').addEventListener('click', () => {
  if (S.chat) send({ t: 'stopChat', id: S.chat.id });
});

/* ================= la voce =================

   Il tasto fra il ＋ e il campo. Si registra sul telefono (`MediaRecorder`),
   l'audio sale con lo stesso tubo a pezzi degli allegati, il Mac lo trascrive
   (`/api/transcribe`, tutto sul Mac) e il **testo** finisce nel riquadro, dove
   lo si rilegge e lo si corregge prima di mandarlo. L'audio non entra mai
   in Claude.

   Tre cose verificate, che spiegano le righe sotto:

   1. **Solo `audio/mp4`.** Il Mac legge quello (`AVAudioFile`) e non legge
      WebM/Opus, che è ciò che il telefono produce se lo si lascia scegliere.
      Con un formato che il Mac non legge il tasto fallirebbe in silenzio.
      E su iOS `isTypeSupported` può dire sì e `start()` lanciare comunque
      `NotSupportedError`: si prende e si dice.
   2. **Il permesso del microfono non si ricorda** nelle app aggiunte alla
      schermata Home: va riconcesso a ogni apertura. Non si può evitare; si
      può non peggiorarlo, e per questo la pagina non salta più di origine
      all'avvio (il salto verso Tailscale è stato tolto il 04/09/2026).
   3. **Sulla rete di casa il microfono in pagina non esiste**: la pagina è
      in http, non è un contesto sicuro, `navigator.mediaDevices` non c'è.
      Il tasto lì **si nasconde**, e nelle Impostazioni c'è scritto di usare
      la dettatura della tastiera, che scrive nello stesso riquadro. Un tasto
      che non fa niente è peggio di nessun tasto.                            */

const micBtn = $('micBtn');
const VOCE_MIME = 'audio/mp4';
// Cinque minuti di parlato sono ~1,3 MB: molto sotto il tetto degli allegati
// e più di quanto entri in un messaggio.
const VOCE_MAX_MIN = 5;

function micPossible() {
  return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
            && window.MediaRecorder && MediaRecorder.isTypeSupported(VOCE_MIME));
}

/* Il tasto si mostra solo dove può funzionare, e le Impostazioni dicono la
   verità di questa strada: qui c'è il tasto, oppure qui c'è solo la
   dettatura della tastiera. */
function updateMic(forceOff) {
  const ok = !forceOff && !S.micOff && micPossible();
  if (forceOff) S.micOff = true;
  micBtn.classList.toggle('hidden', !ok);
  micBtn.setAttribute('aria-label', t(S.voce ? 'aria.mic_stop' : 'aria.mic'));
  $('dictationHint').innerHTML = t(ok ? 'settings.dictation' : 'settings.dictation_home');
}

micBtn.addEventListener('click', () => { if (S.voce) stopVoice(); else startVoice(); });

async function startVoice() {
  if (!S.chat || S.transcribing) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    note(t(denied ? 'voice.no_mic' : 'voice.failed'), true, { key: denied ? 'voice.no_mic' : 'voice.failed' });
    return;
  }
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: VOCE_MIME });
    rec.start();
  } catch (e) {
    // `isTypeSupported` ha detto sì e `start()` ha detto no: succede. Il
    // tasto sparisce, e la riga d'aiuto dice della tastiera.
    stream.getTracks().forEach(tr => tr.stop());
    note(t('voice.unsupported'), true, { key: 'voice.unsupported' });
    updateMic(true);
    return;
  }
  const v = { rec, stream, chunks: [], t0: Date.now(), timer: 0 };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) v.chunks.push(e.data); };
  rec.onstop = () => finishVoice(v);
  rec.onerror = () => finishVoice(v);
  v.timer = setTimeout(() => {
    if (S.voce !== v) return;
    note(t('voice.too_long', { min: VOCE_MAX_MIN }), false, { key: 'voice.too_long', vars: { min: VOCE_MAX_MIN } });
    stopVoice();
  }, VOCE_MAX_MIN * 60 * 1000);
  S.voce = v;
  micBtn.classList.add('rec');
  micBtn.setAttribute('aria-label', t('aria.mic_stop'));
  note(t('voice.recording'), false, { key: 'voice.recording' });
}

function stopVoice() {
  const v = S.voce;
  if (!v) return;
  clearTimeout(v.timer);
  if (v.rec.state === 'inactive') { finishVoice(v); return; }
  try { v.rec.stop(); } catch (e) { finishVoice(v); }
}

async function finishVoice(v) {
  if (S.voce !== v) return;
  S.voce = null;
  clearTimeout(v.timer);
  v.stream.getTracks().forEach(tr => tr.stop());
  micBtn.classList.remove('rec');
  micBtn.setAttribute('aria-label', t('aria.mic'));
  // La chat è stata chiusa mentre si registrava: non c'è più dove scrivere.
  if (!S.chat) return;
  const blob = new Blob(v.chunks, { type: v.rec.mimeType || VOCE_MIME });
  if (Date.now() - v.t0 < 500 || blob.size < 1024) {
    note(t('voice.empty'), true, { key: 'voice.empty' });
    return;
  }
  S.transcribing = true;
  micBtn.classList.add('busy');
  note(t('voice.transcribing'), false, { key: 'voice.transcribing' });
  try {
    const id = await uploadBlob(blob, 'voce.m4a', blob.type || VOCE_MIME);
    if (!id) return;
    const res = await Net.fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ id, lang: I18n.locale() }),
    });
    const data = await res.json();
    if (!data || !data.ok) {
      note(httpError(data, 'voice.failed'), true, data && data.code ? { code: data.code, data } : { key: 'voice.failed' });
      return;
    }
    const text = String(data.text || '').trim();
    if (!text) { note(t('voice.empty'), true, { key: 'voice.empty' }); return; }
    insertDictated(text);
    hideNote();
  } catch (e) {
    const f = Net.failure(e);
    note(t(f.key, f.vars), true, f);
  } finally {
    S.transcribing = false;
    micBtn.classList.remove('busy');
  }
}

/* Il testo va **in coda** a quello che c'è già, con uno spazio in mezzo: chi
   ha scritto metà messaggio e detta il resto non deve vederselo cancellare. */
function insertDictated(text) {
  const cur = msg.value;
  msg.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + text;
  autoGrow();
  msg.focus();
  try { msg.setSelectionRange(msg.value.length, msg.value.length); } catch (e) {}
}

function onChatStart(m) {
  if (!S.chat || m.chat !== S.chat.id) return;
  S.sending = true;
  S.live = {}; S.liveOrder = [];
  $('live').innerHTML = '<div class="working"><span class="spin"></span>' + escapeHTML(t('chat.claude_working')) + '</div>';
  $('stopBtn').classList.remove('hidden');
  $('sendBtn').classList.add('hidden');
  scrollToBottom(true);
}

function onChatReady(m) {
  if (!S.chat || m.chat !== S.chat.id) return;
  if (m.model) setChatSub(shortModel(m.model));
}

function liveBlock(i, kind, name) {
  if (!S.sending) return;
  if (!S.live[i]) { S.live[i] = { kind, name: name || '', text: '' }; S.liveOrder.push(i); }
  scheduleLiveRender();
}

function liveAppend(m, kind) {
  if (!S.sending || !S.chat || m.chat !== S.chat.id) return;
  if (!S.live[m.i]) { S.live[m.i] = { kind, name: '', text: '' }; S.liveOrder.push(m.i); }
  S.live[m.i].text += m.s;
  scheduleLiveRender();
}

function liveToolBrief(m) {
  if (!S.sending) return;
  for (let k = S.liveOrder.length - 1; k >= 0; k--) {
    const b = S.live[S.liveOrder[k]];
    if (b.kind === 'tool' && !b.brief) { b.brief = m.brief; break; }
  }
  scheduleLiveRender();
}

let liveTimer = 0;
function scheduleLiveRender() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => { liveTimer = 0; renderLive(); }, 70);
}

function renderLive() {
  if (!S.sending) return;
  const stick = nearBottom();
  const parts = S.liveOrder.map(i => {
    const b = S.live[i];
    if (b.kind === 'text') return `<div class="bubble claude">${md(b.text)}</div>`;
    if (b.kind === 'think') {
      const n = b.text.length;
      return `<div class="fold think live-think"><div class="fold-head">💭 ${escapeHTML(t('chat.thinking'))}`
           + `<span class="tool-brief">${escapeHTML(t('chat.chars', { n }))}</span></div></div>`;
    }
    if (b.kind === 'tool') {
      return `<div class="tool"><div class="tool-head"><span class="tool-ico">⚙</span>`
           + `<span class="tool-name">${escapeHTML(b.name)}</span>`
           + `<span class="tool-brief">${escapeHTML(b.brief || '…')}</span></div></div>`;
    }
    return '';
  });
  $('live').innerHTML = '<div class="row claude live-row">' + parts.join('')
    + '</div><div class="working"><span class="spin"></span>' + escapeHTML(t('chat.claude_working')) + '</div>';
  if (stick) scrollToBottom(false);
}

function onChatDone(m) {
  if (!S.chat || m.chat !== S.chat.id) return;
  // Un cambio d'impegno che non è andato in porto: il chip torna a dire
  // quello che c'è davvero sul Mac.
  if (S.effortWas !== undefined) {
    if (m.ok === false) { S.chat.effort = S.effortWas; setChatSub(S.chat.model); }
    S.effortWas = undefined;
  }
  // Rifiutato in partenza (chat in uso sul Mac, cartella sparita): il messaggio
  // non è mai partito. La bolla va tolta e il testo restituito, altrimenti si
  // resta convinti di averlo mandato.
  if (m.ok === false && !S.sending) returnDraft();
  S.sending = false;
  S.live = {}; S.liveOrder = [];
  $('live').innerHTML = '';
  $('stopBtn').classList.add('hidden');
  $('sendBtn').classList.remove('hidden');

  if (m.ok === false) {
    note(noticeText(m) || t('chat.failed'), true, m.code ? { code: m.code, data: m } : { key: 'chat.failed' });
  } else if (m.denials && m.denials.length) {
    // Uno strumento bloccato si dice: fingere che sia andata bene e' peggio.
    note(t('n.permissions_blocked', { list: m.denials.join(', ') }), true,
         { key: 'n.permissions_blocked', vars: { list: m.denials.join(', ') } });
  } else if (m.stopped) {
    note(t('n.stopped'), false, { key: 'n.stopped' });
  } else if (m.code) {
    note(noticeText(m), false, { code: m.code, data: m });
  } else {
    hideNote();
  }
  if (m.model) setChatSub(shortModel(m.model));
}

/* Le righe vere, appena scritte nel file: sostituiscono la bozza in diretta. */
function onChatAppend(m) {
  if (!S.chat || m.chat !== S.chat.id) return;
  S.chat.end = m.end;
  const items = (m.items || []).filter(it => {
    if (it.k !== 'me') return true;
    const k = S.pendingEcho.indexOf(String(it.text || '').trim());
    if (k === -1) return true;
    // È la copia vera del messaggio che avevamo già messo a schermo.
    S.pendingEcho.splice(k, 1);
    const echo = $('messages').querySelector('[data-echo="1"]');
    if (echo) echo.remove();
    return true;
  });
  if (!items.length) return;
  // Un allegato senza didascalia non ha un testo con cui riconoscersi: la
  // sua bolla provvisoria se ne va appena arriva la roba vera.
  const muta = $('messages').querySelector('[data-echoempty="1"]');
  if (muta) muta.remove();
  const stick = nearBottom();
  renderItems(items, 'append');
  if (stick) scrollToBottom(false);
}

function note(text, bad, src) {
  S.noteState = src ? Object.assign({ bad: !!bad }, src) : { text, bad: !!bad };
  const n = $('chatNote');
  n.textContent = text;
  n.classList.toggle('bad', !!bad);
  n.classList.remove('hidden');
  if (!bad) setTimeout(hideNote, 6000);
}
function hideNote() { S.noteState = null; $('chatNote').classList.add('hidden'); }

function replayNote() {
  const s = S.noteState;
  if (!s) return;
  if (s.net) { note(Net.detailLabel(), s.bad, s); return; }
  if (s.code) { note(I18n.notice(s.code, s.data), s.bad, s); return; }
  if (s.key) { note(t(s.key, s.vars), s.bad, s); return; }
}

function nearBottom() {
  const t = $('thread');
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom(force) {
  const t = $('thread');
  requestAnimationFrame(() => {
    t.scrollTop = t.scrollHeight;
    if (force) setTimeout(() => { t.scrollTop = t.scrollHeight; }, 60);
  });
}

/* ================= tempo ================= */

function dayKey(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  if (dayKey(ms) === dayKey(now.getTime())) return t('list.today');
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(ms) === dayKey(y.getTime())) return t('list.yesterday');
  return d.toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'long', year:
    d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function whenLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const mins = (now - d) / 60000;
  if (mins < 60) return t('list.now');
  if (dayKey(ms) === dayKey(now.getTime())) {
    return d.toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit' });
  }
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(ms) === dayKey(y.getTime())) return t('list.yesterday');
  if ((now - d) / 86400000 < 7) return d.toLocaleDateString(I18n.locale(), { weekday: 'short' });
  return d.toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'short' });
}

/* «claude-haiku-4-5-20251001» non e' una cosa da mostrare a una persona:
   diventa «Haiku 4.5». La data in coda non serve a nessuno. */
function shortModel(m) {
  let s = String(m || '').replace(/\[.*\]/, '').replace(/^claude-/, '').replace(/-\d{6,}$/, '');
  const parts = s.split('-').filter(Boolean);
  if (!parts.length) return '';
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const version = parts.slice(1).join('.');
  return version ? family + ' ' + version : family;
}

/* ================= pannelli e stato ================= */

function openSheet(el) {
  $('sheetBackdrop').classList.remove('hidden');
  el.classList.remove('hidden');
}
function closeSheets() {
  $('sheetBackdrop').classList.add('hidden');
  $('settingsSheet').classList.add('hidden');
  $('modelSheet').classList.add('hidden');
}
$('sheetBackdrop').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));

async function loadStatus() {
  // `/health` non chiede il token: dice chi sta servendo, e con quale build.
  try {
    const h = await (await Net.fetch('/health')).json();
    S.build = `${h.version} · binario ${h.build} · webapp ${h.webappBuild}`;
  } catch (e) { /* poco male: è una diagnostica */ }
  const m = await api('/api/status');
  if (m && m.meet) Net.setMeet(m.meet);
  if (m) updateDiag(m);
}

$('modeSel').addEventListener('change', e => send({ t: 'mode', v: e.target.value }));
$('forgetBtn').addEventListener('click', async () => {
  // «Dimentica» detto per davvero: si lascia il posto anche sul Mac, invece di
  // restare nel suo elenco per un telefono che non tornerà. Se il Mac non
  // risponde si dimentica lo stesso da questa parte: il gettone qui non serve
  // più.
  const token = S.token;
  try {
    await Net.fetch('/api/forget', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
  } catch (e) { /* il Mac non c'è: si dimentica comunque di qua */ }
  Net.forgetToken();
  if (S.ws) S.ws.close();
  closeSheets();
  showScreen('pair');
  $('pairError').textContent = t('n.signed_out');
});

function setStatus(on, text) {
  const dot = $('dot');
  if (dot) dot.classList.toggle('on', !!on);
  if (text && $('statusText')) $('statusText').textContent = text;
}

/* --- la strada, scritta sempre ---

   Sotto il codice, nella riga di stato dell'elenco e nella diagnostica: da
   che strada si sta parlando col Mac. Dal ponte c'è anche il racconto di
   cosa sta facendo il trasporto (cerco il Mac, mi collego, non si passa),
   che altrimenti lascerebbe la pagina muta. Durante l'accoppiamento finisce
   sotto le cifre, dopo nella riga di stato. */

function updateRoad() {
  const label = Net.roadLabel();
  $('pairRoad').textContent = t('road.label', { road: label });
  if (!S.connected) setStatus(false, statusLine(Net.remote && Net.state === 'connecting'
    ? (Net.detailLabel() || t('status.connecting')) : t('status.disconnected')));
}

Net.onstatus = (n) => {
  if (!n.remote) return;
  if (S.screen === 'pair') {
    if (n.state === 'connecting' && S.pairing) $('pairError').textContent = Net.detailLabel() || t('status.connecting');
    updateRoad();
    return;
  }
  if (n.state === 'open') { S.bridgeFails = 0; setStatus(true, whereText()); }
  else if (n.state === 'connecting') setStatus(false, statusLine(Net.detailLabel() || t('status.connecting')));
  else if (n.state === 'failed') {
    if (bridgeFailed(n.detail)) return;
    setStatus(false, statusLine(t('status.offline')));
    note(Net.detailLabel(), false, { net: true });
  }
};

/* --- quando il ponte non porta al Mac, si torna al codice ---

   Il 04/09/2026 il Mac ha rigenerato il segreto della sua stanza sul ponte:
   il telefono bussava a una stanza vuota, il Mac non scriveva niente, e la
   pagina riprovava ogni quindici secondi **per sempre**, con la schermata del
   codice che non tornava mai — perché col gettone in tasca si va dritti a
   `start()`. La cura c'era (`/api/status` rimanda il segreto) ma stava dopo
   l'apertura del tubo, che col segreto sbagliato non si apre.

   Adesso: dopo tre fallimenti di fila con `senza-incontro` (manca il segreto)
   o `nessuna-risposta` (il Mac non si presenta) si butta il gettone e si
   chiede il codice, dicendo perché. Tre e non uno: un Mac addormentato per
   un attimo non deve costare un accoppiamento. **Mai** su `niente-strada`:
   quello è davvero la rete (un NAT che non si buca), e chiedere il codice
   lì sarebbe un fastidio quotidiano per un guasto che capita due volte
   l'anno. */

const RIPROVE_PRIMA_DEL_CODICE = 3;

function bridgeFailed(detail) {
  if (detail !== 'senza-incontro' && detail !== 'nessuna-risposta') return false;
  S.bridgeFails = (S.bridgeFails || 0) + 1;
  if (S.bridgeFails < RIPROVE_PRIMA_DEL_CODICE) return false;
  S.bridgeFails = 0;
  Net.forgetToken();
  if (S.ws) { try { S.ws.close(); } catch (e) {} }
  S.ws = null;
  S.connected = false;
  if (S.chat) { send({ t: 'closeChat', id: S.chat.id }); S.chat = null; }
  closeSheets();
  showScreen('pair');
  $('pairError').textContent = t('err.' + detail);
  updateRoad();
  return true;
}

function remoteLabel(r) {
  if (!r) return '—';
  const code = r.stateCode || r.state || '';
  let s = I18n.has('remote.' + code) ? I18n.remote(code, { n: r.up, detail: r.detail || '' }) : (code || '—');
  if (r.note && I18n.has('remote.' + r.note)) s += ' · ' + I18n.remote(r.note);
  if (r.base) s += ' · ' + String(r.base).replace(/^https?:\/\//, '');
  return s;
}

function updateDiag(m) {
  S.lastDiag = m;
  if (m.cli === false) {
    $('cliWarn').innerHTML = t('settings.cli');
    $('cliWarn').classList.remove('hidden');
  }
  $('diag').textContent =
    `${t('diag.version')}: ${S.build || '—'}\n` +
    `${t('diag.cli')}: ${m.cli ? t('diag.found') : t('diag.missing')}\n` +
    `${t('diag.ax')}: ${m.accessibility ? t('diag.ax_ok') : t('diag.ax_no')}\n` +
    `${t('diag.devices')}: ${m.devices}\n` +
    // La strada di **questa** pagina, e com'è messo il ponte sul Mac: sono
    // le due righe da leggere quando qualcosa non va.
    `${t('diag.link')}: ${Net.roadLabel()}` +
    (Net.remote
      ? ` · ${Net.stats.pair || '—'} · ${t('diag.opened', { ms: Net.stats.msToOpen, bytes: Net.stats.signalBytes })}`
      : '') +
    `\n${t('diag.rendezvous')}: ${remoteLabel(m.remote)}`;
}

/* ================= ciclo ================= */

setInterval(() => {
  if (S.ws && S.ws.readyState === 1) send({ t: 'ping', ts: Date.now() });
}, 4000);

// L'elenco si riordina da solo, ma **non si chiede più ogni sei secondi**: il
// Mac manda `chatsChanged` sulla diretta quando cambia qualcosa (vedi
// `onControl`). Trenta secondi fermi sull'elenco delle routine costavano
// 484 KB per righe identiche; adesso costano zero.

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    connect();
    if (S.screen === 'list') loadChats();
  }
});

if (window.visualViewport) {
  // Con la tastiera aperta iOS riduce solo il viewport visuale: senza questo
  // la barra di invio finisce sotto ai tasti.
  const vv = window.visualViewport;
  vv.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vh', vv.height + 'px');
    if (S.screen === 'chat' && nearBottom()) scrollToBottom(false);
  });
  document.documentElement.style.setProperty('--vh', vv.height + 'px');
}

/* ================= avvio ================= */

window.RF = {
  send, api, escapeHTML,
  token: () => S.token,
  setStatus,
  screen: () => S.screen,
};

function relocalize() {
  I18n.apply();
  $('listName').textContent = S.listKind === 'routine' ? t('list.routines') : t('list.chats');
  $('chatSearch').placeholder = S.listKind === 'routine' ? t('list.search_routines') : t('list.search_chats');
  if (!S.pairing) $('pairBtn').textContent = t('pair.button');
  updateRoutinesBtn();
  if (S.screen === 'list') renderChats();
  if (S.chat) {
    setChatSub(S.chat.model);
    if (S.lastWorking) onChatWorking(S.lastWorking);
    if (S.threadItems && S.threadItems.length) renderItems(S.threadItems, 'replace');
    if (S.sending) renderLive();
  }
  if (S.lastDiag) updateDiag(S.lastDiag);
  updateRoad();
  updateMic();
  if (S.connected) setStatus(true, whereText());
  if (!$('modelSheet').classList.contains('hidden') && S.chat) apriFoglioModello();
  $('moreBtn').textContent = t('chat.load_more');
  replayNote();
}

I18n.onChange(relocalize);
$('langSel').addEventListener('change', (e) => I18n.set(e.target.value));

(async function boot() {
  // Quali gruppi erano richiusi l'ultima volta. Se il cassetto è illeggibile
  // si riparte con tutti aperti: è lo stato giusto, non un ripiego.
  try { S.closedGroups = JSON.parse(localStorage.getItem('riflesso.gruppichiusi') || '{}') || {}; }
  catch (e) { S.closedGroups = {}; }
  I18n.apply();
  $('langSel').value = I18n.get();

  // Prima di ogni altra cosa: **chi mi sta servendo?** Se dietro questo
  // indirizzo c'e' il Mac — la 7654 nuda, o un qualunque inoltro — si parla
  // con lui diretto, senza tubo. `Net.remote` resta vero finche' non lo dice
  // lui. Va fatto qui, prima di leggere il gettone.
  //
  // Qui c'era anche un salto verso un'altra origine (Tailscale) all'avvio:
  // tolto il 04/09/2026. Restare sull'origine da cui si e' partiti e' anche
  // cio' che tiene in vita il permesso del microfono, che fra origini non si
  // eredita.
  await Net.probeDirect();
  updateRoad();
  updateMic();

  // **Il codice nel link vince sul gettone salvato.**
  //
  // Inquadrare il QR e' un gesto esplicito: «voglio entrare adesso, con queste
  // cifre». Prima aveva la precedenza il gettone in memoria, e il codice non
  // veniva nemmeno guardato — quindi se il Mac aveva dimenticato questo
  // telefono (per una disconnessione, o perche' qualcuno ha premuto «Scollega
  // tutti»), il telefono restava fuori **per sempre**: riscansionare non
  // serviva a niente e non arrivava nulla al Mac, perche' non partiva nessuna
  // richiesta di accoppiamento. E' successo davvero il 31/08/2026, e da fuori
  // non c'e' modo di accorgersene: sembra che non funzioni la rete.
  if (Net.codeFromLink) Net.forgetToken();

  if (S.token) { start(); return; }

  // Da qui in poi si chiede il codice, e funziona tanto dalla rete di casa
  // quanto da una rete mai vista prima. Il vecchio ramo «sei fuori, torna a
  // casa sul Wi-Fi» non c'è più: era il difetto.
  showScreen('pair');
  $('pinInput').setAttribute('maxlength', String(PIN_DIGITS));
  $('pinInput').setAttribute('placeholder', '0'.repeat(PIN_DIGITS));

  // Arrivati dal QR del Mac: le cifre ci sono già, non c'è niente da leggere
  // e niente da digitare.
  if (Net.codeFromLink) {
    $('pinInput').value = Net.codeFromLink;
    Net.codeFromLink = '';
    pair();
    return;
  }
  setTimeout(() => $('pinInput').focus(), 250);
})();
