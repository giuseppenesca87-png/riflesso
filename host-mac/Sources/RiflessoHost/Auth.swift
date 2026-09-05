import Foundation

struct PairedDevice: Codable {
    var token: String
    var label: String
    var pairedAt: Date
    var lastSeenAt: Date
    /// Chi e' il browser, non chi lo usa: 128 bit a caso che restano nel
    /// telefono. Serve a una cosa sola — riconoscere che **e' lo stesso** e
    /// prendere il posto del suo accoppiamento vecchio invece di aggiungersi.
    /// Facoltativo: i record salvati prima che esistesse non ce l'hanno.
    var deviceId: String?
}

/// Codice di accoppiamento mostrato sul Mac -> token permanente salvato nel
/// browser. Tutto locale: nessun account, nessun server esterno.
///
/// **Otto cifre, non sei.** Il codice non apre solo la porta di casa: se c'e'
/// un ponte configurato apre anche la stanza dell'appuntamento sul punto
/// d'incontro (vedi `RemoteLink.derive(secret:kind:)`), che sta su un
/// indirizzo pubblico. Per chi legge le cifre sul Mac non cambia niente; per
/// chi tenta a caso il lavoro si moltiplica per cento.
///
/// Le altre difese:
/// · la stanza e' invisibile senza il codice giusto — chi non lo indovina non
///   trova nemmeno la porta a cui bussare;
/// · **i tentativi si contano**, da tutte le strade: dopo pochi errori il
///   codice si brucia, se ne genera un altro e lo si dice nel pannello;
/// · il freno per stanza e per indirizzo di provenienza sta sul ponte.
///
/// Il codice **non** si legge via HTTP: `GET /api/pin` e' stato tolto il
/// 03/09/2026 (dietro un inoltro lo leggeva chiunque). Chi ne ha bisogno passa
/// dal socket Unix di `PinSocket`.
final class AuthStore {
    static let shared = AuthStore()

    /// Quante cifre ha il codice. Sta qui perche' la webapp lo chiede a
    /// `/api/status`: un solo posto da cambiare, e niente `maxlength` sbagliati.
    static let pinDigits = 8

    /// Quanti errori si perdonano prima di bruciare il codice.
    private static let maxAttempts = 5

    private let queue = DispatchQueue(label: "riflesso.auth")
    private let defaultsKey = "riflesso.pairedDevices"
    /// Segreto del Mac da cui nasce **una sola** stanza sul ponte per tutti i
    /// telefoni. Si consegna all'accoppiamento; non e' il gettone, e non
    /// ruota da solo.
    private let meetKey = "riflesso.meetSecret"

    private var devices: [String: PairedDevice] = [:]
    private(set) var currentPIN: String = ""
    private var failedAttempts: Int = 0
    private var lockedUntil: Date = .distantPast
    private var note: String = ""

    /// **Il codice non scade da solo.** Prima si rinnovava ogni dieci minuti, e
    /// con lui cambiavano il QR e il link: chi si era salvato il collegamento se
    /// lo ritrovava morto, e il QR inquadrato un minuto prima non valeva piu'.
    /// Adesso resta quello finche' non lo cambi tu — con «Nuovo codice» o
    /// riavviando l'app. Cambia da solo in un caso soltanto, ed e' giusto che
    /// lo faccia: se qualcuno prova a indovinarlo, dopo cinque errori si brucia.

    /// Da quanto un telefono deve tacere prima di essere dimenticato. Lungo
    /// apposta: chi va in vacanza deve ritrovare il suo telefono al ritorno,
    /// senza rifare il giro del codice.
    private static let unusedLifetime: TimeInterval = 30 * 24 * 3600

    var onChange: (() -> Void)?
    /// Chi accoppia o scollega un telefono cambia l'elenco delle chiavi con
    /// cui il ponte apre le buste. La stanza del Mac resta la stessa: una sola.
    var onDevicesChanged: (() -> Void)?
    /// Il codice e' anche la chiave della stanza di accoppiamento sul ponte:
    /// quando cambia, quella stanza cambia con lui. E' un riavvio **solo** di
    /// quel canale, non dei telefoni gia' accoppiati.
    var onPINChanged: (() -> Void)?

    /// 32 byte a caso, in esadecimale: stesso formato del gettone, cosi' le tre
    /// derivazioni HKDF (Swift, browser, Node) lo trattano allo stesso modo.
    private(set) var meetSecret: String = ""

    /// Quando il segreto della stanza e' **rinato con dei telefoni gia'
    /// accoppiati**. E' il guasto del 04/09/2026: la stanza sul ponte e'
    /// `HKDF(meetSecret)`, quindi segreto nuovo vuol dire stanza nuova, e i
    /// telefoni accoppiati dal ponte bussano a una stanza dove non ascolta
    /// piu' nessuno — senza che il Mac scriva una riga. Si tiene la data,
    /// persistente: il guasto sopravvive al riavvio e l'avviso deve fare lo
    /// stesso. Sparisce quando ogni telefono si e' riaccoppiato dopo quella
    /// data, o quando lo si chiude dal pannello.
    private let meetRebornKey = "riflesso.meetSecret.rinatoIl"

    private init() {
        load()
        sweepStale()
        ensureMeetSecret()
        rotatePIN()
    }

    /// Si crea una volta e resta. Ruotarlo spezzerebbe tutti i telefoni gia'
    /// accoppiati dal ponte: lo si tocca solo se manca, mai «per sicurezza» a
    /// ogni avvio.
    ///
    /// **Se manca ma dei telefoni ci sono, non e' un primo avvio: e' un
    /// guasto**, e va scritto come tale. Prima questo caso finiva nel registro
    /// come un banale «creato», indistinguibile dalla prima volta, e il
    /// telefono restava fuori in silenzio per ore. Non si ripara da qui — il
    /// segreto vecchio non c'e' piu' — ma si smette di mentire: WARN nel
    /// registro e un riquadro nel pannello che dice cosa fare.
    private func ensureMeetSecret() {
        if let s = UserDefaults.standard.string(forKey: meetKey),
           s.count == 64,
           s.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil {
            meetSecret = s
            return
        }
        var raw = Data(count: 32)
        _ = raw.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        meetSecret = raw.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(meetSecret, forKey: meetKey)
        // `load()` e' gia' passato: `devices` dice se c'era qualcuno.
        let accoppiati = devices.count
        if accoppiati > 0 {
            UserDefaults.standard.set(Date(), forKey: meetRebornKey)
            Log.warn("segreto della stanza del Mac: RIGENERATO con \(accoppiati) telefono/i gia' accoppiati ·",
                     "la stanza sul ponte e' cambiata: i telefoni collegati dal ponte devono rifare il QR")
        } else {
            Log.info("segreto della stanza del Mac: creato (primo avvio, nessun telefono accoppiato)")
        }
    }

    /// Vero finche' c'e' un telefono accoppiato **prima** che il segreto
    /// rinascesse: e' lui che bussa alla stanza vecchia. Il pannello lo mostra.
    var meetSecretReborn: Bool {
        guard let at = UserDefaults.standard.object(forKey: meetRebornKey) as? Date else { return false }
        return queue.sync { devices.values.contains { $0.pairedAt < at } }
    }

    /// «Ho capito»: l'avviso si chiude a mano. Si chiude anche da solo, quando
    /// tutti i telefoni si sono riaccoppiati (vedi `meetSecretReborn`).
    func dismissMeetSecretReborn() {
        UserDefaults.standard.removeObject(forKey: meetRebornKey)
        DispatchQueue.main.async { self.onChange?() }
    }

    /// Un accoppiamento non usato per un mese non e' piu' un telefono: e' una
    /// riga in piu' nell'elenco, per un browser che non tornera'. Si passa una
    /// volta, all'avvio: l'app si riapre spesso, e non serve un orologio che
    /// gira per una pulizia cosi' lenta.
    @discardableResult
    func sweepStale() -> Int {
        let soglia = Date().addingTimeInterval(-Self.unusedLifetime)
        let via = queue.sync { () -> [PairedDevice] in
            let morti = devices.values.filter { $0.lastSeenAt < soglia }
            guard !morti.isEmpty else { return [] }
            for d in morti { devices.removeValue(forKey: d.token) }
            save()
            return morti
        }
        guard !via.isEmpty else { return 0 }
        for d in via { Log.info("accoppiamento scaduto, dimenticato:", d.label) }
        DispatchQueue.main.async { self.onChange?(); self.onDevicesChanged?() }
        return via.count
    }

    // MARK: - Il codice

    @discardableResult
    func rotatePIN() -> String {
        let digits = queue.sync { () -> String in
            currentPIN = Self.freshDigits()
            failedAttempts = 0
            lockedUntil = .distantPast
            return currentPIN
        }
        announcePINChange()
        return digits
    }

    /// Cifre da `SecRandomCopyBytes` e non da `Int.random`: e' un segreto, e il
    /// modulo si prende senza sbilanciare le cifre (256 non e' multiplo di 10,
    /// quindi i resti oltre 250 si scartano).
    private static func freshDigits() -> String {
        var out = ""
        while out.count < pinDigits {
            var byte: UInt8 = 0
            guard SecRandomCopyBytes(kSecRandomDefault, 1, &byte) == errSecSuccess else {
                out += String(Int.random(in: 0...9))
                continue
            }
            if byte >= 250 { continue }
            out += String(Int(byte) % 10)
        }
        return out
    }

    /// Cosa e' successo all'ultimo codice, se vale la pena dirlo nel pannello.
    var pinNote: String { queue.sync { note } }

    /// Il codice si brucia e se ne fa un altro. Si dice sul Mac: chi sta
    /// digitando deve capire perche' le cifre non vanno piu' bene.
    func burnPIN(why: String) {
        queue.sync {
            currentPIN = Self.freshDigits()
            failedAttempts = 0
            note = why
        }
        Log.warn("codice bruciato:", why)
        announcePINChange()
    }

    private func announcePINChange() {
        DispatchQueue.main.async { self.onChange?(); self.onPINChanged?() }
    }

    enum PairResult {
        case ok(token: String)
        case wrongPIN(remaining: Int)
        case expired
        case locked(seconds: Int)
    }

    func pair(pin: String, label: String, deviceId: String? = nil) -> PairResult {
        var burnReason: String?
        let result: PairResult = queue.sync {
            let now = Date()
            if now < lockedUntil {
                return .locked(seconds: Int(lockedUntil.timeIntervalSince(now)) + 1)
            }
            // Confronto a tempo costante: il codice e' corto, non regaliamo timing.
            let a = Array(pin.utf8), b = Array(currentPIN.utf8)
            var diff = a.count ^ b.count
            for i in 0..<min(a.count, b.count) { diff |= Int(a[i] ^ b[i]) }
            guard diff == 0 else {
                failedAttempts += 1
                if failedAttempts >= Self.maxAttempts {
                    lockedUntil = now.addingTimeInterval(60)
                    // Non basta aspettare un minuto: il codice tentato **si
                    // butta**. Chi provava a indovinare ricomincia da zero, e
                    // sul Mac compaiono cifre nuove.
                    burnReason = "pin.burned_guesses"
                    return .locked(seconds: 60)
                }
                return .wrongPIN(remaining: Self.maxAttempts - failedAttempts)
            }

            var raw = Data(count: 32)
            _ = raw.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
            let token = raw.map { String(format: "%02x", $0) }.joined()
            // Lo stesso telefono resta **uno**. Riaccoppiarsi generava ogni
            // volta un gettone nuovo che si sedeva accanto al vecchio: dopo
            // quattro giri il pannello diceva «4 dispositivi» ed era sempre lo
            // stesso iPhone. Chi si ripresenta con la stessa identita' prende
            // il posto di prima.
            let id = deviceId.flatMap { $0.isEmpty ? nil : $0 }
            if let id {
                for (k, d) in devices where d.deviceId == id { devices.removeValue(forKey: k) }
            }
            devices[token] = PairedDevice(token: token,
                                          label: label.isEmpty ? "Dispositivo" : String(label.prefix(60)),
                                          pairedAt: now, lastSeenAt: now, deviceId: id)
            save()
            // **Il codice non e' piu' monouso.** Rigenerarlo a ogni
            // accoppiamento riuscito cambiava QR e link sotto gli occhi: il
            // telefono appena entrato stava bene, ma il collegamento salvato
            // altrove smetteva di funzionare. Resta valido finche' non lo
            // cambi tu.
            failedAttempts = 0
            note = ""
            return .ok(token: token)
        }

        if let burnReason {
            burnPIN(why: burnReason)
            return result
        }
        if case .ok = result {
            // Un telefono in piu' cambia le chiavi del ponte; il codice invece
            // non cambia (non e' piu' monouso), quindi la stanza del codice
            // resta quella ed e' giusto non riaprirla.
            DispatchQueue.main.async { self.onChange?(); self.onDevicesChanged?() }
        }
        return result
    }

    // MARK: - Token

    func isValid(token: String?) -> Bool {
        guard let token, !token.isEmpty else { return false }
        return queue.sync {
            guard var d = devices[token] else { return false }
            d.lastSeenAt = Date()
            devices[token] = d
            return true
        }
    }

    func device(for token: String) -> PairedDevice? {
        queue.sync { devices[token] }
    }

    var pairedCount: Int { queue.sync { devices.count } }

    var pairedList: [PairedDevice] {
        queue.sync { devices.values.sorted { $0.lastSeenAt > $1.lastSeenAt } }
    }

    /// Scollega **un** dispositivo, quello che lo chiede. Serve al telefono che
    /// dice «dimentica questo dispositivo» e alle prove, che cosi' si portano via
    /// il finto che hanno creato invece di lasciarlo nell'elenco di chi usa
    /// l'app. Non tocca gli altri: «Scollega tutti» resta un'altra cosa.
    @discardableResult
    func revoke(token: String) -> Bool {
        let removed = queue.sync { () -> Bool in
            guard devices.removeValue(forKey: token) != nil else { return false }
            save()
            return true
        }
        guard removed else { return false }
        DispatchQueue.main.async { self.onChange?(); self.onDevicesChanged?() }
        return true
    }

    func revokeAll() {
        queue.sync {
            devices.removeAll()
            save()
        }
        DispatchQueue.main.async { self.onChange?(); self.onDevicesChanged?() }
    }

    // MARK: - Persistenza

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let list = try? JSONDecoder().decode([PairedDevice].self, from: data) else { return }
        devices = Dictionary(uniqueKeysWithValues: list.map { ($0.token, $0) })
    }

    private func save() {
        let list = Array(devices.values)
        if let data = try? JSONEncoder().encode(list) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}
