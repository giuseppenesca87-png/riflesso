import Foundation

/// `--print-pin` chiede il PIN **all'istanza gia' in esecuzione** e se ne va.
///
/// Prima faceva l'opposto: avviava una seconda copia dell'app, che stampava il
/// PIN di se stessa e poi restava li' a litigare sulla porta 7654
/// (*Address already in use*). Poi ha chiesto a `GET /api/pin` su 127.0.0.1 —
/// e quell'endpoint e' stato tolto il 03/09/2026, perche' dietro
/// `tailscale serve` lo leggeva chiunque nella tailnet. Adesso passa dal
/// socket Unix riservato a questo utente: vedi `PinSocket`.
enum PinClient {

    /// Stampa `PIN=xxxxxxxx` su stdout. Torna il codice di uscita del processo.
    static func printPIN(timeout: TimeInterval = 3) -> Int32 {
        let r = PinSocket.ask(timeout: timeout)
        guard let payload = r.payload, let pin = payload["pin"] as? String, !pin.isEmpty else {
            let why = r.failure ?? "PIN non disponibile"
            FileHandle.standardError.write(Data(
                "Riflesso non è in esecuzione (\(why)). Avvialo con: open -a Riflesso\n".utf8))
            return 1
        }
        print("PIN=\(pin)")
        // Il codice c'e' anche a servizio spento, ma non apre niente: si dice,
        // invece di lasciar battere otto cifre contro una porta chiusa.
        if (payload["service"] as? Bool) == false {
            FileHandle.standardError.write(Data(
                "Attenzione: il servizio è spento — il telefono non entra finché non lo riaccendi dal pannello.\n".utf8))
        }
        fflush(stdout)
        return 0
    }
}
