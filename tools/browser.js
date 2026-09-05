'use strict';

/* Chrome pilotato dal suo protocollo di debug. Nessuna dipendenza:
   il WebSocket e' quello di Node 20, dietro --experimental-websocket. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve(__dirname, '..', 'test-output');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
          setTimeout(() => {
            if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); }
          }, 30000);
        });
      },
      on(fn) { listeners.push(fn); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(new Error('WebSocket: ' + (e.message || 'errore')));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else {
        listeners.forEach(f => f(m));
      }
    };
  });
}

/** Apre Chrome a misura di iPhone e restituisce gli attrezzi per pilotarlo. */
async function launch(url, opts = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const port = opts.port || (9300 + Math.floor(Math.random() * 90));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'riflesso-chrome-'));

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=402,874',
    ...(opts.args || []),
    url,
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* non ancora pronto */ }
  }
  if (!target) { chrome.kill(); throw new Error('Chrome non si e\' aperto'); }

  const cdp = await connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const exceptions = [];
  cdp.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleErrors.push(m.params.type + ': ' +
        m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push('log: ' + m.params.entry.text);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 402, height: 874, deviceScaleFactor: 3, mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const evalJS = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    return 'test-output/' + name;
  };

  const goto = async (u) => { await cdp.send('Page.navigate', { url: u }); };

  const kill = async () => {
    try { cdp.close(); } catch (e) {}
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  };

  return { cdp, evalJS, shot, goto, kill, consoleErrors, exceptions, OUT };
}

module.exports = { launch, sleep, OUT };
