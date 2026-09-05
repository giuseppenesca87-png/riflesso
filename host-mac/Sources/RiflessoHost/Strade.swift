import Foundation

/// **Le due strade** con cui il telefono arriva al Mac, e quale mettere nel QR.
///
/// | dove | strada | indirizzo |
/// |---|---|---|
/// | in casa | rete locale | `http://<mac>.local:7654` — la piu' veloce, non esce di casa |
/// | fuori | ponte | l'indirizzo del proprio `bridge/` |
///
/// Erano tre fino al 04/09/2026: in mezzo c'era Tailscale, la strada diretta
/// in https. Tolta per scelta: non era in esecuzione, il ponte funziona da
/// qualunque rete, e ogni strada in piu' era un salto di origine in piu' (che
/// fra l'altro faceva perdere il permesso del microfono, vedi `app.js`).
///
/// **Il QR deve portare a un indirizzo che funzioni da qualunque rete.** Quindi
/// il ponte se e' configurato; altrimenti quello di casa — e in quel caso il
/// pannello dice che vale solo li'. Non c'e' un ripiego muto: cosa c'e' dentro
/// il QR sta scritto sotto il QR.
///
/// A ogni apertura la pagina chiede a chi la serve se e' il Mac: la sonda
/// `Net.probeDirect()` (webapp/net.js) riconosce il Mac dietro qualunque
/// indirizzo e in quel caso parla diretta, senza tubo.
enum Strade {
    enum Scelta: Equatable {
        /// Il ponte: `https://ponte.example`. Vale da qualunque rete.
        case ponte(String)
        /// La rete di casa: `http://mac.local:7654`. Vale solo li'.
        case casa(String)

        var base: String {
            switch self {
            case .ponte(let b), .casa(let b): return b
            }
        }

        /// L'indirizzo senza schema, per il pannello.
        var host: String {
            let b = base
            if let r = b.range(of: "://") { return String(b[r.upperBound...]) }
            return b
        }
    }

    /// La strada del QR, in ordine di portata: ponte, poi casa.
    static var perQR: Scelta {
        if RemoteLink.shared.canPair { return .ponte(RemoteLink.shared.baseURL) }
        return .casa(AppHub.shared.primaryURL)
    }

    /// L'indirizzo da mettere nel QR: link e codice insieme, cosi' si inquadra
    /// e si e' dentro. Il pezzo dopo il cancelletto e' l'unico di un indirizzo
    /// che il browser non spedisce **mai** a nessun server: il codice non passa
    /// dal ponte nemmeno qui.
    static var pairingURL: String {
        let pin = AuthStore.shared.currentPIN
        guard !pin.isEmpty else { return "" }
        return "\(perQR.base)/#p=\(pin)"
    }
}
