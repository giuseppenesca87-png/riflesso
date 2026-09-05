#!/usr/bin/env node --experimental-websocket
'use strict';

/* ------------------------------------------------------------------
   IL SONNO, MISURATO LUNGO — chat DIVERSE dopo 20 s, 3 min e 10 min di
   silenzio, dal ponte vero, come da fuori casa.

   È la variante lunga di `sonnorepro.js`, con la stessa trappola evitata:
   riaprire la STESSA chat non vale (la webapp la tiene in memoria e risponde
   in 3 ms senza toccare il Mac), quindi ogni colpo apre una conversazione
   diversa (indici 0,1,2 subito, poi 3, 4, 5 dopo le tre attese). Ogni colpo
   aspetta al massimo 20 s; dopo un colpo muto se ne fa subito un secondo,
   per vedere se il tubo si è riaperto da solo (il telefono, accorgendosi che
   ICE è caduto, rifà l'offerta).

   Prima di ogni colpo stampa anche il processo WebContent del Mac (stato,
   priorità, memoria) trovato col processo responsabile — è lì che si vede il
   sonno: la priorità scende a 20 e la memoria cala.

      node tools/sonnolungo.js                    # attese 20 s, 3 min, 10 min
      node tools/sonnolungo.js --attese 20,60     # attese a scelta, in secondi
------------------------------------------------------------------ */

const { spawnSync } = require('child_process');
const path = require('path');
const { launch, sleep } = require('./browser');
const { pin } = require('./pin');

const LOCAL = 'http://127.0.0.1:7654';
const args = process.argv.slice(2);
const ATTESE = (args.includes('--attese') ? args[args.indexOf('--attese') + 1] : '20,180,600')
  .split(',').map((s) => Number(s)).filter((n) => n > 0);

const ora = () => new Date().toTimeString().slice(0, 8);
const j = async (p, o = {}) => { const r = await fetch(LOCAL + p, o); return { s: r.status, b: await r.json().catch(() => null) }; };

/** Il WebContent del Mac, come lo vede `ps`: pid, stato, %cpu, priorità, rss. */
function webContentDelMac() {
  const py = `
import ctypes, subprocess
lib = ctypes.CDLL('/usr/lib/system/libquarantine.dylib')
f = lib.responsibility_get_pid_responsible_for_pid; f.restype = ctypes.c_int; f.argtypes = [ctypes.c_int]
out = subprocess.check_output(['ps', '-axo', 'pid=,stat=,%cpu=,pri=,rss=,etime=,comm=']).decode()
names = {}
for l in out.splitlines():
    p = l.split(None, 6); names[int(p[0])] = p[6]
for l in out.splitlines():
    p = l.split(None, 6)
    if 'WebKit.WebContent' not in p[6]: continue
    r = f(int(p[0]))
    if names.get(r, '').endswith('/Riflesso'):
        print(f"pid {p[0]} stat {p[1]} cpu {p[2]} pri {p[3]} rss {int(p[4])//1024}MB su {p[5]}")
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '').trim().split('\n').filter(Boolean).join(' · ') || 'nessun WebContent di Riflesso';
}

(async () => {
  const code = pin();
  const pr = await j('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: code, label: 'prova-sonno-lungo', id: 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1' }) });
  const tok = pr.b && pr.b.token;
  if (!tok) { console.log('accoppiamento di prova fallito: ' + JSON.stringify(pr.b)); process.exit(1); }
  const base = (((await j('/api/remote', { headers: { Authorization: 'Bearer ' + tok } })).b || {}).base || '').replace(/\/+$/, '');
  await j('/api/forget', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
  if (!base) { console.log('nessun ponte configurato'); process.exit(1); }
  console.log(`${ora()} ponte ${base} · attese ${ATTESE.map((s) => s >= 60 ? (s / 60) + ' min' : s + ' s').join(', ')}`);

  const b = await launch(`${base}/#p=${code}`);
  let pronta = null;
  for (let i = 0; i < 120; i++) {
    pronta = await b.evalJS(`({s:(document.querySelector('.screen:not(.hidden)')||{}).id,n:S.chats.length,ws:!!(S.ws&&S.ws.readyState===1)})`).catch(() => null);
    if (pronta && pronta.s === 'list' && pronta.n > 0 && pronta.ws) break;
    await sleep(500);
  }
  if (!(pronta && pronta.s === 'list')) { console.log('non si è collegata: ' + JSON.stringify(pronta)); await b.kill(); process.exit(1); }
  console.log(`${ora()} collegata dal ponte · ${pronta.n} conversazioni · ${webContentDelMac()}`);

  const apri = async (etichetta, quale) => {
    const r = await b.evalJS(`(async () => {
      const t0 = performance.now();
      const righe = document.querySelectorAll('.chatrow');
      const quale = QUALE;
      if (!righe.length) return { errore: 'nessuna riga' };
      righe[Math.min(quale, righe.length - 1)].click();
      for (let i = 0; i < 100; i++) {
        const bolle = document.querySelectorAll('#chat .msg, #chat .bubble, #chatBody > *').length;
        if (bolle > 0) return { ms: Math.round(performance.now() - t0), bolle, stato: Net.state, dove: Net.where };
        await new Promise(r => setTimeout(r, 200));
      }
      return { scaduta: true, ms: Math.round(performance.now() - t0), stato: Net.state, dove: Net.where,
               ws: !!(S.ws && S.ws.readyState === 1), cronaca: Net.trace.slice(-4) };
    })()`.replace('QUALE', String(quale))).catch((e) => ({ morto: e.message }));
    console.log(`${ora()}   ${etichetta}: ${JSON.stringify(r)}`);
    await b.evalJS(`(document.getElementById('backBtn')||{click(){}}).click()`).catch(() => {});
    await sleep(600);
    return r;
  };

  await apri('chat n.1, subito', 0);
  await apri('chat n.2, subito dopo', 1);
  await apri('chat n.3, subito dopo', 2);
  let n = 3;
  const esiti = [];
  for (const s of ATTESE) {
    const eti = s >= 60 ? `${s / 60} min` : `${s} s`;
    console.log(`${ora()} … silenzio per ${eti}`);
    await sleep(s * 1000);
    console.log(`${ora()}   Mac prima del colpo: ${webContentDelMac()}`);
    const r = await apri(`chat n.${n + 1}, dopo ${eti} di silenzio`, n);
    n++;
    esiti.push({ attesa: eti, ok: !!r.ms && !r.scaduta && !r.errore, ms: r.ms });
    if (r.scaduta || r.errore || r.morto) {
      const r2 = await apri(`  secondo tentativo (chat n.${n + 1})`, n);
      n++;
      esiti.push({ attesa: eti + ' (2º tentativo)', ok: !!r2.ms && !r2.scaduta && !r2.errore, ms: r2.ms });
    }
  }
  await b.evalJS(`(async()=>(await Net.fetch('/api/forget',{method:'POST',headers:{Authorization:'Bearer '+Net.token}})).status)()`).catch(() => {});
  await b.kill();
  console.log(`\n${ora()} riepilogo: ` + esiti.map((e) => `${e.attesa} → ${e.ok ? e.ms + ' ms' : 'MUTA'}`).join(' · '));
  process.exit(esiti.every((e) => e.ok) ? 0 : 1);
})().catch((e) => { console.error('errore:', e.message); process.exit(2); });
