import Foundation

/// Sorveglia il file della chat aperta e spinge le novita' sul telefono.
///
/// E' la parte che da' la sensazione di WhatsApp: se si scrive dal Mac e
/// poi esce di casa, sul telefono la conversazione **continua da sola**.
///
/// Una sola chat per volta e' aperta, quindi un controllo al secondo su un
/// pugno di file costa nulla e non ha i tranelli di FSEvents quando un file
/// viene sostituito invece che allungato.
final class TranscriptWatcher {
    static let shared = TranscriptWatcher()

    private let lock = NSLock()
    private var offsets: [String: UInt64] = [:]
    /// Da quale file stavamo leggendo. Il transcript di una sessione **puo'
    /// cambiare cartella**: il Desktop lo riprende dalla `cwd` che trova
    /// scritta dentro, e se quella e' una sottocartella scrive in un'altra
    /// cartella-progetto. Successo davvero, con la chat di prova. Se il file
    /// cambia, l'offset vecchio non vuol dire piu' niente.
    private var paths: [String: String] = [:]
    /// Lo stato «sta lavorando» della chat aperta, ricavato dal transcript:
    /// vale sia quando si scrive dal telefono sia quando il lavoro parte dal
    /// Mac, perche' tutto passa comunque da quel file.
    private struct Working {
        var since = Date()
        var tokens = 0
        var pendingTools: [String] = []
        var lastAppend = Date()
    }
    private var working: [String: Working] = [:]
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "riflesso.watcher")

    /// Impostato da AppHub.
    var emit: (([String: Any]) -> Void)?

    private init() {}

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: .milliseconds(900))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    /// Il telefono ha aperto una chat: da qui in poi si guarda questo file.
    func open(cliId: String, from offset: UInt64) {
        lock.lock()
        offsets = [cliId: offset]   // una alla volta: e' cio' che si sta guardando
        paths = [:]
        working = [:]
        lock.unlock()
    }

    func close(cliId: String) {
        lock.lock()
        offsets.removeValue(forKey: cliId)
        paths.removeValue(forKey: cliId)
        working.removeValue(forKey: cliId)
        lock.unlock()
    }

    /// Da chiamare appena finisce un invio: le righe vere sono appena arrivate
    /// e il telefono deve sostituire la bozza in diretta con quelle definitive.
    func pokeSoon(cliId: String) {
        queue.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.check(cliId: cliId, ignoreBusy: true)
        }
        queue.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.check(cliId: cliId, ignoreBusy: true)
        }
    }

    private func tick() {
        lock.lock()
        let ids = Array(offsets.keys)
        lock.unlock()
        for id in ids { check(cliId: id, ignoreBusy: false) }
        heartbeat()
    }

    /// Un battito al secondo mentre la chat lavora: tempo, token, strumento in
    /// corso. Se il transcript tace per 5 minuti si smette di dirlo, che e'
    /// meglio di un orologio che corre su un lavoro morto.
    private func heartbeat() {
        lock.lock()
        let snapshot = working
        lock.unlock()
        for (id, w) in snapshot {
            if Date().timeIntervalSince(w.lastAppend) > 300 {
                lock.lock(); working.removeValue(forKey: id); lock.unlock()
                emit?(["t": "chatWorking", "chat": id, "active": false])
                continue
            }
            var d: [String: Any] = ["t": "chatWorking", "chat": id, "active": true,
                                    "secs": Int(Date().timeIntervalSince(w.since)),
                                    "tokens": w.tokens]
            if let tool = w.pendingTools.last {
                d["tool"] = tool
                if w.pendingTools.count > 1 { d["tools"] = w.pendingTools.count }
            }
            emit?(d)
        }
    }

    /// Aggiorna lo stato di lavoro con il battito del pezzo appena letto.
    private func absorb(_ p: TranscriptReader.Pulse, cliId: String) {
        lock.lock()
        var w = working[cliId]
        if p.userText {
            // Turno nuovo: il cronometro e i token ripartono.
            w = Working()
        }
        if w != nil || p.userText {
            var v = w ?? Working()
            v.tokens += p.tokens
            v.pendingTools.append(contentsOf: p.toolStarts)
            if p.toolResults > 0 { v.pendingTools.removeFirst(min(p.toolResults, v.pendingTools.count)) }
            v.lastAppend = Date()
            working[cliId] = v
        }
        let finished = p.ended && working[cliId] != nil
        if finished { working.removeValue(forKey: cliId) }
        lock.unlock()
        if finished { emit?(["t": "chatWorking", "chat": cliId, "active": false]) }
    }

    private func check(cliId: String, ignoreBusy: Bool) {
        // Mentre stiamo inviando, il testo lo sta gia' mostrando lo stream del
        // CLI parola per parola: rimandarlo anche da qui lo farebbe comparire due volte.
        if !ignoreBusy && ChatSender.shared.isBusy(cliId: cliId) { return }

        lock.lock()
        guard let offset = offsets[cliId] else { lock.unlock(); return }
        lock.unlock()

        TranscriptIndex.shared.refreshNow()
        guard let info = TranscriptIndex.shared.cachedInfo(for: cliId) else { return }

        lock.lock()
        let previousPath = paths[cliId]
        paths[cliId] = info.url.path
        lock.unlock()
        if let previousPath, previousPath != info.url.path {
            // Stessa conversazione, file nuovo: si ricomincia da capo, che e'
            // l'unica cosa onesta da fare con un offset che non vale piu'.
            Log.info("il transcript di", cliId, "è passato a", info.url.lastPathComponent,
                     "in", info.url.deletingLastPathComponent().lastPathComponent)
            lock.lock(); offsets[cliId] = info.size; lock.unlock()
            emit?(["t": "chatReload", "chat": cliId])
            return
        }

        if info.size < offset {
            // File sostituito o troncato: si riparte pulito.
            lock.lock(); offsets[cliId] = info.size; lock.unlock()
            emit?(["t": "chatReload", "chat": cliId])
            return
        }
        guard info.size > offset else { return }

        let (items, newOffset, pulse) = TranscriptReader.itemsAfter(url: info.url, offset: offset)
        lock.lock()
        // Se nel frattempo si e' cambiata chat, non si scrive un offset vecchio.
        if offsets[cliId] != nil { offsets[cliId] = newOffset }
        lock.unlock()

        absorb(pulse, cliId: cliId)
        guard !items.isEmpty else { return }
        emit?(["t": "chatAppend", "chat": cliId, "items": items, "end": newOffset])
        ChatList.shared.touch(cliId: cliId)
    }
}
