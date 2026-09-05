'use strict';

/* ------------------------------------------------------------------
   Il tubo: come sono fatti i messaggi dentro il DataChannel.

   Lo usano tutte e due le parti — il telefono (net.js) e la pagina ponte
   che gira dentro il Mac (host-bridge.js) — quindi sta qui, in un file solo.

   Un messaggio SCTP può viaggiare sicuro fino a 64 KB, e una finestra di
   conversazione ne pesa già 64: i messaggi si **spezzano** a 16 KB, che passa
   ovunque. Intestazione di 8 byte:

     0     tipo      1 richiesta · 2 risposta · 3 testo WS · 4 binario WS · 5 servizio
     1     bandiere  bit0 = ultimo pezzo
     2-3   id        a quale messaggio appartiene il pezzo
     4-5   pezzo     numero progressivo
     6-7   riservati
------------------------------------------------------------------ */

(function (global) {
  const HDR = 8;
  const CHUNK = 16000;

  const KIND = { REQ: 1, RES: 2, WS_TEXT: 3, WS_BIN: 4, CTL: 5 };

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function pack(kind, id, seq, last, payload) {
    const out = new Uint8Array(HDR + payload.length);
    const v = new DataView(out.buffer);
    v.setUint8(0, kind);
    v.setUint8(1, last ? 1 : 0);
    v.setUint16(2, id & 0xffff);
    v.setUint16(4, seq & 0xffff);
    out.set(payload, HDR);
    return out;
  }

  /** Spedisce un messaggio, spezzandolo se serve. I pezzi partono tutti di
      seguito senza attese in mezzo: così non si intrecciano con altri. */
  function send(dc, kind, id, payload) {
    const bytes = typeof payload === 'string' ? enc.encode(payload)
      : (payload instanceof Uint8Array ? payload : new Uint8Array(payload));
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let i = 0; i < total; i++) {
      const part = bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bytes.length));
      dc.send(pack(kind, id, i, i === total - 1, part));
    }
  }

  /** Rimette insieme i pezzi. Ritorna il messaggio completo, o null. */
  class Reader {
    constructor() { this.parts = new Map(); }

    push(data) {
      const bytes = new Uint8Array(data);
      if (bytes.length < HDR) return null;
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const kind = v.getUint8(0);
      const last = (v.getUint8(1) & 1) === 1;
      const id = v.getUint16(2);
      const body = bytes.subarray(HDR);

      if (last) {
        const key = kind + ':' + id;
        const held = this.parts.get(key);
        if (!held) return { kind, id, bytes: body };
        this.parts.delete(key);
        held.push(body);
        return { kind, id, bytes: join(held) };
      }
      const key = kind + ':' + id;
      if (!this.parts.has(key)) this.parts.set(key, []);
      this.parts.get(key).push(body);
      return null;
    }
  }

  function join(list) {
    let n = 0;
    for (const p of list) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of list) { out.set(p, o); o += p.length; }
    return out;
  }

  const text = (bytes) => dec.decode(bytes);

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function fromBase64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  global.Tunnel = { KIND, CHUNK, send, Reader, text, toBase64, fromBase64, enc, dec };
})(window);
