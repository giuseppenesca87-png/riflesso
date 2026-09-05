import Foundation

/// Gli allegati che arrivano dal telefono, prima di entrare in Claude.
///
/// Il file arriva **a pezzi**. Non e' un vezzo: la richiesta HTTP dell'host si
/// ferma a 1 MB (`HTTPParser`), e dal ponte la stessa richiesta viaggia dentro
/// il canale diretto, dove ogni busta e' piccola. Spezzare in pezzi da mezzo
/// mega vuol dire che la **stessa** strada funziona in casa, in diretta e dal
/// ponte, senza toccare il trasporto.
///
/// Il file finisce in una cartella temporanea nostra, non nella cartella di
/// Claude: da li' lo prendono gli appunti per incollarlo nel compositore.
final class Uploads {
    static let shared = Uploads()

    /// Il tetto per un allegato. Sopra questo il telefono dice di no **prima**
    /// di cominciare: meglio una frase che un caricamento che muore a meta'.
    static let maxBytes = 10 * 1024 * 1024

    /// Quanto puo' pesare un pezzo, gia' decodificato. In base64 diventa un
    /// terzo in piu': 512 KB → ~700 KB, e la richiesta resta sotto il mega.
    static let maxChunkBytes = 512 * 1024

    /// Dopo un'ora un allegato mai usato non serve piu' a nessuno.
    private static let ttl: TimeInterval = 3600

    struct Pending {
        var id: String
        var name: String
        var mime: String
        var declared: Int
        var url: URL
        var written: Int
        var chunks: Int
        var born: Date
        var complete: Bool
    }

    enum Failure: String, Error {
        case tooBig = "upload_too_big"
        case unknown = "upload_unknown"
        case outOfOrder = "upload_out_of_order"
        case failed = "upload_failed"
    }

    private let lock = NSLock()
    private var pending: [String: Pending] = [:]

    private init() {}

    static var folder: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("riflesso-allegati", isDirectory: true)
    }

    /// Un pezzo. `id` vuoto (o mancante) apre un caricamento nuovo.
    /// Torna l'identificativo e quanto e' arrivato finora.
    func accept(id: String, name: String, mime: String, declaredSize: Int,
                index: Int, total: Int, bytes: Data) throws -> Pending {
        guard declaredSize <= Uploads.maxBytes, bytes.count <= Uploads.maxChunkBytes else {
            throw Failure.tooBig
        }

        if index == 0 {
            sweep()
            let fresh = try open(name: name, mime: mime, declaredSize: declaredSize)
            return try append(id: fresh.id, index: 0, total: total, bytes: bytes)
        }
        guard !id.isEmpty else { throw Failure.unknown }
        return try append(id: id, index: index, total: total, bytes: bytes)
    }

    /// Il file pronto, se c'e' ed e' completo.
    func file(id: String) -> Pending? {
        lock.lock(); defer { lock.unlock() }
        guard let p = pending[id], p.complete else { return nil }
        guard FileManager.default.fileExists(atPath: p.url.path) else { return nil }
        return p
    }

    /// Da chiamare dopo la consegna, riuscita o no: il file ha finito il suo
    /// giro. Se resta li' lo toglie comunque `sweep()` all'allegato dopo.
    func discard(id: String) {
        lock.lock()
        let p = pending.removeValue(forKey: id)
        lock.unlock()
        if let p { try? FileManager.default.removeItem(at: p.url.deletingLastPathComponent()) }
    }

    // MARK: - dentro

    private func open(name: String, mime: String, declaredSize: Int) throws -> Pending {
        let id = UUID().uuidString
        let dir = Uploads.folder.appendingPathComponent(id, isDirectory: true)
        let safe = Uploads.safeName(name)
        let url = dir.appendingPathComponent(safe)
        do {
            // Una cartella per allegato: cosi' il nome del file resta quello
            // scelto dal telefono (si vede nel compositore di Claude) senza
            // che due allegati con lo stesso nome si pestino i piedi.
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            guard FileManager.default.createFile(atPath: url.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else {
                throw Failure.failed
            }
        } catch { throw Failure.failed }

        let p = Pending(id: id, name: safe, mime: mime, declared: declaredSize, url: url,
                        written: 0, chunks: 0, born: Date(), complete: false)
        lock.lock(); pending[id] = p; lock.unlock()
        return p
    }

    private func append(id: String, index: Int, total: Int, bytes: Data) throws -> Pending {
        lock.lock()
        guard var p = pending[id] else { lock.unlock(); throw Failure.unknown }
        guard p.chunks == index, !p.complete else { lock.unlock(); throw Failure.outOfOrder }
        guard p.written + bytes.count <= Uploads.maxBytes else { lock.unlock(); throw Failure.tooBig }
        lock.unlock()

        do {
            let h = try FileHandle(forWritingTo: p.url)
            defer { try? h.close() }
            try h.seekToEnd()
            try h.write(contentsOf: bytes)
        } catch { throw Failure.failed }

        p.written += bytes.count
        p.chunks = index + 1
        p.complete = p.chunks >= max(total, 1)
        lock.lock(); pending[id] = p; lock.unlock()
        return p
    }

    /// Le briciole dei giri precedenti. Gira solo all'inizio di un caricamento.
    private func sweep() {
        lock.lock()
        let stale = pending.filter { Date().timeIntervalSince($0.value.born) > Uploads.ttl }
        for k in stale.keys { pending.removeValue(forKey: k) }
        lock.unlock()
        for (_, p) in stale { try? FileManager.default.removeItem(at: p.url.deletingLastPathComponent()) }

        let fm = FileManager.default
        guard let kids = try? fm.contentsOfDirectory(at: Uploads.folder,
                                                     includingPropertiesForKeys: [.contentModificationDateKey],
                                                     options: [.skipsHiddenFiles]) else { return }
        for dir in kids {
            let when = (try? dir.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if Date().timeIntervalSince(when ?? .distantPast) > Uploads.ttl {
                try? fm.removeItem(at: dir)
            }
        }
    }

    /// Il nome arriva da fuori e diventa un percorso: si tiene solo l'ultimo
    /// pezzo, senza separatori, senza caratteri di controllo, e mai vuoto.
    static func safeName(_ raw: String) -> String {
        var s = (raw as NSString).lastPathComponent
        s = s.replacingOccurrences(of: "/", with: "-")
        s = s.replacingOccurrences(of: ":", with: "-")
        s = String(s.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 })
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        if s.count > 80 {
            let ext = (s as NSString).pathExtension
            let base = (s as NSString).deletingPathExtension
            s = String(base.prefix(70)) + (ext.isEmpty ? "" : "." + ext)
        }
        return s.isEmpty ? "allegato" : s
    }
}
