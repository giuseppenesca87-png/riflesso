#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   IL CHIP — «Opus 4.8 · Alto» deve starci. Sempre.

   Si provano **tutte** le combinazioni modello × impegno, in italiano e in
   inglese, su uno schermo stretto (390 pt, un iPhone piccolo). Il posto lo
   decide l'italiano, che è più lungo.

   Due cose devono restare vere:
   · il chip non esce dalla barra;
   · quando non ci sta, ad accorciarsi è **il modello**, mai l'impegno —
     «Opus…» si legge lo stesso, «Ultracod…» no.
------------------------------------------------------------------ */

const { launch, sleep } = require('./browser');
const { pin } = require('./pin');

const BASE = process.env.RIFLESSO_URL || 'http://127.0.0.1:7654';

const results = [];
const ok = (m) => { results.push(1); console.log('[OK] ' + m); };
const bad = (m) => { results.push(0); console.log('[NO] ' + m); };
const info = (m) => console.log('     ' + m);

async function main() {
  const code = pin();
  const b = await launch(BASE);
  // 390×844: l'iPhone piccolo. Se ci sta qui ci sta ovunque.
  await b.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await sleep(1400);
  if (await b.evalJS(`!document.getElementById('pair').classList.contains('hidden')`)) {
    await b.evalJS(`(() => {
      const i = document.getElementById('pinInput');
      i.value = ${JSON.stringify(code)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2200);
  }
  for (let i = 0; i < 40; i++) {
    if (await b.evalJS(`document.querySelectorAll('.chatrow').length`) > 0) break;
    await sleep(400);
  }
  await b.evalJS(`document.querySelector('.chatrow:not(.closed)').click()`);
  await sleep(2400);

  let peggio = null;
  for (const lang of ['it', 'en']) {
    await b.evalJS(`I18n.set(${JSON.stringify(lang)})`);
    await sleep(300);
    const esiti = await b.evalJS(`(() => {
      const out = [];
      const vero = { model: S.chat.model, effort: S.chat.effort, titolo: document.getElementById('chatTitle').textContent };
      // Un titolo lungo è il caso peggiore: il chip e il titolo si contendono
      // la stessa barra.
      document.getElementById('chatTitle').textContent = 'Contabilità e Documenti del 2026';
      for (const m of MODELLI) {
        for (const e of IMPEGNI) {
          S.chat.model = m.nome; S.chat.effort = e.stato;
          setChatSub(m.nome);
          const chip = document.getElementById('modelBtn');
          const bar = chip.parentElement;
          const mod = chip.querySelector('.mc-model');
          const eff = chip.querySelector('.mc-effort');
          out.push({
            lang: I18n.get(), modello: m.nome, impegno: e.stato,
            testo: chip.textContent.trim(),
            esce: chip.getBoundingClientRect().right > bar.getBoundingClientRect().right + 1,
            // taglia il nome del modello? è permesso
            modTagliato: mod ? mod.scrollWidth > mod.clientWidth + 1 : false,
            // taglia l'impegno? NON è permesso
            effTagliato: eff ? eff.scrollWidth > eff.clientWidth + 1 : false,
            effVisibile: !!eff,
            titoloLargo: document.getElementById('chatTitle').clientWidth,
          });
        }
      }
      S.chat.model = vero.model; S.chat.effort = vero.effort;
      document.getElementById('chatTitle').textContent = vero.titolo;
      setChatSub(vero.model);
      return out;
    })()`);

    const escono = esiti.filter(e => e.esce);
    const troncati = esiti.filter(e => e.effTagliato);
    const senzaImpegno = esiti.filter(e => !e.effVisibile && !/Haiku/.test(e.modello));
    const stretti = esiti.filter(e => e.titoloLargo < 70);

    escono.length === 0
      ? ok(`${lang}: nessuna delle ${esiti.length} combinazioni esce dalla barra`)
      : bad(`${lang}: ${escono.length} combinazioni escono, es. «${escono[0].testo}»`);
    troncati.length === 0
      ? ok(`${lang}: l'impegno non viene mai tagliato`)
      : bad(`${lang}: impegno tagliato in ${troncati.length} casi, es. «${troncati[0].testo}»`);
    senzaImpegno.length === 0
      ? ok(`${lang}: l'impegno c'è sempre, tranne su Haiku`)
      : bad(`${lang}: impegno mancante in ${senzaImpegno.length} casi`);
    stretti.length === 0
      ? ok(`${lang}: al titolo resta almeno ${Math.min(...esiti.map(e => e.titoloLargo))}px`)
      : bad(`${lang}: il titolo si riduce a ${Math.min(...stretti.map(e => e.titoloLargo))}px`);

    const tagliati = esiti.filter(e => e.modTagliato);
    info(`${lang}: il modello si accorcia in ${tagliati.length} casi su ${esiti.length}`
       + (tagliati.length ? ` (es. «${tagliati[0].testo}»)` : ''));
    const piuLungo = esiti.reduce((a, x) => (x.testo.length > a.testo.length ? x : a), esiti[0]);
    if (!peggio || piuLungo.testo.length > peggio.testo.length) peggio = piuLungo;
  }
  info('la combinazione più lunga in assoluto: «' + peggio.testo + '» (' + peggio.lang + ')');

  // Haiku: niente impegno, che è l'unica cosa onesta da mostrare
  const haiku = await b.evalJS(`(() => {
    S.chat.model = 'Haiku 4.5'; S.chat.effort = 'max';
    setChatSub('Haiku 4.5');
    const c = document.getElementById('modelBtn');
    return { testo: c.textContent.trim(), eff: !!c.querySelector('.mc-effort') };
  })()`);
  !haiku.eff ? ok(`Haiku non ha impegno e il chip non se lo inventa: «${haiku.testo}»`)
             : bad('il chip mostra un impegno per Haiku: ' + haiku.testo);

  const errs = b.consoleErrors.filter(e => !/favicon|manifest|icon-/.test(e));
  errs.length === 0 ? ok('zero errori in console') : bad(errs.length + ' errori in console');
  await b.evalJS(`(async () => { try { await Net.fetch('/api/forget', { method: 'POST',
    headers: { Authorization: 'Bearer ' + Net.token } }); } catch (e) {} })()`).catch(() => {});
  await b.kill();

  const failed = results.filter(r => r === 0).length;
  console.log('\n=== ' + (failed === 0
    ? 'tutti i controlli superati (' + results.length + ')'
    : failed + ' controlli falliti su ' + results.length) + ' ===');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('errore nella prova:', e); process.exit(2); });
