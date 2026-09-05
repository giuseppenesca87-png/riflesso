import Foundation

/// **Il codice si legge da questo Mac, e da nessun'altra parte.**
///
/// Fino al 03/09/2026 stava dietro `GET /api/pin`, e la difesa era «chi bussa
/// da 127.0.0.1 e' questo Mac». Con `tailscale serve` davanti alla 7654 quella
/// difesa era carta: l'inoltro bussa da 127.0.0.1, e chiunque nella tailnet
/// leggeva il codice in chiaro con un `curl` — provato, non supposto. Percio'
/// l'endpoint non esiste piu'.
///
/// Chi ha bisogno del codice senza guardare il pannello — i collaudi, con
/// `Riflesso --print-pin` — lo chiede **qui**: un socket Unix a 0600 dentro
/// una cartella a 0700, che risponde solo a un processo dello **stesso
/// utente** (`getpeereid`). Un inoltro HTTP non puo' arrivarci per
/// costruzione: inoltra verso porte TCP, non verso file. E non e' un file col
/// codice dentro: e' una porta. Il codice continua a non finire mai su disco.
enum PinSocket {
    /// `~/Library/Application Support/Riflesso/pin.sock`. Non in `$TMPDIR`:
    /// quella cartella macOS la ripulisce da sola, e l'app resta aperta per
    /// settimane.
    static var url: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Riflesso", isDirectory: true).appendingPathComponent("pin.sock")
    }

    private static var fd: Int32 = -1
    private static var source: DispatchSourceRead?
    private static let queue = DispatchQueue(label: "riflesso.pin.socket")

    // MARK: - Lato app

    static func start() {
        let path = url.path
        // Un'altra copia gia' in ascolto? Allora risponde lei: non le si
        // toglie il socket da sotto i piedi. E' il litigio sulla porta 7654,
        // solo in un altro posto, e si risolve allo stesso modo: chi arriva
        // secondo lo dice e lascia stare.
        var why = ""
        if let s = connetti(path, timeout: 0.5, why: &why) {
            close(s)
            Log.warn("codice: un'altra copia di Riflesso e' gia' in ascolto su", path)
            return
        }
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        chmod(dir.path, 0o700)
        unlink(path)

        guard let addr = indirizzo(path) else {
            Log.error("codice: percorso del socket troppo lungo:", path)
            return
        }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { Log.error("codice: socket() fallita:", errnoText()); return }
        var a = addr
        let bound = withUnsafePointer(to: &a) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            Log.error("codice: bind() fallita:", errnoText())
            close(s)
            return
        }
        chmod(path, 0o600)
        guard listen(s, 8) == 0 else {
            Log.error("codice: listen() fallita:", errnoText())
            close(s)
            unlink(path)
            return
        }
        _ = fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK)
        fd = s
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: queue)
        src.setEventHandler { accetta() }
        src.setCancelHandler {
            close(s)
            unlink(path)
        }
        src.resume()
        source = src
        Log.info("codice: in ascolto su", path, "(solo questo utente)")
    }

    static func stop() {
        source?.cancel()
        source = nil
        fd = -1
    }

    /// Una domanda, una risposta, si chiude. Non c'e' niente da leggere: chi
    /// si collega vuole il codice, e basta.
    private static func accetta() {
        while fd >= 0 {
            let c = accept(fd, nil, nil)
            guard c >= 0 else { return }          // EAGAIN: la coda e' vuota
            defer { close(c) }
            senzaSIGPIPE(c)
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else {
                Log.warn("codice: richiesta da un altro utente (uid \(uid)), rifiutata")
                continue
            }
            let payload: [String: Any] = ["ok": true,
                                          "pin": AuthStore.shared.currentPIN,
                                          "digits": AuthStore.pinDigits,
                                          "service": AppHub.shared.servizioAcceso]
            guard var data = try? JSONSerialization.data(withJSONObject: payload) else { continue }
            data.append(0x0A)
            data.withUnsafeBytes { raw in _ = write(c, raw.baseAddress, raw.count) }
        }
    }

    // MARK: - Lato cliente (`--print-pin`)

    /// Chiede il codice all'app in esecuzione. `payload` se ha risposto,
    /// altrimenti `failure` dice perche' no.
    static func ask(timeout: TimeInterval = 3) -> (payload: [String: Any]?, failure: String?) {
        let path = url.path
        var why = ""
        guard let s = connetti(path, timeout: timeout, why: &why) else {
            return (nil, "nessuno in ascolto su \(path): \(why)")
        }
        defer { close(s) }
        var buf = [UInt8](repeating: 0, count: 4096)
        var got = Data()
        while got.count < 64 * 1024 {
            let n = read(s, &buf, buf.count)
            if n <= 0 { break }
            got.append(buf, count: n)
            if got.last == 0x0A { break }
        }
        guard !got.isEmpty else { return (nil, "risposta vuota") }
        guard let obj = (try? JSONSerialization.jsonObject(with: got)) as? [String: Any] else {
            return (nil, "risposta illeggibile")
        }
        return (obj, nil)
    }

    // MARK: - Attrezzi

    private static func connetti(_ path: String, timeout: TimeInterval, why: inout String) -> Int32? {
        guard let addr = indirizzo(path) else { why = "percorso troppo lungo"; return nil }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { why = errnoText(); return nil }
        senzaSIGPIPE(s)
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var a = addr
        let rc = withUnsafePointer(to: &a) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            why = errnoText()
            close(s)
            return nil
        }
        return s
    }

    /// Scrivere su un socket che l'altro ha gia' chiuso manda `SIGPIPE`, e
    /// `SIGPIPE` **uccide il processo**. Qui si vuole un errore, non un
    /// funerale.
    private static func senzaSIGPIPE(_ s: Int32) {
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }

    /// `sun_path` tiene 104 byte, e uno serve al terminatore.
    private static func indirizzo(_ path: String) -> sockaddr_un? {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return addr
    }

    private static func errnoText() -> String {
        String(cString: strerror(errno))
    }
}
