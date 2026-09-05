'use strict';

/* ------------------------------------------------------------------
   Il codice di accoppiamento, per i collaudi.

   Prima si leggeva da `GET /api/pin`. Quell'endpoint non c'e' piu'
   (03/09/2026): con `tailscale serve` davanti alla 7654 lo leggeva chiunque
   nella tailnet. Adesso lo chiede `Riflesso --print-pin`, che parla con
   l'app in esecuzione su un socket Unix riservato a questo utente.

   `RIFLESSO_PIN` nell'ambiente vince, cosi' `autotest.sh` puo' passare quello
   che ha gia'; `RIFLESSO_BIN` sceglie un altro binario (quello di debug).
------------------------------------------------------------------ */

const { execFileSync } = require('child_process');

const BIN = process.env.RIFLESSO_BIN || '/Applications/Riflesso.app/Contents/MacOS/Riflesso';

function pin() {
  if (process.env.RIFLESSO_PIN) return process.env.RIFLESSO_PIN;
  let out = '';
  try {
    out = execFileSync(BIN, ['--print-pin'], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = (e.stderr || e.message || '').toString().trim();
    throw new Error('Riflesso --print-pin non ha risposto: ' + err);
  }
  const m = out.match(/PIN=(\d+)/);
  if (!m) throw new Error('Riflesso --print-pin non ha stampato il codice: ' + out.trim());
  return m[1];
}

module.exports = { pin, BIN };
