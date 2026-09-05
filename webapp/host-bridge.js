'use strict';

/* ------------------------------------------------------------------
   Il ponte, lato Mac. Gira in una WKWebView dentro Riflesso.

   Riceve dall'app (Swift) un'offerta già aperta e verificata, risponde, e
   quando il canale si apre fa da postino verso il server locale sulla 7654.

   Tre regole di sicurezza, scritte qui perché è qui che si applicano:

   1. **Chi arriva dal tubo non è «questo Mac».** Ogni richiesta inoltrata
      porta `X-Riflesso-Via: webrtc`: l'host la registra come arrivata dal
      ponte e non le dà nessun privilegio di 127.0.0.1 (oggi non ne esistono
      più — `GET /api/pin` è stato tolto il 03/09/2026 — ma la marca resta,
      così un privilegio futuro non passerebbe di qui per sbaglio).
   2. `/api/pin` **non si inoltra comunque**: l'endpoint non c'è più, e questo
      è il secondo lucchetto sulla stessa porta. Si inoltra solo ciò che serve
      (`/api/…`, `/health`, la conversazione dal vivo). I file della webapp li
      dà il punto d'incontro: qui non passano.
   3. **Un canale aperto col codice sa fare una cosa sola: accoppiarsi.** La
      stanza dell'accoppiamento è pubblica quanto l'indirizzo del ponte, quindi
      chi entra da lì può chiamare `/api/pair` e nient'altro — niente elenco
      chat, niente conversazioni, niente diretta. Appena ha il gettone rientra
      dalla porta di sempre.
------------------------------------------------------------------ */

(function () {
  const K = Tunnel.KIND;
  const post = (o) => { try { window.webkit.messageHandlers.rf.postMessage(JSON.stringify(o)); } catch (e) {} };

  let pc = null, dc = null, ws = null;
  // `device` (gettone) o `pair` (codice). Lo decide Swift, non chi bussa.
  let kind = 'device';
  // Ogni collegamento ha il suo numero. Gli eventi di quello vecchio arrivano
  // **dopo** che il nuovo è già nato — chiudere una connessione fa scattare
  // `onclose` al giro dopo — e senza questo numero il vecchio si porterebbe
  // dietro il nuovo. È costato una serata di guasti a intermittenza.
  let gen = 0;
  // Oltre questa coda i fotogrammi dello specchio si buttano: meglio saltarne
  // uno che accumulare secondi di ritardo. Le risposte dell'API non si buttano.
  const MAX_QUEUE = 256 * 1024;

  /** Cosa si può chiedere al Mac da dentro il canale. Funzione **pura** di
      percorso e modalità: così la politica si guarda tutta insieme, e si può
      controllare senza dover ricreare un collegamento (`tools/remotetest.js`).

      | percorso   | col gettone | col codice |
      |------------|-------------|------------|
      | /api/pair  | sì          | sì         |
      | /api/…     | sì          | **no**     |
      | /health    | sì          | **no**     |
      | /api/pin   | **no**      | **no**     | */
  function allowed(path, k) {
    if (typeof path !== 'string' || path[0] !== '/' || path.includes('..')) return false;
    if (path === '/api/pin' || path.startsWith('/api/pin?')) return false;
    if ((k || kind) === 'pair') return path === '/api/pair';
    return path.startsWith('/api/') || path === '/health';
  }

  /* ---------- la risposta all'offerta ---------- */

  window.RB = {};

  window.RB.answer = async function (offerSdp, iceServers, linkKind) {
    // `null`: sostituire il vecchio collegamento **non** è una caduta. Se lo
    // annunciassimo come tale, l'app spegnerebbe la WebView tre secondi dopo —
    // cioè proprio mentre il collegamento nuovo si sta aprendo.
    close(null);
    kind = linkKind === 'pair' ? 'pair' : 'device';
    const my = ++gen;
    const mine = () => my === gen;

    const peer = new RTCPeerConnection({ iceServers: iceServers || [], bundlePolicy: 'max-bundle' });
    pc = peer;

    peer.oniceconnectionstatechange = () => {
      if (!mine()) return;
      post({ t: 'ice', v: peer.iceConnectionState });
      if (peer.iceConnectionState === 'failed') close('ice fallito');
    };
    peer.ondatachannel = (e) => {
      if (!mine()) return;
      dc = e.channel;
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => { if (mine()) post({ t: 'open' }); };
      dc.onclose = () => { if (!mine()) return; post({ t: 'closed' }); close('canale chiuso'); };
      wire(dc);
    };

    await peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await peer.setLocalDescription(await peer.createAnswer());
    await new Promise((r) => {
      if (peer.iceGatheringState === 'complete') return r();
      const t = setTimeout(r, 3000);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(t); r(); }
      });
    });
    if (!mine()) throw new Error('superseded');
    return peer.localDescription.sdp;
  };

  window.RB.close = () => close('richiesto');

  /// La politica di inoltro, esposta perché sia controllabile invece che
  /// creduta sulla parola. Questa pagina la carica solo il Mac, da 127.0.0.1.
  window.RB.allowed = allowed;

  /// Si staccano **prima** le orecchie, poi si chiude: un `onclose` che scatta
  /// mentre stiamo già montando il collegamento nuovo lo spegnerebbe appena
  /// nato.
  function close(why) {
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; }
    if (dc) { dc.onopen = dc.onclose = dc.onmessage = null; try { dc.close(); } catch (e) {} dc = null; }
    if (pc) {
      pc.ondatachannel = null;
      pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch (e) {}
      pc = null;
    }
    if (why) post({ t: 'down', why });
  }

  /* ---------- il postino ---------- */

  function wire(channel) {
    const reader = new Tunnel.Reader();
    channel.onmessage = (ev) => {
      const msg = reader.push(ev.data);
      if (!msg) return;
      if (msg.kind === K.REQ) return doRequest(msg.id, JSON.parse(Tunnel.text(msg.bytes)));
      if (msg.kind === K.WS_TEXT) { if (ws && ws.readyState === 1) ws.send(Tunnel.text(msg.bytes)); return; }
      if (msg.kind === K.CTL) {
        const c = JSON.parse(Tunnel.text(msg.bytes));
        if (c.c === 'wsopen') openWS(c.token);
        if (c.c === 'wsclose' && ws) { try { ws.close(); } catch (e) {} ws = null; }
      }
    };
  }

  async function doRequest(id, req) {
    const reply = (o) => { if (dc && dc.readyState === 'open') Tunnel.send(dc, K.RES, id, JSON.stringify(o)); };
    if (!allowed(req.p)) return reply({ s: 403, ct: 'application/json', enc: 't', b: '{"ok":false,"code":"not_forwardable"}' });

    try {
      const headers = Object.assign({}, req.h || {}, { 'X-Riflesso-Via': 'webrtc' });
      const res = await fetch(req.p, {
        method: req.m || 'GET',
        headers,
        body: req.b != null ? req.b : undefined,
        cache: 'no-store',
      });
      const ct = res.headers.get('content-type') || '';
      const testo = /^(text\/|application\/json|application\/javascript)/i.test(ct);
      if (testo) {
        reply({ s: res.status, ct, enc: 't', b: await res.text() });
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        reply({ s: res.status, ct, enc: 'b64', b: Tunnel.toBase64(buf) });
      }
    } catch (e) {
      reply({ s: 502, ct: 'application/json', enc: 't', b: '{"ok":false,"code":"mac-timeout"}' });
    }
  }

  function openWS(token) {
    // Dalla stanza dell'accoppiamento la diretta non si apre: senza gettone
    // l'host risponderebbe 401 comunque, ma la porta non si bussa nemmeno.
    if (kind === 'pair') return;
    if (ws) { try { ws.close(); } catch (e) {} }
    ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token || '')}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      post({ t: 'ws', v: 'aperto' });
      if (dc && dc.readyState === 'open') Tunnel.send(dc, K.CTL, 0, JSON.stringify({ c: 'wsopen' }));
    };
    ws.onmessage = (ev) => {
      if (!dc || dc.readyState !== 'open') return;
      if (typeof ev.data === 'string') { Tunnel.send(dc, K.WS_TEXT, 0, ev.data); return; }
      if (dc.bufferedAmount > MAX_QUEUE) return;   // fotogramma saltato, non accodato
      Tunnel.send(dc, K.WS_BIN, 0, new Uint8Array(ev.data));
    };
    ws.onclose = (ev) => {
      post({ t: 'ws', v: 'chiuso' });
      if (dc && dc.readyState === 'open') {
        Tunnel.send(dc, K.CTL, 0, JSON.stringify({ c: 'wsclose', code: ev.code }));
      }
    };
  }

  // Se WebKit cambia idea sulla visibilità di questa pagina lo si dice a
  // Swift, che lo scrive nel registro: è il primo indizio da guardare quando
  // il tubo tace (SONNO-FATTO.md). Con la cura di RemoteLink la pagina nasce
  // `visible` pur stando in una finestra fuori schermo, e deve restare tale.
  document.addEventListener('visibilitychange', () => post({ t: 'vis', v: document.visibilityState }));

  post({ t: 'ready', rtc: typeof RTCPeerConnection === 'function', secure: window.isSecureContext,
         vis: document.visibilityState });
})();
