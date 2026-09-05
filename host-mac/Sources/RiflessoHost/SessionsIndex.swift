import Foundation

struct SessionEntry {
    var sessionId: String
    var cliSessionId: String
    var title: String
    var cwd: String
    /// La cartella con cui la conversazione e' nata. Nell'indice del Desktop
    /// oggi coincide sempre con `cwd`, ma e' l'altro candidato buono per capire
    /// da dove riprendere: costa niente tenerlo.
    var originCwd: String = ""
    var model: String
    var completedTurns: Int
    var lastActivityAt: Date
    var isArchived: Bool
    /// Serve per riprendere la sessione con gli stessi permessi che ha nel Desktop.
    var permissionMode: String = "default"
    var effort: String = ""
    var isStarred: Bool = false
    /// Valorizzato quando la sessione e' una **routine**, non una chat: l'ha
    /// aperta un'attivita' programmata. Sono la stragrande maggioranza dei file
    /// (293 su 305) e non vanno nell'elenco delle conversazioni.
    var scheduledTaskId: String = ""

    var isRoutine: Bool { !scheduledTaskId.isEmpty }

    var projectName: String {
        (cwd as NSString).lastPathComponent
    }

    var dict: [String: Any] {
        ["id": sessionId,
         "cliId": cliSessionId,
         "title": title,
         "cwd": cwd,
         "project": projectName,
         "model": model,
         "turns": completedTurns,
         "at": Int(lastActivityAt.timeIntervalSince1970 * 1000),
         "archived": isArchived]
    }
}

/// Legge le sessioni del tab Code dai file su disco. Sola lettura:
/// non tocchiamo nulla dentro la cartella di Claude.
///
/// **Si rilegge solo quello che e' cambiato.** I 663 file `local_*.json`
/// pesano 407 MB in tutto — ognuno porta dentro una copia da mezzo mega di
/// `remoteMcpServersConfig`, di cui qui non serve un byte — e di questi ne
/// cambia uno ogni dieci minuti. Rileggerli tutti a ogni giro costava 1,7 s
/// di CPU e teneva il processo al 30% di un core con un telefono fermo
/// sull'elenco (misurato il 04/09/2026). Adesso si enumera, si guarda misura
/// e data di ogni file, e si riapre **solo** chi e' cambiato: per gli altri
/// vale la voce gia' in memoria. E' lo stesso trucco della cache delle
/// anteprime in `ChatList`.
final class SessionsIndex {
    static let shared = SessionsIndex()

    static let root: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Claude/claude-code-sessions", isDirectory: true)

    /// Quello che si e' ricavato da un file, con la misura e la data con cui
    /// lo si e' letto: finche' non cambiano, la voce vale ancora.
    private struct Letto {
        var size: UInt64
        var modified: Date
        var entry: SessionEntry
    }

    private let queue = DispatchQueue(label: "riflesso.sessions")
    private let lock = NSLock()
    private var cache: [SessionEntry] = []
    /// Per percorso: cio' che si e' letto l'ultima volta da ogni file.
    private var letti: [String: Letto] = [:]
    private var cachedAt: Date = .distantPast
    private var reloading = false
    private let ttl: TimeInterval = 4

    /// **La rete di sotto.** Se il Desktop riscrivesse un file senza che
    /// cambino misura e data di modifica, quella sessione resterebbe ferma
    /// per sempre. Non e' mai stato osservato — APFS aggiorna la data a ogni
    /// scrittura — ma un orologio che salta o un file sostituito con uno di
    /// pari misura possono farlo. Percio' ogni dieci minuti si rilegge
    /// **tutto** una volta: costa 1,7 s di CPU ogni 600 s (lo 0,3% di un
    /// core) e mette un tetto di dieci minuti al peggior ritardo possibile.
    private let fullReloadEvery: TimeInterval = 10 * 60
    private var lastFullReload: Date = .distantPast

    private init() {}

    /// Prima lettura all'avvio, così la prima richiesta dal telefono
    /// trova già l'elenco pronto.
    func prime() { refreshIfStale(force: true) }

    /// Vero finché la prima lettura del disco non è finita.
    var isCold: Bool {
        lock.lock(); defer { lock.unlock() }
        return cachedAt == .distantPast
    }

    /// Non tocca mai il disco sul filo del chiamante: sono 600 file JSON e
    /// bloccherebbero la coda del server, cioè lo streaming dei fotogrammi.
    func entries(includeArchived: Bool = false, limit: Int = 300) -> [SessionEntry] {
        refreshIfStale(force: false)
        lock.lock()
        let snapshot = cache
        lock.unlock()
        return snapshot
            .filter { includeArchived || !$0.isArchived }
            .prefix(limit)
            .map { $0 }
    }

    /// La sessione con questo identificativo del CLI, archiviata o no.
    func entry(cliSessionId: String) -> SessionEntry? {
        guard !cliSessionId.isEmpty else { return nil }
        refreshIfStale(force: false)
        lock.lock(); defer { lock.unlock() }
        return cache.first { $0.cliSessionId == cliSessionId }
    }

    /// Rilettura sul filo del chiamante, per chi gira gia' in sottofondo e ha
    /// bisogno dell'elenco adesso. Costa pochi millisecondi: e' un giro di
    /// `stat` su tutti i file e la lettura dei soli file cambiati.
    ///
    /// Passa dalla stessa coda delle riletture in sottofondo: due letture
    /// insieme all'avvio (la prima di `prime()` e quella dell'elenco) facevano
    /// il giro intero **due volte**, 1,8 s l'una. In fila, la seconda trova
    /// il lavoro gia' fatto e finisce in un millisecondo.
    func reloadNow() { queue.sync { reload() } }

    /// Come `entry`, ma se non la trova **rilegge davvero** prima di dire di no.
    ///
    /// `entry` si accontenta della copia in memoria e la rinfresca in
    /// sottofondo: una conversazione comparsa sul Mac un attimo fa lì non c'e'
    /// ancora, e chi chiede si sente rispondere «Claude non e' aperto sul Mac»
    /// — che e' **falso**, ed e' successo davvero provando il cambio
    /// dell'impegno. Un file nuovo e' per definizione un file mai letto: la
    /// rilettura incrementale lo trova.
    func entryFresh(cliSessionId: String) -> SessionEntry? {
        if let e = entry(cliSessionId: cliSessionId) { return e }
        // Se la copia in memoria e' stata rifatta un attimo fa, quella sessione
        // non c'e' davvero. Meta' delle conversazioni non e' nell'indice del
        // Desktop **per davvero**.
        lock.lock()
        let appena = Date().timeIntervalSince(cachedAt) < 2
        lock.unlock()
        guard !appena else { return nil }
        reloadNow()
        return entry(cliSessionId: cliSessionId)
    }

    private func refreshIfStale(force: Bool) {
        lock.lock()
        let stale = force || Date().timeIntervalSince(cachedAt) > ttl
        if !stale || reloading { lock.unlock(); return }
        reloading = true
        lock.unlock()
        queue.async { [weak self] in
            self?.reload()
            self?.lock.lock()
            self?.reloading = false
            self?.lock.unlock()
        }
    }

    private func reload() {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let walker = fm.enumerator(at: SessionsIndex.root,
                                         includingPropertiesForKeys: keys,
                                         options: [.skipsHiddenFiles]) else {
            lock.lock(); cache = []; letti = [:]; cachedAt = Date(); lock.unlock(); return
        }

        lock.lock()
        let vecchi = letti
        let primaVolta = cachedAt == .distantPast
        let tutto = primaVolta || Date().timeIntervalSince(lastFullReload) > fullReloadEvery
        lock.unlock()

        let t0 = Date()
        var nuovi: [String: Letto] = [:]
        var found: [SessionEntry] = []
        var riletti = 0
        for case let url as URL in walker {
            guard url.lastPathComponent.hasPrefix("local_"),
                  url.pathExtension == "json" else { continue }
            // L'enumeratore ha gia' chiesto misura e data insieme al nome: qui
            // non si tocca il disco una seconda volta.
            let values = try? url.resourceValues(forKeys: Set(keys))
            let size = UInt64(values?.fileSize ?? 0)
            let modified = values?.contentModificationDate ?? .distantPast
            if !tutto, let l = vecchi[url.path], l.size == size, l.modified == modified {
                nuovi[url.path] = l
                found.append(l.entry)
                continue
            }
            // **Un pool per file.** Gli oggetti di `JSONSerialization` — un albero
            // di qualche megabyte per ognuno di questi file, quasi tutto
            // `remoteMcpServersConfig` — sono autoreleased e senza un pool
            // restano vivi fino alla fine del giro: 663 alberi insieme erano il
            // picco da centinaia di megabyte che il processo si portava dietro
            // come memoria residente (misurato: 655 MB «reclaimable»). Cosi'
            // ogni albero muore prima che nasca il successivo.
            let entry: SessionEntry? = autoreleasepool {
                guard let data = try? Data(contentsOf: url),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
                return SessionsIndex.entry(from: obj, url: url)
            }
            guard let entry else { continue }
            riletti += 1
            nuovi[url.path] = Letto(size: size, modified: modified, entry: entry)
            found.append(entry)
        }
        found.sort { $0.lastActivityAt > $1.lastActivityAt }

        if primaVolta {
            Log.info("indice delle sessioni: \(found.count) file letti in \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
        }
        lock.lock()
        cache = found
        letti = nuovi
        cachedAt = Date()
        if tutto { lastFullReload = Date() }
        lock.unlock()
    }

    /// I 14 campi che servono, da un file che ne porta centinaia.
    private static func entry(from obj: [String: Any], url: URL) -> SessionEntry {
        let ms = (obj["lastActivityAt"] as? Double) ?? (obj["lastFocusedAt"] as? Double) ?? 0
        let title = (obj["title"] as? String) ?? ""
        let cwd = (obj["cwd"] as? String) ?? ""
        return SessionEntry(
            sessionId: (obj["sessionId"] as? String) ?? url.deletingPathExtension().lastPathComponent,
            cliSessionId: (obj["cliSessionId"] as? String) ?? "",
            title: title.isEmpty ? (cwd as NSString).lastPathComponent : title,
            cwd: cwd,
            originCwd: (obj["originCwd"] as? String) ?? "",
            model: (obj["model"] as? String) ?? "",
            completedTurns: (obj["completedTurns"] as? Int) ?? 0,
            lastActivityAt: Date(timeIntervalSince1970: ms / 1000),
            isArchived: (obj["isArchived"] as? Bool) ?? false,
            permissionMode: (obj["permissionMode"] as? String) ?? "default",
            effort: (obj["effort"] as? String) ?? "",
            isStarred: (obj["isStarred"] as? Bool) ?? false,
            scheduledTaskId: (obj["scheduledTaskId"] as? String) ?? ""
        )
    }
}
