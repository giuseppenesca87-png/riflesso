import Foundation
import CryptoKit
import WebKit
import AppKit

/// Il punto d'incontro, lato Mac: la strada di fuori casa, quella che non
/// chiede di accendere niente sul telefono. Tolto il 03/09/2026 e rimesso il
/// 04/09: Riflesso viene regalato, e fuori casa deve funzionare da qualunque
/// rete, senza VPN.
///
/// Tre pezzi, e ognuno sta dove costa meno:
///
/// 1. **Ad aspettare è Swift**, non la pagina: `URLSession` tiene una richiesta
///    lunga aperta alla cassetta del punto d'incontro. La WebView nasce solo
///    quando c'è davvero un'offerta — ma **non basta a tenerla sveglia**: una
///    pagina che WebKit considera nascosta viene messa a dormire dopo otto
///    secondi, non dopo ore, e il canale WebRTC muore con lei. Misurato il
///    05/09/2026, cura e numeri in `BridgePeer.ensureWebView` e in
///    `SONNO-FATTO.md`.
/// 2. **Le chiavi stanno qui.** Al punto d'incontro arrivano buste chiuse: nome
///    della stanza e chiave escono da un segreto, passato per HKDF.
/// 3. **Il WebRTC lo fa WebKit**, che è già dentro macOS: nessun eseguibile in
///    più nel pacchetto. Il perché, con i numeri, sta in `docs/10-FUORICASA.md`.
///
/// ## Due porte, non una
///
/// | stanza | segreto | chi entra | cosa può fare |
/// |---|---|---|---|
/// | `.device` | il **segreto del Mac** (`meet`) | un telefono già accoppiato | tutto |
/// | `.pair` | il codice a otto cifre | chiunque legga il codice | **solo** accoppiarsi |
///
/// La stanza dei telefoni accoppiati è **una sola per Mac**, non una per
/// gettone: una attesa, qualunque sia il numero di telefoni. Chi bussa sta
/// dentro la busta, come identificatore opaco (`HKDF(gettone, "id")`). La
/// busta resta cifrata **col gettone di quel telefono**, così uno non legge
/// il traffico dell'altro. Il codice non si tocca: da lì si può fare solo
/// `/api/pair`.
final class RemoteLink: NSObject, @unchecked Sendable {
    static let shared = RemoteLink()

    /// L'indirizzo di partenza del ponte. **Nel codice e' vuoto**: Riflesso e'
    /// regalato, e ognuno mette il ponte sulla propria macchina (`bridge/`),
    /// poi scrive l'indirizzo nel pannello, dietro la riga «Ponte». Una build
    /// puo' portarsi dietro il suo — `RiflessoBridgeDefault` nell'`Info.plist`,
    /// che `build.sh` riempie da `host-mac/local.env`, un file fuori dal
    /// repository — cosi' chi compila per se' non deve riscriverlo a ogni
    /// installazione. `register` non sovrascrive niente: se l'indirizzo e' gia'
    /// stato scelto (anche vuoto, a mano) resta quello.
    static let defaultBase: String = {
        let s = (Bundle.main.object(forInfoDictionaryKey: "RiflessoBridgeDefault") as? String) ?? ""
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        // Il segnaposto lasciato da una build senza `local.env` non e' un indirizzo.
        return t.hasPrefix("https://") ? t : ""
    }()

    fileprivate static let salt = Data("riflesso.rendezvous.v1".utf8)
    fileprivate static let magic: [UInt8] = [0x52, 0x46, 0x31]   // "RF1"

    /// Quale delle due porte. Il valore va anche nella busta e nella pagina
    /// ponte: un canale aperto col codice non deve poter fare altro che
    /// accoppiarsi.
    enum Kind: String {
        case device
        case pair

        /// Le due etichette di HKDF. Restano **identiche** a com'erano: le tre
        /// implementazioni (Swift, browser, Node) devono continuare a coincidere.
        var roomInfo: String { self == .device ? "room" : "room.pair" }
        var sealInfo: String { self == .device ? "seal" : "seal.pair" }
    }

    /// Solo per scoprire il proprio indirizzo pubblico: da qui non passa
    /// traffico. TURN — il rimbalzo — resta spento: `docs/10-FUORICASA.md` §6.
    ///
    /// **Tre server di tre padroni diversi.** C'erano `stun.l.google.com` e
    /// `stun1.l.google.com`, che sono **lo stesso server** (74.125.250.129 /
    /// 2001:4860:4864:5:8000::1): un punto solo di rottura travestito da due.
    /// Gli altri due sono misurati funzionanti su IPv4 e IPv6 il 04/09/2026
    /// (`tools/icecheck.js --stun`). La stessa lista sta in `webapp/net.js`.
    private static let stun = ["stun:stun.l.google.com:19302",
                               "stun:stun.nextcloud.com:3478",
                               "stun:stun.sipgate.net:3478"]

    private let q = DispatchQueue(label: "riflesso.remote")
    /// Una attesa per tutti i telefoni accoppiati. Non una per gettone.
    private var hostWaiter: MailboxWaiter?
    /// Sessioni WebRTC vive, una per gettone, create solo quando arriva
    /// un'offerta. Non tengono aperta nessuna richiesta al ponte.
    private var sessions: [String: BridgePeer] = [:]
    /// La seconda porta: una sola, e cambia ogni volta che cambia il codice.
    private var pairWaiter: MailboxWaiter?
    private var pairPeer: BridgePeer?
    private var seenNonces: [String: Date] = [:]
    private var lastError = ""

    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 70
        c.waitsForConnectivity = false
        // Restano due attese lunghe (stanza del Mac + stanza del codice) più
        // le POST delle risposte. Il tetto predefinito di 6 basta; si lascia
        // un po' di margine per la sonda `/health` e un ritardo di chiusura.
        c.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: c)
    }()

    var onStateChange: (() -> Void)?

    // MARK: - Impostazioni

    private let baseKey = "riflesso.remote.base"
    private let onKey = "riflesso.remote.enabled"

    override init() {
        super.init()
        // `register` non sovrascrive niente: una scelta gia' fatta — anche
        // «spento» — resta. Serve solo a non far partire l'app con la casella
        // vuota quando la build un indirizzo ce l'ha.
        UserDefaults.standard.register(defaults: [
            baseKey: Self.defaultBase,
            onKey: true,
        ])
    }

    /// L'indirizzo del punto d'incontro, per esempio `https://xxx.deno.dev`.
    var baseURL: String {
        get { UserDefaults.standard.string(forKey: baseKey) ?? "" }
        set {
            var cleaned = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            while cleaned.hasSuffix("/") { cleaned.removeLast() }
            UserDefaults.standard.set(cleaned, forKey: baseKey)
            restart()
        }
    }

    /// **Acceso e basta.** Aveva un suo interruttore nel pannello, tolto il
    /// 30/08/2026: era il secondo tasto per una cosa che ne ha gia' uno —
    /// quello in cima accende e spegne il servizio, e il punto d'incontro *e'*
    /// il servizio visto da fuori casa. Due interruttori per una cosa sola
    /// insegnano a non fidarsi di nessuno dei due. Si spegne insieme a tutto il
    /// resto, da `AppHub.spegni()`.
    var isEnabled: Bool { true }

    /// Cambiare indirizzo **e** interruttore insieme, con un solo riavvio:
    /// riavviare due volte di fila butterebbe via l'attesa appena iniziata.
    func configure(base: String?, enabled: Bool?) {
        if let base {
            var cleaned = base.trimmingCharacters(in: .whitespacesAndNewlines)
            while cleaned.hasSuffix("/") { cleaned.removeLast() }
            UserDefaults.standard.set(cleaned, forKey: baseKey)
        }
        if let enabled { UserDefaults.standard.set(enabled, forKey: onKey) }
        restart()
    }

    /// Il punto d'incontro sta su Internet, quindi **https**. L'unica eccezione
    /// è `127.0.0.1`: serve a provare tutto l'impianto in locale, e non esce
    /// comunque da questo Mac.
    static func isAcceptable(base: String) -> Bool {
        base.hasPrefix("https://") || base.hasPrefix("http://127.0.0.1")
    }

    /// La stanza unica dei telefoni già accoppiati.
    var canRun: Bool {
        isEnabled && Self.isAcceptable(base: baseURL) && AuthStore.shared.pairedCount > 0
            && !AuthStore.shared.meetSecret.isEmpty
    }

    /// La stanza dell'accoppiamento. **Non** chiede telefoni già accoppiati: è
    /// esattamente la porta che serve a chi non ne ha ancora nessuno. Chiede
    /// solo un codice vivo, e il codice si rinnova da solo.
    var canPair: Bool {
        isEnabled && Self.isAcceptable(base: baseURL)
    }

    // MARK: - Stato

    var statusCode: String {
        if !isEnabled { return "off" }
        if baseURL.isEmpty { return "missing_url" }
        if !Self.isAcceptable(base: baseURL) { return "bad_url" }
        let live = upCount
        if live == 1 { return "connected" }
        if live > 1 { return "connected_n" }
        let err = q.sync { lastError }
        if !err.isEmpty { return "listening_error" }
        let devices = AuthStore.shared.pairedCount
        return devices == 0 ? "waiting_first" : "listening"
    }

    var lastErrorText: String { q.sync { lastError } }

    /// Per i log del Mac. Il telefono riceve `statusCode`.
    var statusText: String {
        L.remote(code: statusCode, n: upCount, detail: lastErrorText)
    }

    var upCount: Int { q.sync { sessions.values.filter { $0.isUp }.count } }

    /// Attese lunghe aperte sulla stanza dei telefoni accoppiati: 0 o 1.
    /// La stanza del codice è un'altra cosa, e non cresce col numero di telefoni.
    var waits: Int { q.sync { hostWaiter != nil ? 1 : 0 } }

    // L'indirizzo del QR non si decide qui: il ponte e' **una** delle due
    // strade, e a sceglierle e' `Strade` (ponte se configurato, altrimenti
    // la rete di casa).

    /// Un guaio del ponte che vale la pena dire, se c'è.
    var bridgeNote: String {
        let code = bridgeNoteCode
        return code.isEmpty ? "" : L.t("remote.\(code)")
    }
    var bridgeNoteCode: String { q.sync { bridgeWarning } }
    private var bridgeWarning = ""

    var payload: [String: Any] {
        ["on": isEnabled, "base": baseURL, "state": statusCode,
         "up": upCount, "note": bridgeNoteCode,
         "detail": lastErrorText,
         "waits": waits, "paired": AuthStore.shared.pairedCount]
    }

    /// **Il ponte ha la memoria condivisa?**
    ///
    /// Senza (`kv:false`) le buste restano dentro un solo isolato del servizio:
    /// se il Mac e il telefono finiscono su due isolati diversi non si trovano,
    /// e da fuori sembra che il Mac sia spento. È il guasto peggiore da
    /// diagnosticare — intermittente e senza errori — quindi si chiede una volta
    /// e lo si scrive nel pannello, invece di lasciarlo scoprire per strada.
    ///
    /// Si risolve dalla parte del ponte, non da qui: `bridge/README.md`.
    private func probeBridge() {
        guard canPair, let url = URL(string: "\(baseURL)/health") else { return }
        var req = URLRequest(url: url)
        req.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        session.dataTask(with: req) { [weak self] data, _, _ in
            guard let self, let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            // `single`: il ponte gira come processo solo — nostra macchina,
            // non una piattaforma che sparpaglia le richieste fra isolati.
            // Li' la memoria in process **e' gia'** condivisa fra le due parti,
            // quindi il KV non serve e avvisare sarebbe un falso allarme.
            let single = (obj["single"] as? Bool) ?? false
            let shared = (obj["kv"] as? Bool) ?? true
            let note = (shared || single) ? "" : "no_shared_memory"
            self.q.async {
                guard self.bridgeWarning != note else { return }
                self.bridgeWarning = note
                if !note.isEmpty { Log.warn("punto d'incontro:", note) }
                DispatchQueue.main.async { self.onStateChange?() }
            }
        }.resume()
    }

    // MARK: - Avvio

    func start() {
        AuthStore.shared.onDevicesChanged = { [weak self] in self?.devicesChanged() }
        // Il codice cambia spesso — a ogni accoppiamento, alla scadenza, quando
        // si brucia — e con lui cambia **solo** la stanza dell'accoppiamento.
        // Rifare anche i telefoni già collegati li staccherebbe ogni dieci
        // minuti per niente.
        AuthStore.shared.onPINChanged = { [weak self] in self?.restartPairing() }
        restart()
    }

    func stop() {
        q.sync {
            hostWaiter?.stop()
            hostWaiter = nil
            for s in sessions.values { s.stop() }
            sessions.removeAll()
            pairWaiter?.stop()
            pairWaiter = nil
            pairPeer?.stop()
            pairPeer = nil
        }
    }

    func restart() {
        q.async {
            // Un errore vecchio non deve sopravvivere a un indirizzo nuovo: il
            // pannello direbbe «non risponde» di un ponte che risponde.
            self.lastError = ""
            self.hostWaiter?.stop()
            self.hostWaiter = nil
            for s in self.sessions.values { s.stop() }
            self.sessions.removeAll()
            self.startHostLocked()
            DispatchQueue.main.async { self.onStateChange?() }
        }
        restartPairing()
        probeBridge()
    }

    /// Un telefono in più o in meno non deve riaprire l'attesa: la stanza è
    /// la stessa. Si aggiornano solo le chiavi con cui si aprono le buste, e
    /// si chiude la sessione di chi è stato scollegato.
    func devicesChanged() {
        q.async {
            let live = Set(AuthStore.shared.pairedList.map { $0.token })
            let gone = self.sessions.keys.filter { !live.contains($0) }
            for token in gone {
                self.sessions[token]?.stop()
                self.sessions[token] = nil
            }
            if self.canRun {
                if self.hostWaiter == nil {
                    self.startHostLocked()
                } else {
                    Log.info("punto d'incontro: in ascolto (una attesa, \(live.count) telefono/i) ·",
                             self.baseURL)
                }
            } else {
                self.hostWaiter?.stop()
                self.hostWaiter = nil
                for s in self.sessions.values { s.stop() }
                self.sessions.removeAll()
            }
            DispatchQueue.main.async { self.onStateChange?() }
        }
    }

    private func startHostLocked() {
        guard canRun else { return }
        let meet = AuthStore.shared.meetSecret
        guard let keys = try? Self.derive(secret: meet, kind: .device) else { return }
        if let w = hostWaiter, w.keys.room == keys.room { return }
        hostWaiter?.stop()
        let waiter = MailboxWaiter(kind: .device, keys: keys, owner: self) { [weak self] data in
            self?.acceptHostEnvelope(data)
        }
        hostWaiter = waiter
        waiter.start()
        let n = AuthStore.shared.pairedCount
        Log.info("punto d'incontro: in ascolto (una attesa, \(n) telefono/i) ·", baseURL)
    }

    /// Riapre **solo** la stanza dell'accoppiamento, sul codice di adesso.
    ///
    /// Con una cautela che costa quattro secondi e vale l'accoppiamento: chi
    /// cambia il codice è quasi sempre l'accoppiamento **appena riuscito**, e in
    /// quell'istante la risposta «ecco il gettone» sta ancora attraversando il
    /// canale. Chiudere subito vorrebbe dire spegnerlo sotto i piedi al telefono
    /// che sta entrando, e fallire a intermittenza. Si lascia finire, e solo
    /// dopo si chiude.
    func restartPairing() {
        q.async {
            let oldW = self.pairWaiter
            let oldP = self.pairPeer
            self.pairWaiter = nil
            self.pairPeer = nil
            if oldP?.isUp == true {
                DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
                    oldW?.stop()
                    oldP?.stop()
                }
            } else {
                oldW?.stop()
                oldP?.stop()
            }
            self.badEnvelopes = 0
            guard self.canPair else {
                DispatchQueue.main.async { self.onStateChange?() }
                return
            }
            let code = AuthStore.shared.currentPIN
            guard !code.isEmpty, let keys = try? Self.derive(secret: code, kind: .pair) else { return }
            let waiter = MailboxWaiter(kind: .pair, keys: keys, owner: self) { [weak self] data in
                self?.acceptPairEnvelope(data)
            }
            self.pairWaiter = waiter
            waiter.start()
            // Il codice **non** si scrive nel log: è un segreto. La stanza sì —
            // è un nome opaco, e senza saperla non si capisce niente quando
            // due parti si aspettano in due posti diversi.
            Log.info("accoppiamento: in ascolto nella stanza del codice ·", keys.room)
            DispatchQueue.main.async { self.onStateChange?() }
        }
    }

    // MARK: - Chiavi

    struct Keys {
        let room: String
        let seal: SymmetricKey
    }

    /// Stanza e chiave nascono da un segreto, con HKDF: il punto d'incontro vede
    /// 128 bit che sembrano rumore e non può risalire a niente. Le stesse due
    /// righe, identiche, stanno in `webapp/net.js`.
    ///
    /// Per i telefoni accoppiati la **stanza** nasce dal segreto del Mac e la
    /// **chiave** dal gettone: stessa funzione, due input diversi. Per
    /// l'accoppiamento restano tutti e due dal codice, etichette `*.pair`.
    static func derive(secret: String, kind: Kind) throws -> Keys {
        let ikm = SymmetricKey(data: Data(secret.utf8))
        let roomKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt,
                                             info: Data(kind.roomInfo.utf8), outputByteCount: 16)
        let sealKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt,
                                             info: Data(kind.sealInfo.utf8), outputByteCount: 32)
        let room = roomKey.withUnsafeBytes { Data($0) }.base64URLEncoded
        return Keys(room: room, seal: sealKey)
    }

    /// Identificatore opaco del dispositivo: 128 bit da HKDF, dentro la busta.
    /// Da fuori non si torna al gettone, e il ponte non lo vede (è cifrato).
    static func opaqueID(token: String) throws -> String {
        let ikm = SymmetricKey(data: Data(token.utf8))
        let idKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt,
                                           info: Data("id".utf8), outputByteCount: 16)
        return idKey.withUnsafeBytes { Data($0) }.base64URLEncoded
    }

    /// Stanza del Mac + chiave di **quel** telefono.
    static func keysForDevice(token: String) throws -> Keys {
        let room = try derive(secret: AuthStore.shared.meetSecret, kind: .device).room
        let seal = try derive(secret: token, kind: .device).seal
        return Keys(room: room, seal: seal)
    }

    // MARK: - Buste

    enum Err: Error, CustomStringConvertible {
        case busta(String)
        case rete(String)
        var description: String {
            switch self {
            case .busta(let s): return "busta \(s)"
            case .rete(let s): return "rete: \(s)"
            }
        }
    }

    static func open(envelope: Data, role: Character, keys: Keys) throws -> [String: Any] {
        guard envelope.count > 32 else { throw Err.busta("troppo corta") }
        let head = [UInt8](envelope.prefix(4))
        guard Array(head.prefix(3)) == magic else { throw Err.busta("non riconosciuta") }
        guard head[3] == role.asciiValue else { throw Err.busta("del ruolo sbagliato") }
        let aad = Data(head) + Data(keys.room.utf8)
        let nonce = try AES.GCM.Nonce(data: envelope.subdata(in: 4..<16))
        let rest = envelope.subdata(in: 16..<envelope.count)
        let box = try AES.GCM.SealedBox(nonce: nonce,
                                        ciphertext: rest.prefix(rest.count - 16),
                                        tag: rest.suffix(16))
        let plain = try AES.GCM.open(box, using: keys.seal, authenticating: aad)
        guard let obj = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
            throw Err.busta("con dentro qualcosa di illeggibile")
        }
        return obj
    }

    static func seal(_ obj: [String: Any], role: Character, keys: Keys) throws -> Data {
        let plain = try JSONSerialization.data(withJSONObject: obj)
        var head = magic
        head.append(role.asciiValue ?? 0)
        let aad = Data(head) + Data(keys.room.utf8)
        let box = try AES.GCM.seal(plain, using: keys.seal, nonce: AES.GCM.Nonce(),
                                   authenticating: aad)
        return Data(head) + Data(box.nonce) + box.ciphertext + box.tag
    }

    // MARK: - Punto d'incontro

    /// Ritorna la richiesta in corso, che va **annullata** quando il
    /// collegamento si ferma: un'attesa lunga abbandonata tiene occupata una
    /// connessione per più di un minuto.
    @discardableResult
    fileprivate func fetchOffer(room: String,
                                completion: @escaping (Result<Data?, Error>) -> Void) -> URLSessionDataTask? {
        guard var comps = URLComponents(string: "\(baseURL)/m/\(room)/o") else {
            completion(.failure(Err.rete("indirizzo non valido"))); return nil
        }
        comps.queryItems = [URLQueryItem(name: "w", value: "45")]
        guard let url = comps.url else {
            completion(.failure(Err.rete("indirizzo non valido"))); return nil
        }
        var req = URLRequest(url: url)
        req.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let task = session.dataTask(with: req) { data, response, error in
            if let error { completion(.failure(error)); return }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 204 { completion(.success(nil)); return }
            guard code == 200, let data, !data.isEmpty else {
                completion(.failure(Err.rete("risposta \(code)"))); return
            }
            completion(.success(data))
        }
        task.resume()
        return task
    }

    fileprivate func postAnswer(room: String, body: Data, completion: @escaping (Error?) -> Void) {
        guard let url = URL(string: "\(baseURL)/m/\(room)/a") else {
            completion(Err.rete("indirizzo non valido")); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        session.dataTask(with: req) { _, response, error in
            if let error { completion(error); return }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            completion((code == 204 || code == 200) ? nil : Err.rete("risposta \(code)"))
        }.resume()
    }

    fileprivate func note(error: String) {
        q.async {
            guard self.lastError != error else { return }
            self.lastError = error
            DispatchQueue.main.async { self.onStateChange?() }
        }
    }

    fileprivate func changed(clearError: Bool = false) {
        q.async {
            if clearError { self.lastError = "" }
            DispatchQueue.main.async { self.onStateChange?() }
        }
    }

    /// Buste arrivate nella stanza dell'accoppiamento che non si aprono.
    private var badEnvelopes = 0

    /// Per finire nella stanza giusta con la chiave sbagliata servirebbe una
    /// collisione su 128 bit: se succede, qualcuno sta provando. Dopo pochi
    /// tentativi il codice si brucia — e sul Mac ne compare un altro.
    fileprivate func noteBadPairEnvelope() {
        let tooMany: Bool = q.sync {
            badEnvelopes += 1
            return badEnvelopes >= 5
        }
        guard tooMany else { return }
        q.async { self.badEnvelopes = 0 }
        AuthStore.shared.burnPIN(why: "pin.burned_probes")
    }

    /// Una busta si accetta una volta sola, e non se è vecchia.
    fileprivate func isFresh(nonce: String, ts: Double) -> Bool {
        q.sync {
            let now = Date()
            seenNonces = seenNonces.filter { now.timeIntervalSince($0.value) < 300 }
            guard abs(now.timeIntervalSince1970 * 1000 - ts) < 90_000 else { return false }
            guard seenNonces[nonce] == nil else { return false }
            seenNonces[nonce] = now
            return true
        }
    }

    // MARK: - Buste in arrivo

    fileprivate func acceptHostEnvelope(_ data: Data) {
        var hit: (offer: [String: Any], token: String, keys: Keys)?
        for dev in AuthStore.shared.pairedList {
            guard let keys = try? Self.keysForDevice(token: dev.token) else { continue }
            guard let offer = try? Self.open(envelope: data, role: "o", keys: keys) else { continue }
            if let d = offer["d"] as? String, !d.isEmpty,
               let expected = try? Self.opaqueID(token: dev.token), d != expected {
                continue
            }
            hit = (offer, dev.token, keys)
            break
        }
        guard let hit else {
            Log.warn("punto d'incontro: busta rifiutata · nessuna chiave l'apre")
            note(error: "busta rifiutata")
            return
        }
        guard (hit.offer["t"] as? String) == "offer",
              let sdp = hit.offer["sdp"] as? String,
              let nonce = hit.offer["n"] as? String else {
            Log.warn("punto d'incontro: busta con un'offerta incompleta")
            return
        }
        guard isFresh(nonce: nonce, ts: (hit.offer["ts"] as? Double) ?? 0) else {
            Log.warn("punto d'incontro: offerta scaduta o già vista, ignorata")
            return
        }
        if let fp = hit.offer["fp"] as? String, !fp.isEmpty, fp != BridgePeer.fingerprint(in: sdp) {
            Log.warn("punto d'incontro: impronta dichiarata diversa dall'offerta · rifiutata")
            note(error: "impronta non corrispondente")
            return
        }
        Log.info("punto d'incontro: offerta valida (\(data.count) byte) · il telefono manda: \(BridgePeer.candidateSummary(in: sdp))")
        let token = hit.token
        let keys = hit.keys
        q.async {
            self.sessions[token]?.stop()
            let peer = BridgePeer(kind: .device, keys: keys, owner: self, token: token)
            self.sessions[token] = peer
            peer.answer(to: sdp, nonce: nonce)
        }
    }

    fileprivate func acceptPairEnvelope(_ data: Data) {
        guard let keys = q.sync(execute: { pairWaiter?.keys }) else { return }
        do {
            let offer = try Self.open(envelope: data, role: "o", keys: keys)
            guard (offer["t"] as? String) == "offer",
                  let sdp = offer["sdp"] as? String,
                  let nonce = offer["n"] as? String else {
                throw Err.busta("con un'offerta incompleta")
            }
            guard isFresh(nonce: nonce, ts: (offer["ts"] as? Double) ?? 0) else {
                Log.warn("accoppiamento: offerta scaduta o già vista, ignorata")
                return
            }
            if let fp = offer["fp"] as? String, !fp.isEmpty, fp != BridgePeer.fingerprint(in: sdp) {
                Log.warn("accoppiamento: impronta dichiarata diversa dall'offerta · rifiutata")
                note(error: "impronta non corrispondente")
                return
            }
            Log.info("accoppiamento: offerta valida (\(data.count) byte) · il telefono manda: \(BridgePeer.candidateSummary(in: sdp))")
            q.async {
                self.pairPeer?.stop()
                let peer = BridgePeer(kind: .pair, keys: keys, owner: self, token: nil)
                self.pairPeer = peer
                peer.answer(to: sdp, nonce: nonce)
            }
        } catch {
            Log.warn("accoppiamento: busta rifiutata ·", "\(error)")
            note(error: "busta rifiutata")
            noteBadPairEnvelope()
        }
    }

    fileprivate func peerClosed(_ peer: BridgePeer) {
        q.async {
            if let t = peer.token, self.sessions[t] === peer {
                self.sessions[t] = nil
            }
            if self.pairPeer === peer { self.pairPeer = nil }
        }
    }

    static var iceServers: [[String: Any]] { [["urls": stun]] }
}

// MARK: - Attesa alla cassetta

private final class MailboxWaiter {
    let kind: RemoteLink.Kind
    let keys: RemoteLink.Keys
    unowned let owner: RemoteLink
    private let onEnvelope: (Data) -> Void
    private var stopped = false
    private var backoff: TimeInterval = 0
    private var inFlight: URLSessionDataTask?
    let what: String

    init(kind: RemoteLink.Kind, keys: RemoteLink.Keys, owner: RemoteLink,
         onEnvelope: @escaping (Data) -> Void) {
        self.kind = kind
        self.keys = keys
        self.owner = owner
        self.onEnvelope = onEnvelope
        self.what = kind == .pair ? "accoppiamento" : "punto d'incontro"
    }

    func start() { stopped = false; wait() }

    func stop() {
        stopped = true
        inFlight?.cancel()
        inFlight = nil
    }

    private func wait() {
        guard !stopped else { return }
        inFlight = owner.fetchOffer(room: keys.room) { [weak self] result in
            guard let self, !self.stopped else { return }
            self.inFlight = nil
            switch result {
            case .success(nil):
                self.backoff = 0
                // Il ponte risponde di nuovo: l'errore che stava nel pannello
                // se ne va da solo, senza aspettare che un telefono si colleghi.
                if !self.owner.lastErrorText.isEmpty { self.owner.changed(clearError: true) }
                self.again(after: 0.2)
            case .success(.some(let data)):
                self.backoff = 0
                if !self.owner.lastErrorText.isEmpty { self.owner.changed(clearError: true) }
                self.onEnvelope(data)
                self.again(after: 0.5)
            case .failure(let e):
                let ns = e as NSError
                if ns.code != NSURLErrorTimedOut {
                    self.owner.note(error: ns.localizedDescription)
                }
                // Massimo 20 s: è anche il ritardo peggiore con cui un telefono
                // che si presenta viene notato. Più lungo sarebbe gentile col
                // punto d'incontro e scortese con chi aspetta.
                self.backoff = min(max(self.backoff * 2, 2), 20)
                self.again(after: self.backoff)
            }
        }
    }

    private func again(after: TimeInterval) {
        DispatchQueue.global().asyncAfter(deadline: .now() + after) { [weak self] in self?.wait() }
    }
}

// MARK: - WebView creata solo quando c'è un'offerta

/// Il ponte parla con Swift attraverso questo, che tiene solo un riferimento
/// debole: senza, la WebView e il collegamento si terrebbero in vita a vicenda.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: BridgePeer?
    init(_ t: BridgePeer) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.handle(message: m.body as? String ?? "")
    }
}

private final class BridgePeer: NSObject, WKNavigationDelegate {
    let kind: RemoteLink.Kind
    let keys: RemoteLink.Keys
    let token: String?
    unowned let owner: RemoteLink
    let what: String

    private var webView: WKWebView?
    private var window: NSWindow?
    private var loading = false
    private var pageReady = false
    private var readyWaiters: [(Bool) -> Void] = []
    private(set) var isUp = false

    init(kind: RemoteLink.Kind, keys: RemoteLink.Keys, owner: RemoteLink, token: String?) {
        self.kind = kind
        self.keys = keys
        self.owner = owner
        self.token = token
        self.what = kind == .pair ? "accoppiamento" : "punto d'incontro"
    }

    func stop() {
        DispatchQueue.main.async { self.dropWebView() }
    }

    /// L'impronta DTLS dichiarata dentro l'SDP.
    ///
    /// Attenzione a una trappola di Swift che è già costata un collegamento
    /// rifiutato: le righe di un SDP finiscono con `\r\n`, e per Swift `\r\n` è
    /// **un carattere solo** (un grafema). `split(separator: "\n")` quindi non
    /// taglia niente e restituisce tutto l'SDP come una riga sola. Si normalizza
    /// prima, e solo dopo si taglia.
    /// Che indirizzi ci ha mandato l'altro. Senza questa riga, quando il canale
    /// non si apre non si distingue **«non ha trovato il suo indirizzo
    /// pubblico»** da **«ce l'ha, ma le due reti non riescono a parlarsi»**:
    /// due guasti diversi, con due cure diverse. Il 04/09 e' costato una
    /// serata di indagine, perche' il registro diceva solo quanti byte erano.
    ///
    /// `host` = indirizzi di casa (e su iPhone sono nomi `.local` finti, che
    /// fuori non vogliono dire niente) · `srflx` = l'indirizzo pubblico visto
    /// da uno STUN · `relay` = rimbalzato da un TURN, che noi non abbiamo.
    static func candidateSummary(in sdp: String) -> String {
        let normalized = sdp.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var quanti: [String: Int] = [:]
        var pubblici: [String] = []
        for raw in normalized.split(separator: "\n") {
            let l = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard l.lowercased().hasPrefix("a=candidate:") else { continue }
            let campi = l.split(separator: " ").map(String.init)
            guard let i = campi.firstIndex(of: "typ"), i + 1 < campi.count else { continue }
            let tipo = campi[i + 1]
            quanti[tipo, default: 0] += 1
            if tipo != "host", campi.count > 5 { pubblici.append("\(campi[4]):\(campi[5])") }
        }
        if quanti.isEmpty { return "nessun indirizzo" }
        let riassunto = quanti.sorted { $0.key < $1.key }
            .map { "\($0.value) \($0.key)" }.joined(separator: " + ")
        return pubblici.isEmpty ? riassunto : "\(riassunto) · \(pubblici.joined(separator: " "))"
    }

    static func fingerprint(in sdp: String) -> String {
        let normalized = sdp.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        for raw in normalized.split(separator: "\n") {
            let l = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if l.lowercased().hasPrefix("a=fingerprint:") {
                return String(l.dropFirst("a=fingerprint:".count))
            }
        }
        return ""
    }

    func answer(to offerSdp: String, nonce: String) {
        DispatchQueue.main.async {
            self.ensureWebView { ok in
                guard ok, let web = self.webView else {
                    self.owner.note(error: "il ponte non si è caricato")
                    return
                }
                // `kind` non è decorazione: la pagina ponte, in modalità
                // accoppiamento, inoltra **solo** `/api/pair`. Chi entra col
                // codice non può leggere le conversazioni.
                web.callAsyncJavaScript(
                    "return await window.RB.answer(sdp, ice, kind);",
                    arguments: ["sdp": offerSdp, "ice": RemoteLink.iceServers,
                                "kind": self.kind.rawValue],
                    in: nil, in: .page
                ) { result in
                    switch result {
                    case .success(let value):
                        guard let sdp = value as? String, !sdp.isEmpty else {
                            self.owner.note(error: "risposta vuota dal ponte")
                            return
                        }
                        self.send(answer: sdp, nonce: nonce)
                    case .failure(let e):
                        Log.error("\(self.what): il ponte non ha risposto ·", e.localizedDescription)
                        self.owner.note(error: "il ponte non ha risposto")
                        self.dropWebView()
                    }
                }
            }
        }
    }

    private func send(answer sdp: String, nonce: String) {
        do {
            let body = try RemoteLink.seal([
                "t": "answer",
                "sdp": sdp,
                "fp": Self.fingerprint(in: sdp),
                "ts": Date().timeIntervalSince1970 * 1000,
                "n": nonce,
            ], role: "a", keys: keys)
            owner.postAnswer(room: keys.room, body: body) { [weak self, what] err in
                if let err {
                    Log.warn("\(what): risposta non consegnata ·", err.localizedDescription)
                    self?.owner.note(error: "risposta non consegnata")
                } else {
                    Log.info("\(what): risposta consegnata (\(body.count) byte)")
                }
            }
        } catch {
            Log.error("\(what): non riesco a chiudere la busta ·", "\(error)")
        }
    }

    private func ensureWebView(_ done: @escaping (Bool) -> Void) {
        if webView != nil, pageReady { done(true); return }
        if loading { readyWaiters.append(done); return }

        dropWebView()
        loading = true
        readyWaiters.append(done)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(MessageProxy(self), name: "rf")
        cfg.websiteDataStore = .nonPersistent()   // la pagina ponte non lascia niente su disco

        // **Il sonno.** Misurato il 05/09/2026 (`SONNO-FATTO.md`, banco nello
        // scratchpad e app vera): con la pagina in una finestra fuori schermo
        // WebKit la considera nascosta e dopo ~8 secondi lascia che macOS metta
        // il processo WebContent «in sonno» (process suppression, l'App Nap dei
        // processi di WebKit: priorità 47 → 4 → 20, memoria rilasciata). Da quel
        // momento i timer della pagina si congelano per 40 s alla volta e il
        // canale WebRTC **non consegna più niente, per sempre** — anche quando
        // il resto della pagina torna a girare. Tre richieste di fila passavano
        // in 200 ms, la quarta dopo 20 s di silenzio restava muta; nel registro
        // niente, perché per WebKit non è un errore.
        //
        // Il sonno ha **due stadi**, e la cura ha due pezzi.
        //
        // 1. Il primo stadio è quello degli 8 secondi, e lo spengono due
        //    interruttori di WebKit in `WKPreferencesPrivate.h` (da macOS
        //    10.10): il processo della pagina non viene più soppresso quando la
        //    pagina non è visibile. Da soli reggono 20 s e 3 minuti (203 ms a
        //    colpo), ma **non i 10 minuti**: fra il 3º e il 10º minuto WebKit
        //    porta comunque il WebContent in uno stato più profondo (priorità
        //    20, memoria da 34 a 5 MB) e il canale tace finché il telefono non
        //    lo risveglia — ICE disconnected → connected, e 17-37 s persi.
        // 2. Il secondo pezzo toglie la causa alla radice: con la rilevazione
        //    dell'occlusione spenta (`_windowOcclusionDetectionEnabled`, SPI di
        //    `WKWebView` per macOS), WebKit considera la pagina **visibile**
        //    anche dentro la finestra fuori schermo, e una pagina visibile non
        //    la sospende mai: è il suo mestiere tenerla viva. La pagina non
        //    disegna niente lo stesso (la finestra è fuori schermo e
        //    trasparente) e a riposo costa zero, misurato: 0,0 % di CPU sul
        //    WebContent, eco WebRTC in 1-4 ms.
        //
        // Si tengono tutti e due: se un macOS futuro togliesse il secondo, il
        // primo evita almeno la morte a 8 secondi, e il registro dice cosa
        // manca. Sono API private: quest'app non può comunque andare sull'App
        // Store (il sandbox blocca l'Accessibilità fra app). L'interruttore
        // che il mandato proponeva, `_alwaysRunsAtForegroundPriority`, su macOS
        // **non esiste** (è solo iOS: verificato a runtime), e `beginActivity`
        // sull'app non serve a niente (misurato: dorme uguale).
        let sveglia = Self.tieniSveglio(cfg.preferences)

        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 200), configuration: cfg)
        web.navigationDelegate = self
        webView = web
        let visibile = Self.setBoolSPI(web, "_setWindowOcclusionDetectionEnabled:", false)
        if !visibile { Log.warn("pagina ponte: WebKit non ha _setWindowOcclusionDetectionEnabled:") }

        // WebKit vuole una finestra, altrimenti la pagina non gira affatto;
        // l'utente non deve vedere niente. Fuori dallo schermo, trasparente,
        // senza fuoco, fuori dal Dock e da ⌘-tab — e con la rilevazione
        // dell'occlusione spenta il fatto che sia fuori schermo non conta più.
        let w: NSWindow
        if visibile {
            w = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 320, height: 200),
                         styleMask: [.borderless], backing: .buffered, defer: false)
            w.alphaValue = 0
            w.collectionBehavior = [.stationary, .ignoresCycle, .transient]
        } else {
            // Un macOS che non ha più quell'interruttore: si dice, e si usa
            // l'altra strada misurata per rendere la pagina visibile — la
            // finestra **sullo schermo**, un punto quasi trasparente in basso a
            // destra, sopra tutto e su ogni spazio.
            Log.error("\(what): WebKit senza l'interruttore dell'occlusione (\(sveglia)/2 anti-sonno trovati): la pagina ponte va in una finestra 1×1 sullo schermo")
            let s = NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
            w = NSWindow(contentRect: NSRect(x: s.maxX - 1, y: s.minY, width: 1, height: 1),
                         styleMask: [.borderless], backing: .buffered, defer: false)
            w.alphaValue = 0.01
            w.hasShadow = false
            w.level = .statusBar
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle, .transient]
        }
        w.contentView = web
        w.ignoresMouseEvents = true
        w.orderFrontRegardless()
        window = w

        let url = URL(string: "http://127.0.0.1:\(AppHub.shared.server.port)/host-bridge.html")!
        web.load(URLRequest(url: url))

        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, self.loading else { return }
            Log.error("\(self.what): la pagina ponte non si è caricata in 10 s")
            self.flush(false)
        }
    }

    /// Un setter booleano **privato** di WebKit, se c'è. I setter hanno il
    /// trattino basso prima di `set` (`_setAppNapEnabled:`), quindi KVC
    /// (`set_…:`) non li trova: si chiama l'implementazione direttamente. Se
    /// il selettore non esiste non succede niente e si ritorna `false`.
    private static func setBoolSPI(_ obj: NSObject, _ setter: String, _ value: Bool) -> Bool {
        let sel = Selector((setter))
        guard obj.responds(to: sel), let imp = obj.method(for: sel) else { return false }
        typealias Setter = @convention(c) (AnyObject, Selector, ObjCBool) -> Void
        unsafeBitCast(imp, to: Setter.self)(obj, sel, ObjCBool(value))
        return true
    }

    /// I due interruttori del primo stadio del sonno (vedi `ensureWebView`).
    /// Ritorna quanti ne ha trovati: 2 è la normalità, 0 un WebKit che non li ha più.
    private static func tieniSveglio(_ prefs: WKPreferences) -> Int {
        var trovati = 0
        for setter in ["_setPageVisibilityBasedProcessSuppressionEnabled:", "_setAppNapEnabled:"] {
            if setBoolSPI(prefs, setter, false) { trovati += 1 } else { Log.warn("pagina ponte: WebKit non ha", setter) }
        }
        return trovati
    }

    /// Il pid del processo WebContent della pagina, per ritrovarlo con `ps`
    /// quando si indaga: è lì che si vede il sonno (priorità e memoria).
    private var webContentPid: Int32 {
        guard let web = webView, web.responds(to: Selector(("_webProcessIdentifier"))),
              let n = web.value(forKey: "_webProcessIdentifier") as? NSNumber else { return 0 }
        return n.int32Value
    }

    private func flush(_ ok: Bool) {
        loading = false
        let list = readyWaiters
        readyWaiters = []
        for f in list { f(ok) }
    }

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        flush(true)
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        Log.error("\(what): la pagina ponte non si carica ·", e.localizedDescription)
        pageReady = false
        flush(false)
    }

    /// Il processo della pagina è morto sotto i piedi (memoria, uno schianto
    /// di WebKit): prima qui non c'era niente, e un canale sparito così non
    /// lasciava una riga. Si dice e si butta la WebView: il telefono rifarà
    /// l'offerta da solo quando si accorge che il canale è caduto.
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        Log.error("\(what): il processo della pagina ponte è terminato · canale perso")
        owner.note(error: "pagina ponte terminata")
        isUp = false
        dropWebView()
        owner.peerClosed(self)
    }

    func handle(message: String) {
        guard let d = message.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let t = obj["t"] as? String else { return }
        switch t {
        case "ready":
            // Com'è nata la pagina: visibilità (con la rilevazione
            // dell'occlusione spenta deve dire `visible`; `hidden` vuol dire
            // che il secondo pezzo della cura non ha preso) e il pid del suo
            // WebContent, per ritrovarlo con `ps` se un giorno il sonno tornasse.
            Log.info("\(what): pagina ponte pronta · visibilità \((obj["vis"] as? String) ?? "?") · WebContent pid \(webContentPid)")
            if (obj["rtc"] as? Bool) != true {
                Log.error("\(what): in questa WebView non c'è WebRTC")
                owner.note(error: "WebRTC non disponibile")
            }
        case "vis":
            // Oggi non succede mai (la finestra è fuori schermo e resta tale);
            // se succedesse, è la prima cosa da sapere quando il tubo tace.
            Log.info("\(what): la pagina ponte è diventata", (obj["v"] as? String) ?? "?")
        case "open":
            isUp = true
            Log.info("\(what): canale aperto col telefono")
            owner.changed(clearError: true)
        case "closed", "down":
            guard isUp || t == "down" else { return }
            isUp = false
            Log.info("\(what): canale chiuso ·", (obj["why"] as? String) ?? "")
            owner.changed()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, !self.isUp else { return }
                self.dropWebView()
                self.owner.peerClosed(self)
            }
        case "ice":
            // Ogni passaggio di ICE (checking, connected, completed,
            // disconnected, failed, closed): sono quattro o cinque righe per
            // collegamento, e sono la traccia che il 04/09 mancava — «risposta
            // consegnata» e poi il silenzio non dicono se il canale è morto
            // sulla rete o nella pagina.
            let v = (obj["v"] as? String) ?? "?"
            Log.info("\(what): ICE", v)
            if v == "failed" {
                owner.note(error: "su quella rete non si passa")
            }
        default:
            break
        }
    }

    private func dropWebView() {
        if let web = webView {
            web.evaluateJavaScript("window.RB && window.RB.close()") { _, _ in }
            web.configuration.userContentController.removeScriptMessageHandler(forName: "rf")
            web.stopLoading()
            web.navigationDelegate = nil
        }
        window?.orderOut(nil)
        window?.contentView = nil
        window = nil
        webView = nil
        pageReady = false
        loading = false
        isUp = false
    }
}

extension Data {
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
