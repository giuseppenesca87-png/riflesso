import Foundation

/// Una riga dell'elenco chat: quello che si vede prima di entrare.
struct ChatRow {
    var cliId: String
    var title: String
    var cwd: String
    var project: String
    var model: String
    var turns: Int
    var lastActivity: Date
    var preview: String
    var previewWho: String      // "me" | "claude" | ""
    var openable: Bool          // ha un transcript su disco?
    var active: Bool            // qualcuno ci sta scrivendo adesso?
    var starred: Bool
    var routine: Bool           // aperta da un'attivita' programmata, non da una persona
    /// Il gruppo in cui sta sul Mac, o "" se non ne ha uno. Vedi DesktopGroups.
    var groupId: String = ""
    /// Dove sta fra le fissate del Desktop, o -1 se non e' fissata. Sul Mac le
    /// fissate stanno **tutte insieme in cima**, fuori dai gruppi: senza questo
    /// numero finirebbero mischiate dentro il gruppo a cui appartengono.
    var pinRank: Int = -1

    var dict: [String: Any] {
        ["id": cliId,
         "title": title,
         "project": project,
         "model": model,
         "turns": turns,
         "at": Int(lastActivity.timeIntervalSince1970 * 1000),
         "preview": preview,
         "who": previewWho,
         "open": openable,
         "active": active,
         "star": starred,
         "group": groupId,
         "pin": pinRank,
         "routine": routine]
    }
}

/// L'elenco delle conversazioni, pronto da mostrare.
///
/// Deve aprirsi in meno di un secondo con 600 sessioni, quindi non legge mai
/// il disco sul filo della richiesta: risponde dalla memoria e si aggiorna in
/// sottofondo. Le anteprime costano care (aprire 169 file, alcuni da 1 GB) e
/// vengono ricalcolate **solo** per i file che sono davvero cambiati. Dal
/// 04/09/2026 anche l'indice delle sessioni (`SessionsIndex`) fa lo stesso:
/// una ricostruzione intera costa pochi millisecondi, non piu' 1,7 s.
final class ChatList {
    static let shared = ChatList()

    private struct CachedPreview {
        var size: UInt64
        var modified: Date
        var text: String
        var who: String
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "riflesso.chatlist")
    private var rows: [ChatRow] = []
    private var previews: [String: CachedPreview] = [:]
    private var builtAt = Date.distantPast
    private var building = false
    private let ttl: TimeInterval = 4
    /// Le anteprime delle routine si calcolano solo se qualcuno le chiede.
    /// Sono 293 file su 305: leggerli tutti all'avvio vuol dire far aspettare
    /// per roba che non si guarda mai.
    private var routinesWanted = false
    private var routinesBuilt = false

    /// Una chat e' «attiva» se il suo file e' stato scritto pochissimo fa.
    private let activeWindow: TimeInterval = 90

    /// **L'elenco si spinge, non si chiede.** Chi lo vuole sapere — `AppHub`,
    /// che lo manda sulla diretta — viene chiamato con `"chat"` o `"routine"`
    /// quando quella meta' dell'elenco e' cambiata davvero. Prima il telefono
    /// richiedeva l'elenco intero ogni sei secondi (5 richieste e 484 KB ogni
    /// mezzo minuto sulle routine, per righe che non cambiavano): adesso
    /// riceve un evento e richiede solo allora.
    var onChanged: ((String) -> Void)?
    /// L'impronta dell'ultima versione mandata, per meta' dell'elenco.
    private var impronte: [String: Int] = [:]

    private init() {}

    func prime() { rebuild(force: true) }

    /// Ricostruisce se e' passato il tempo, in sottofondo. La chiama un
    /// orologio in `AppHub` finche' c'e' un telefono collegato: e' cio' che
    /// permette di accorgersi di un cambiamento senza che nessuno chieda.
    func refresh() { rebuild(force: false) }

    var isCold: Bool {
        lock.lock(); defer { lock.unlock() }
        return builtAt == .distantPast
    }

    /// Vero finche' le anteprime delle routine non sono pronte: il telefono
    /// richiede fra un secondo invece di mostrare righe mute.
    var routinesCold: Bool {
        lock.lock(); defer { lock.unlock() }
        return !routinesBuilt
    }

    /// Quante righe ci sono di qua e di la'. L'elenco principale sono **le sue
    /// conversazioni**; le routine sono centinaia e le sommergerebbero.
    func counts() -> (chats: Int, routines: Int) {
        rebuild(force: false)
        lock.lock(); defer { lock.unlock() }
        let r = rows.filter { $0.routine }.count
        return (rows.count - r, r)
    }

    func items(query: String = "", routines: Bool = false, limit: Int = 400) -> [ChatRow] {
        var needsWork = false
        if routines {
            lock.lock()
            needsWork = !routinesWanted
            routinesWanted = true
            lock.unlock()
        }
        rebuild(force: needsWork)
        lock.lock()
        var snapshot = rows.filter { $0.routine == routines }
        lock.unlock()

        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            // Si cerca nel titolo **e** nel testo dell'ultimo messaggio,
            // come chiede il PIVOT: spesso di una chat ci si ricorda una frase,
            // non il titolo.
            snapshot = snapshot.filter {
                $0.title.lowercased().contains(q)
                    || $0.preview.lowercased().contains(q)
                    || $0.project.lowercased().contains(q)
            }
        }
        // Il pallino verde deve essere vero adesso, non a quando si e' costruito.
        let now = Date()
        return snapshot.prefix(limit).map { row in
            var r = row
            r.active = now.timeIntervalSince(row.lastActivity) < activeWindow
            return r
        }
    }

    func row(for cliId: String) -> ChatRow? {
        lock.lock(); defer { lock.unlock() }
        return rows.first { $0.cliId == cliId }
    }

    /// Da chiamare dopo un invio: la chat deve risalire in cima subito.
    ///
    /// La chiama anche il sorvegliante a ogni pezzo di risposta che arriva
    /// (fino a uno ogni 900 ms): invalidare qui e' gratis, e la ricostruzione
    /// che ne segue — al prossimo giro dell'orologio o della richiesta — costa
    /// pochi millisecondi da quando l'indice delle sessioni non rilegge piu'
    /// 407 MB. Non ne parte una per chiamata: `rebuild` ne tiene una sola
    /// alla volta.
    func touch(cliId: String) {
        lock.lock()
        if let i = rows.firstIndex(where: { $0.cliId == cliId }) {
            rows[i].lastActivity = Date()
            let moved = rows.remove(at: i)
            rows.insert(moved, at: 0)
        }
        builtAt = .distantPast   // forza un ricalcolo dell'anteprima
        lock.unlock()
    }

    private func rebuild(force: Bool) {
        lock.lock()
        let stale = force || Date().timeIntervalSince(builtAt) > ttl
        if !stale || building { lock.unlock(); return }
        building = true
        lock.unlock()
        queue.async { [weak self] in
            self?.build()
            guard let self else { return }
            self.lock.lock(); self.building = false; self.lock.unlock()
        }
    }

    private func build() {
        // Qui si gira gia' in sottofondo: si legge il disco adesso, altrimenti
        // si costruirebbe un elenco vuoto mentre gli indici si scaldano.
        TranscriptIndex.shared.refreshNow()
        SessionsIndex.shared.reloadNow()
        let sessions = SessionsIndex.shared.entries(includeArchived: false, limit: 1000)

        lock.lock()
        var cache = previews
        let wantRoutines = routinesWanted
        lock.unlock()

        var out: [ChatRow] = []
        var seen = Set<String>()
        for s in sessions {
            guard !s.cliSessionId.isEmpty, !seen.contains(s.cliSessionId) else { continue }
            seen.insert(s.cliSessionId)

            let info = TranscriptIndex.shared.cachedInfo(for: s.cliSessionId)

            // Scoperta n.3 del PIVOT: il CLI non aggiorna l'indice del Desktop.
            // Se ci si fidasse solo di `lastActivityAt`, una chat a cui hai
            // appena risposto dal telefono resterebbe in fondo all'elenco.
            var last = s.lastActivityAt
            if let m = info?.modified, m > last { last = m }

            var preview = ""
            var who = ""
            // Le anteprime costano: 293 delle 305 sessioni sono routine, e
            // aprire i loro file all'avvio vuol dire far aspettare per pagine
            // che restano chiuse.
            if let info, !s.isRoutine || wantRoutines {
                if let c = cache[s.cliSessionId], c.size == info.size, c.modified == info.modified {
                    preview = c.text
                    who = c.who
                } else {
                    // Un pool per file, come nell'indice delle sessioni: la
                    // finestra letta dal fondo (fino a 3 MB, gia' analizzati)
                    // deve morire qui, non alla fine del giro.
                    let p = autoreleasepool { () -> (text: String, who: String)? in
                        let w = TranscriptReader.window(url: info.url, wantItems: 6,
                                                        maxScan: 3 * 1024 * 1024)
                        return ChatList.previewText(from: w.items)
                    }
                    if let p {
                        preview = p.text
                        who = p.who
                    }
                    cache[s.cliSessionId] = CachedPreview(size: info.size, modified: info.modified,
                                                          text: preview, who: who)
                }
            }

            out.append(ChatRow(
                cliId: s.cliSessionId,
                title: s.title,
                cwd: s.cwd,
                project: s.projectName,
                model: ChatList.shortModel(s.model),
                turns: s.completedTurns,
                lastActivity: last,
                preview: preview,
                previewWho: who,
                openable: info != nil,
                active: Date().timeIntervalSince(last) < activeWindow,
                starred: s.isStarred,
                routine: s.isRoutine,
                // Il legame chat→gruppo si fa col `sessionId` del Desktop, non
                // col `cliSessionId`: per alcune conversazioni sono diversi.
                groupId: DesktopGroups.shared.groupId(sessionId: s.sessionId),
                pinRank: s.isStarred
                    ? (DesktopGroups.shared.pinRank(sessionId: s.sessionId) ?? Int.max)
                    : -1
            ))
        }
        out.sort { $0.lastActivity > $1.lastActivity }

        // Cos'e' cambiato rispetto all'ultima volta, per meta' dell'elenco.
        // L'impronta comprende tutto quello che il telefono disegna (anche i
        // gruppi e il pallino verde), cosi' un evento arriva solo quando c'e'
        // qualcosa di nuovo da vedere.
        let gruppi = DesktopGroups.shared.groups()
        let now = Date()
        let nuove = ["chat": impronta(out.filter { !$0.routine }, groups: gruppi, now: now),
                     "routine": wantRoutines ? impronta(out.filter { $0.routine }, groups: [], now: now) : 0]

        lock.lock()
        let prima = builtAt == .distantPast
        let vecchie = impronte
        rows = out
        previews = cache
        builtAt = Date()
        impronte = nuove
        if wantRoutines { routinesBuilt = true }
        lock.unlock()

        guard !prima else { return }
        for (kind, fp) in nuove where fp != 0 && vecchie[kind] != fp {
            onChanged?(kind)
        }
    }

    private func impronta(_ list: [ChatRow], groups: [ChatGroup], now: Date) -> Int {
        var h = Hasher()
        for g in groups { h.combine(g.id); h.combine(g.name); h.combine(g.starred) }
        for r in list {
            h.combine(r.cliId); h.combine(r.title); h.combine(r.project); h.combine(r.model)
            h.combine(r.turns); h.combine(Int(r.lastActivity.timeIntervalSince1970))
            h.combine(r.preview); h.combine(r.previewWho); h.combine(r.openable)
            h.combine(r.starred); h.combine(r.groupId); h.combine(r.pinRank)
            h.combine(now.timeIntervalSince(r.lastActivity) < activeWindow)
        }
        // Zero e' «mai calcolata»: un'impronta vera non deve coincidere.
        let v = h.finalize()
        return v == 0 ? 1 : v
    }

    /// L'ultimo messaggio **vero**: una frase di chi scrive o una risposta di
    /// Claude. Notifiche di sistema, promemoria, esiti di strumenti e blocchi
    /// di servizio non raccontano niente a chi guarda l'elenco, e restano fuori
    /// finche' c'e' anche solo una riga di conversazione.
    static func previewText(from items: [[String: Any]]) -> (text: String, who: String)? {
        for item in items.reversed() {
            let k = (item["k"] as? String) ?? ""
            guard k == "me" || k == "claude" else { continue }
            let clean = oneLine((item["text"] as? String) ?? "")
            guard !clean.isEmpty else { continue }
            return (String(clean.prefix(120)), k)
        }
        // Niente di scritto da nessuno: era un giro di automazione.
        for item in items.reversed() where (item["k"] as? String) == "auto" {
            let name = (item["name"] as? String) ?? ""
            if !name.isEmpty { return (String(name.prefix(120)), "auto") }
            let clean = oneLine((item["text"] as? String) ?? "")
            if !clean.isEmpty { return (String(clean.prefix(120)), "claude") }
        }
        // Nemmeno quello: almeno si dice che si stava lavorando.
        for item in items.reversed() where (item["k"] as? String) == "tool" {
            let n = (item["name"] as? String) ?? "tool"
            let b = (item["brief"] as? String) ?? ""
            return (("⚙ " + n + (b.isEmpty ? "" : " · " + b)), "claude")
        }
        return nil
    }

    /// Da markdown a una riga sola di testo vero.
    static func oneLine(_ s: String) -> String {
        var t = s
        // I blocchi di codice non dicono nulla in un'anteprima.
        while let a = t.range(of: "```"), let b = t.range(of: "```", range: a.upperBound..<t.endIndex) {
            t.removeSubrange(a.lowerBound..<b.upperBound)
        }
        t = t.replacingOccurrences(of: "\r", with: " ")
        t = t.replacingOccurrences(of: "\n", with: " ")
        for token in ["**", "__", "`", "#### ", "### ", "## ", "# ", "> "] {
            t = t.replacingOccurrences(of: token, with: "")
        }
        while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `claude-opus-4-8[1m]` non e' una cosa da mostrare a una persona.
    static func shortModel(_ raw: String) -> String {
        var m = raw
        if let r = m.range(of: "[") { m = String(m[m.startIndex..<r.lowerBound]) }
        m = m.replacingOccurrences(of: "claude-", with: "")
        let parts = m.split(separator: "-")
        guard let family = parts.first else { return m }
        let name = family.capitalized
        let version = parts.dropFirst().prefix(2).joined(separator: ".")
        return version.isEmpty ? name : "\(name) \(version)"
    }
}
