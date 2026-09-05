import Foundation

// MARK: - Dove vive il contenuto vero delle conversazioni

/// Indice dei file `.jsonl`, cioe' del testo vero delle chat.
///
/// L'indice si costruisce **leggendo i nomi dei file**, non indovinando come
/// Claude trasforma una cartella in un nome di cartella. Sembra un dettaglio,
/// ma e' cio' che fa reggere spazi, punti e accenti nei percorsi: l'unica
/// regola che conosciamo per certo e' che il file si chiama `<cliSessionId>.jsonl`.
final class TranscriptIndex {
    static let shared = TranscriptIndex()

    static let root: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/projects", isDirectory: true)

    struct Info {
        var url: URL
        var size: UInt64
        var modified: Date
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "riflesso.transcript.index")
    private var map: [String: Info] = [:]
    private var refreshedAt = Date.distantPast
    private var refreshing = false
    private let ttl: TimeInterval = 5

    private init() {}

    func prime() { refresh(force: true) }

    func info(for cliId: String) -> Info? {
        refresh(force: false)
        lock.lock(); defer { lock.unlock() }
        return map[cliId]
    }

    /// Versione che non tocca il disco: per i cicli stretti.
    func cachedInfo(for cliId: String) -> Info? {
        lock.lock(); defer { lock.unlock() }
        return map[cliId]
    }

    /// Rilettura sul filo del chiamante. Da usare **solo** da code di sfondo:
    /// chi costruisce l'elenco ha bisogno dell'indice adesso, non fra poco.
    func refreshNow() { scan() }

    func refresh(force: Bool) {
        lock.lock()
        let stale = force || Date().timeIntervalSince(refreshedAt) > ttl
        if !stale || refreshing { lock.unlock(); return }
        refreshing = true
        lock.unlock()
        queue.async { [weak self] in
            self?.scan()
            guard let self else { return }
            self.lock.lock(); self.refreshing = false; self.lock.unlock()
        }
    }

    private func scan() {
        let fm = FileManager.default
        var found: [String: Info] = [:]
        let dirs = (try? fm.contentsOfDirectory(at: TranscriptIndex.root,
                                                includingPropertiesForKeys: nil,
                                                options: [.skipsHiddenFiles])) ?? []
        for dir in dirs {
            let files = (try? fm.contentsOfDirectory(at: dir,
                                                     includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                                                     options: [.skipsHiddenFiles])) ?? []
            for f in files where f.pathExtension == "jsonl" {
                let id = f.deletingPathExtension().lastPathComponent
                let values = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                let info = Info(url: f,
                                size: UInt64(values?.fileSize ?? 0),
                                modified: values?.contentModificationDate ?? .distantPast)
                // Se lo stesso id comparisse in due progetti, vince il piu' recente.
                if let old = found[id], old.modified > info.modified { continue }
                found[id] = info
            }
        }
        lock.lock()
        map = found
        refreshedAt = Date()
        lock.unlock()
    }
}

// MARK: - Lettura dal fondo

/// Una finestra di conversazione gia' ridotta a cio' che serve alla vista.
struct TranscriptWindow {
    var items: [[String: Any]] = []
    /// Offset della prima riga inclusa: e' il segnaposto per «carica altri».
    var firstOffset: UInt64 = 0
    /// Fine della parte letta: da qui in poi guarda la sorveglianza dal vivo.
    var endOffset: UInt64 = 0
    var hasMore: Bool = false
    /// La cartella con cui il CLI ha scritto queste righe: serve per riprendere.
    var cwd: String?
    /// L'ultimo modello che ha davvero risposto in questa finestra.
    var model: String?
}

/// Trasforma un `.jsonl` da 1 GB in poche decine di blocchi pronti da mostrare.
///
/// Due regole guidano tutto:
/// 1. **non si legge mai tutto il file** — si risale dal fondo a pezzi;
/// 2. **il telefono non vede mai JSON grezzo** — ogni riga esce di qui gia'
///    ridotta a testo, oppure non esce affatto.
enum TranscriptReader {

    private static let chunkSize = 192 * 1024
    /// Oltre questo non si risale: una chat con 50 MB di allegati di fila
    /// non deve trasformarsi in un'attesa infinita.
    private static let maxScanPerCall = 32 * 1024 * 1024

    /// Righe che non hanno nulla da mostrare: sono il funzionamento interno di
    /// Claude, non la conversazione. In un transcript di lavoro vero sono i tre
    /// quarti del totale, per questo si scartano **prima** di analizzarle.
    private static let ignoredTypes: Set<String> = [
        "attachment", "custom-title", "mode", "last-prompt",
        "queue-operation", "frame-link", "summary", "file-history-snapshot",
    ]

    // MARK: Ingresso principale

    static func window(url: URL, before: UInt64? = nil, wantItems: Int = 40,
                       maxScan: Int = maxScanPerCall) -> TranscriptWindow {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return TranscriptWindow() }
        defer { try? handle.close() }

        let fileSize = (try? handle.seekToEnd()) ?? 0
        var boundary = min(before ?? fileSize, fileSize)
        let endOffset = boundary

        var rows: [(off: UInt64, obj: [String: Any])] = []
        var scanned = 0
        var reachedStart = false
        var w = TranscriptWindow()

        // Si risale a pezzi. `cursor` e' il punto fin dove si e' letto; `carry`
        // e' l'inizio mancante di una riga a cavallo fra due pezzi — e capita
        // spesso, perche' una sola riga di allegato puo' superare il megabyte.
        var cursor = boundary
        var carry = Data()
        var droppedTerminator = false

        while cursor > 0 {
            if scanned >= maxScan { break }
            let readSize = UInt64(min(UInt64(chunkSize), cursor))
            let chunkStart = cursor - readSize
            guard var buf = try? read(handle, at: chunkStart, count: Int(readSize)) else { break }
            scanned += buf.count
            buf.append(carry)
            // Il byte prima del confine e' l'a capo che chiude la riga
            // precedente: non e' un separatore da contare, e contarlo teneva
            // il confine fermo per sempre.
            if !droppedTerminator {
                if buf.last == 0x0A { buf.removeLast() }
                droppedTerminator = true
            }

            let atStart = chunkStart == 0
            let (lines, head) = splitLines(buf, start: chunkStart, headIsComplete: atStart)

            var batch: [(off: UInt64, obj: [String: Any])] = []
            batch.reserveCapacity(lines.count)
            for line in lines {
                guard let obj = parse(line.data) else { continue }
                batch.append((line.off, obj))
            }
            rows.insert(contentsOf: batch, at: 0)
            if let firstLine = lines.first { boundary = firstLine.off }

            cursor = chunkStart
            carry = head
            // Una riga smisurata e' sempre un allegato, e gli allegati non si
            // mostrano: meglio perderla che gonfiare la memoria all'infinito.
            if carry.count > 8 * 1024 * 1024 { carry.removeAll() }

            // Ci si ferma sui **blocchi da mostrare**, non sulle righe lette:
            // in una sessione di lavoro quasi tutte le righe `user` sono esiti
            // di strumenti, che da soli non si vedono.
            w = reduce(rows: rows, wantItems: wantItems)
            if atStart { reachedStart = true; if boundary != 0 { boundary = 0 }; break }
            if w.items.count >= wantItems { break }
        }

        w.endOffset = endOffset
        w.hasMore = !(reachedStart || boundary == 0)
        if w.firstOffset == 0 && !rows.isEmpty { w.firstOffset = rows[0].off }
        if rows.isEmpty { w.firstOffset = boundary }
        return w
    }

    /// Le righe aggiunte dopo un certo punto: e' cio' che serve alla
    /// sorveglianza dal vivo, che deve mandare solo le novita'.
    /// Il battito di un pezzo di transcript appena arrivato: quello che serve
    /// a dire sul telefono «sta lavorando da 1m 12s, 3,4k token, ⚙ Bash» —
    /// come lo dice il Mac.
    struct Pulse {
        var userText = false          // e' partito un turno nuovo
        var tokens = 0                // output_tokens sommati dai blocchi assistant
        var toolStarts: [String] = [] // strumenti partiti, in ordine
        var toolResults = 0           // strumenti finiti
        var ended = false             // e' comparso il marcatore di fine risposta
    }

    private static func pulse(rows: [(off: UInt64, obj: [String: Any])]) -> Pulse {
        var p = Pulse()
        for (_, obj) in rows {
            switch obj["type"] as? String {
            case "user":
                guard let m = obj["message"] as? [String: Any] else { break }
                if let t = m["content"] as? String, !t.isEmpty { p.userText = true }
                if let blocks = m["content"] as? [[String: Any]] {
                    for b in blocks {
                        if b["type"] as? String == "text", (b["text"] as? String)?.isEmpty == false {
                            p.userText = true
                        }
                        if b["type"] as? String == "tool_result" { p.toolResults += 1 }
                    }
                }
            case "assistant":
                guard let m = obj["message"] as? [String: Any] else { break }
                if let u = m["usage"] as? [String: Any], let n = u["output_tokens"] as? Int {
                    p.tokens += n
                }
                for b in (m["content"] as? [[String: Any]]) ?? [] {
                    if b["type"] as? String == "tool_use" {
                        p.toolStarts.append((b["name"] as? String) ?? "strumento")
                    }
                }
            case "last-prompt":
                // Chiude ogni risposta: e' il marcatore di fine piu' affidabile
                // che il transcript offra (verificato su una chat lunga vera e su prova-A).
                p.ended = true
            default: break
            }
        }
        return p
    }

    static func itemsAfter(url: URL, offset: UInt64)
        -> (items: [[String: Any]], endOffset: UInt64, pulse: Pulse) {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return ([], offset, Pulse()) }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        guard size > offset else { return ([], size, Pulse()) }
        // Se il file e' stato sostituito o troncato si riparte dal fondo.
        guard size - offset < 64 * 1024 * 1024 else { return ([], size, Pulse()) }
        guard let data = try? read(handle, at: offset, count: Int(size - offset)) else { return ([], size, Pulse()) }

        var rows: [(off: UInt64, obj: [String: Any])] = []
        var cursor = data.startIndex
        var lineStart = offset
        // `last-prompt` sta fra i tipi scartati (giusto: nella vista non serve),
        // ma per il battito e' il marcatore di fine risposta: lo si guarda QUI,
        // prima del filtro, o non lo si vede mai.
        var sawEnd = false
        while let nl = data[cursor...].firstIndex(of: 0x0A) {
            let slice = Data(data[cursor..<nl])
            if quickType(slice) == "last-prompt" { sawEnd = true }
            if let obj = parse(slice) { rows.append((lineStart, obj)) }
            lineStart += UInt64(data.distance(from: cursor, to: nl)) + 1
            cursor = data.index(after: nl)
        }
        let consumed = offset + UInt64(data.distance(from: data.startIndex, to: cursor))
        let w = reduce(rows: rows, wantItems: Int.max)
        var p = pulse(rows: rows)
        p.ended = p.ended || sawEnd
        return (w.items, consumed, p)
    }

    // MARK: Lettura grezza

    private static func read(_ handle: FileHandle, at offset: UInt64, count: Int) throws -> Data {
        try handle.seek(toOffset: offset)
        return handle.readData(ofLength: count)
    }

    /// Divide un blocco di byte in righe. Il primo frammento non e' una riga
    /// intera — il suo inizio sta piu' indietro nel file — a meno che non si
    /// sia arrivati davvero all'inizio: viene restituito a parte, per essere
    /// completato al giro dopo.
    private static func splitLines(_ buf: Data, start: UInt64, headIsComplete: Bool)
        -> (lines: [(off: UInt64, data: Data)], head: Data) {
        var lines: [(off: UInt64, data: Data)] = []
        var segStart = buf.startIndex
        var head = Data()
        var isFirst = true

        while let nl = buf[segStart...].firstIndex(of: 0x0A) {
            let segment = Data(buf[segStart..<nl])
            let offset = start + UInt64(buf.distance(from: buf.startIndex, to: segStart))
            if isFirst && !headIsComplete {
                head = segment
            } else if !segment.isEmpty {
                lines.append((offset, segment))
            }
            isFirst = false
            segStart = buf.index(after: nl)
        }

        // Coda senza a capo finale: e' l'ultima riga del blocco, gia' completa
        // perche' il confine e' sempre su inizio riga.
        if segStart < buf.endIndex {
            let segment = Data(buf[segStart...])
            let offset = start + UInt64(buf.distance(from: buf.startIndex, to: segStart))
            if isFirst && !headIsComplete {
                head = segment
            } else if !segment.isEmpty {
                lines.append((offset, segment))
            }
        }
        return (lines, head)
    }

    /// Riconosce il tipo guardando solo l'inizio della riga. Su un file con
    /// 54.000 righe di allegati questo evita di analizzare centinaia di MB.
    private static func quickType(_ data: Data) -> String? {
        let head = data.prefix(160)
        guard let s = String(data: head, encoding: .utf8) ?? String(data: head, encoding: .isoLatin1),
              let r = s.range(of: "\"type\":\"") ?? s.range(of: "\"type\": \"") else { return nil }
        let rest = s[r.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[rest.startIndex..<end])
    }

    private static func parse(_ data: Data) -> [String: Any]? {
        guard !data.isEmpty else { return nil }
        if let t = quickType(data), ignoredTypes.contains(t) { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let t = obj["type"] as? String, ignoredTypes.contains(t) { return nil }
        return obj
    }

    // MARK: Riduzione: da JSON a cose da guardare

    private static func reduce(rows: [(off: UInt64, obj: [String: Any])], wantItems: Int) -> TranscriptWindow {
        var w = TranscriptWindow()

        // Primo giro: gli esiti degli strumenti, per appaiarli alle chiamate.
        var results: [String: [String: Any]] = [:]
        for row in rows {
            guard (row.obj["type"] as? String) == "user",
                  let msg = row.obj["message"] as? [String: Any],
                  let blocks = msg["content"] as? [[String: Any]] else { continue }
            for b in blocks where (b["type"] as? String) == "tool_result" {
                guard let id = b["tool_use_id"] as? String else { continue }
                results[id] = ["text": flatten(b["content"], limit: 4000),
                               "error": (b["is_error"] as? Bool) ?? false]
            }
        }

        // Secondo giro: si emette.
        var items: [[String: Any]] = []
        for row in rows {
            let obj = row.obj
            guard let type = obj["type"] as? String else { continue }
            let at = millis(obj["timestamp"])
            if let c = obj["cwd"] as? String, !c.isEmpty { w.cwd = c }

            switch type {
            case "user":
                guard let msg = obj["message"] as? [String: Any] else { continue }
                if let s = msg["content"] as? String {
                    if let item = userTextItem(s, at: at, off: row.off) { items.append(item) }
                } else if let blocks = msg["content"] as? [[String: Any]] {
                    for (i, b) in blocks.enumerated() {
                        switch b["type"] as? String {
                        case "text":
                            if let s = b["text"] as? String,
                               let item = userTextItem(s, at: at, off: row.off) { items.append(item) }
                        case "image":
                            items.append(["k": "image", "t": at, "who": "user",
                                          "off": row.off, "i": i,
                                          "mime": mimeOf(b)])
                        case "document":
                            items.append(["k": "file", "t": at, "who": "user",
                                          "name": documentName(b)])
                        default: break
                        }
                    }
                }

            case "assistant":
                guard let msg = obj["message"] as? [String: Any] else { continue }
                if let m = msg["model"] as? String, !m.isEmpty { w.model = m }
                var pendingText = ""
                let blocks = (msg["content"] as? [[String: Any]]) ?? []
                for (i, b) in blocks.enumerated() {
                    switch b["type"] as? String {
                    case "text":
                        let s = (b["text"] as? String) ?? ""
                        if !s.isEmpty { pendingText += (pendingText.isEmpty ? "" : "\n\n") + s }
                    case "thinking":
                        flushAssistant(&pendingText, at: at, into: &items, model: msg["model"] as? String)
                        let s = (b["thinking"] as? String) ?? ""
                        if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            items.append(["k": "think", "t": at, "text": cap(s, 12000)])
                        }
                    case "tool_use":
                        flushAssistant(&pendingText, at: at, into: &items, model: msg["model"] as? String)
                        items.append(toolItem(b, at: at, results: results, index: i))
                    case "image":
                        flushAssistant(&pendingText, at: at, into: &items, model: msg["model"] as? String)
                        items.append(["k": "image", "t": at, "who": "assistant",
                                      "off": row.off, "i": i, "mime": mimeOf(b)])
                    default: break
                    }
                }
                flushAssistant(&pendingText, at: at, into: &items, model: msg["model"] as? String)

            case "system":
                // Solo cio' che una persona deve sapere: errori e avvisi.
                let level = (obj["level"] as? String) ?? ""
                guard level == "error" || level == "warning" else { continue }
                let text = flatten(obj["content"], limit: 600)
                if !text.isEmpty {
                    items.append(["k": "sys", "t": at, "level": level, "text": text])
                }

            default:
                break
            }
        }

        if items.count > wantItems && wantItems != Int.max {
            items = Array(items.suffix(wantItems))
        }
        w.items = items
        w.firstOffset = rows.first?.off ?? 0
        return w
    }

    private static func flushAssistant(_ text: inout String, at: Double,
                                       into items: inout [[String: Any]], model: String?) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = ""
        guard !trimmed.isEmpty else { return }
        var item: [String: Any] = ["k": "claude", "t": at, "text": cap(trimmed, 60000)]
        if let m = model, !m.isEmpty { item["model"] = m }
        items.append(item)
    }

    // MARK: Messaggi della persona

    /// Ripulisce cio' che il sistema infila dentro i messaggi dell'utente.
    /// Senza questo passaggio l'anteprima di una chat diventa
    /// «<system-reminder>As you answer…» invece del messaggio vero — o, peggio,
    /// «<task-notification<task-id>toolu_016rB1hk…», che era il caso di una
    /// chat vera nell'elenco.
    ///
    /// Regola: solo `me` e' un messaggio scritto da una persona. Tutto il resto
    /// esce con un'altra etichetta e **non** finira' mai in un'anteprima.
    private static func userTextItem(_ raw: String, at: Double, off: UInt64) -> [String: Any]? {
        var s = strip(raw, from: "<system-reminder>", to: "</system-reminder>")
        s = strip(s, from: "<user-prompt-submit-hook>", to: "</user-prompt-submit-hook>")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }

        // Attivita' programmate: sono l'automazione, non una persona che scrive.
        if s.hasPrefix("<scheduled-task") {
            let name = attribute("name", in: s) ?? "scheduled"
            return ["k": "auto", "t": at, "code": "scheduled_task", "name": name]
        }
        // Il rapportino di un lavoro finito in sottofondo: identificativi di
        // strumento e percorsi di file temporanei. Non e' roba da leggere.
        if s.hasPrefix("<task-notification") {
            return ["k": "note", "t": at, "code": "background_done"]
        }
        // I comandi tipo /clear non sono un messaggio: sono un gesto.
        if s.hasPrefix("<command-name>") {
            let name = between(s, "<command-name>", "</command-name>") ?? ""
            let args = between(s, "<command-args>", "</command-args>") ?? ""
            let label = (name + " " + args).trimmingCharacters(in: .whitespaces)
            guard !label.isEmpty else { return nil }
            return ["k": "cmd", "t": at, "text": cap(label, 200)]
        }
        if s.hasPrefix("<local-command-stdout>") {
            let out = between(s, "<local-command-stdout>", "</local-command-stdout>") ?? ""
            let t = out.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return nil }
            return ["k": "out", "t": at, "text": cap(t, 2000)]
        }
        // Un richiamo interno che non e' un messaggio scritto da qualcuno.
        // Arriva sia nudo sia dentro il suo tag, e va scartato in entrambi i casi.
        if s.hasPrefix("<local-command-caveat") { return nil }
        if s.hasPrefix("Caveat:") && s.contains("<command-") { return nil }
        // La didascalia che il Desktop mette accanto a un'immagine incollata:
        // l'immagine si vede gia' per conto suo.
        if s.hasPrefix("[Image: original ") && s.hasSuffix("]") { return nil }
        // Quando si preme Esc, Claude Code scrive un segnaposto in inglese.
        // In un'app di chat si legge come un messaggio: meglio dire cos'e'.
        if s.hasPrefix("[Request interrupted by user") {
            return ["k": "cmd", "t": at, "code": "interrupted"]
        }
        // Qualunque altro blocco di servizio che comincia con un tag: fuori
        // dalla lettura, ma non si finge che non ci sia.
        if s.hasPrefix("<"), let tag = attribute0(of: s), tag.count > 2, s.contains("</\(tag)>") {
            return ["k": "note", "t": at, "text": tag.replacingOccurrences(of: "-", with: " ")]
        }
        return ["k": "me", "t": at, "text": cap(s, 60000)]
    }

    /// Il nome del tag con cui comincia una stringa: `<task-notification>` -> `task-notification`.
    private static func attribute0(of s: String) -> String? {
        var name = ""
        for c in s.dropFirst() {
            if c == ">" || c == " " || c == "\n" { break }
            guard c.isLetter || c.isNumber || c == "-" || c == "_" else { return nil }
            name.append(c)
        }
        return name.isEmpty ? nil : name
    }

    // MARK: Strumenti, ridotti a una riga

    private static func toolItem(_ b: [String: Any], at: Double,
                                 results: [String: [String: Any]], index: Int) -> [String: Any] {
        let name = (b["name"] as? String) ?? "strumento"
        let input = (b["input"] as? [String: Any]) ?? [:]
        var item: [String: Any] = [
            "k": "tool", "t": at,
            "name": prettyToolName(name),
            "brief": brief(tool: name, input: input),
            "detail": prettyJSON(input, limit: 3000),
        ]
        if let id = b["id"] as? String, let r = results[id] {
            item["result"] = r["text"] ?? ""
            item["error"] = r["error"] ?? false
        } else {
            item["pending"] = true
        }
        return item
    }

    private static func prettyToolName(_ n: String) -> String {
        // Gli strumenti MCP arrivano come mcp__server__attrezzo.
        guard n.hasPrefix("mcp__") else { return n }
        let parts = n.dropFirst(5).components(separatedBy: "__")
        guard parts.count >= 2 else { return n }
        return parts[0] + " · " + parts[1...].joined(separator: " ")
    }

    /// La riga corta che si vede senza aprire: `⚙ Bash · git status`.
    private static func brief(tool: String, input: [String: Any]) -> String {
        func str(_ k: String) -> String? {
            guard let v = input[k] as? String, !v.isEmpty else { return nil }
            return v
        }
        var out: String?
        switch tool {
        case "Bash", "BashOutput", "KillShell":
            out = str("command").map(compactCommand) ?? str("description")
        case "Read", "Write", "NotebookEdit", "NotebookRead":
            out = str("file_path").map { ($0 as NSString).lastPathComponent }
        case "Edit", "MultiEdit":
            out = str("file_path").map { ($0 as NSString).lastPathComponent }
        case "Glob":
            out = str("pattern")
        case "Grep":
            out = str("pattern")
        case "Agent", "Task":
            out = str("description") ?? str("subagent_type")
        case "WebFetch":
            out = str("url")
        case "WebSearch":
            out = str("query")
        case "TodoWrite", "TaskCreate", "TaskUpdate":
            out = str("subject") ?? "elenco attività"
        case "Skill":
            out = str("skill")
        default:
            out = str("description") ?? str("query") ?? str("path") ?? str("file_path")
                ?? input.values.compactMap { $0 as? String }.first
        }
        let one = (out ?? "").replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)
        // Qui serve una riga corta e pulita, non l'avviso «troncato»: e' una
        // didascalia, non il contenuto.
        return one.count > 88 ? String(one.prefix(88)) + "…" : one
    }

    /// Quasi ogni comando comincia con `cd /un/percorso/lunghissimo && …`.
    /// In una riga da 88 caratteri quel prefisso si mangia tutto, e dieci
    /// strumenti di fila diventano dieci righe identiche: si butta via il
    /// trasloco e si tiene il comando vero.
    private static func compactCommand(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<4 {
            guard s.hasPrefix("cd ") else { break }
            let seps = ["&&", "\n", ";"].compactMap { s.range(of: $0) }
            guard let first = seps.min(by: { $0.lowerBound < $1.lowerBound }) else { break }
            let rest = String(s[first.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rest.isEmpty else { break }
            s = rest
        }
        return s.isEmpty ? raw : s
    }

    // MARK: Utilita'

    /// Riduce un contenuto di forma qualsiasi a testo leggibile.
    private static func flatten(_ any: Any?, limit: Int) -> String {
        switch any {
        case let s as String:
            return cap(s, limit)
        case let arr as [[String: Any]]:
            var parts: [String] = []
            for b in arr {
                if let t = b["text"] as? String { parts.append(t) }
                else if (b["type"] as? String) == "image" { parts.append("[immagine]") }
            }
            return cap(parts.joined(separator: "\n"), limit)
        case let arr as [Any]:
            return cap(arr.compactMap { $0 as? String }.joined(separator: "\n"), limit)
        case let d as [String: Any]:
            if let s = d["stdout"] as? String, !s.isEmpty {
                let err = (d["stderr"] as? String) ?? ""
                return cap(err.isEmpty ? s : s + "\n" + err, limit)
            }
            if let s = d["text"] as? String { return cap(s, limit) }
            return prettyJSON(d, limit: limit)
        case .some(let v):
            return cap(String(describing: v), limit)
        case .none:
            return ""
        }
    }

    private static func prettyJSON(_ obj: Any, limit: Int) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let d = try? JSONSerialization.data(withJSONObject: obj,
                                                  options: [.prettyPrinted, .withoutEscapingSlashes]),
              let s = String(data: d, encoding: .utf8) else {
            return cap(String(describing: obj), limit)
        }
        return cap(s, limit)
    }

    static func cap(_ s: String, _ n: Int) -> String {
        guard s.count > n else { return s }
        return String(s.prefix(n)) + "\n… (troncato)"
    }

    private static func millis(_ any: Any?) -> Double {
        if let d = any as? Double { return d }
        if let s = any as? String {
            if let date = ISO8601DateFormatter.riflesso.date(from: s) {
                return date.timeIntervalSince1970 * 1000
            }
        }
        return 0
    }

    private static func mimeOf(_ b: [String: Any]) -> String {
        if let src = b["source"] as? [String: Any], let m = src["media_type"] as? String { return m }
        return "image/png"
    }

    private static func documentName(_ b: [String: Any]) -> String {
        if let src = b["source"] as? [String: Any], let n = src["name"] as? String { return n }
        return (b["name"] as? String) ?? "documento"
    }

    private static func strip(_ s: String, from: String, to: String) -> String {
        var out = s
        while let a = out.range(of: from), let b = out.range(of: to, range: a.upperBound..<out.endIndex) {
            out.removeSubrange(a.lowerBound..<b.upperBound)
        }
        return out
    }

    private static func between(_ s: String, _ a: String, _ b: String) -> String? {
        guard let ra = s.range(of: a), let rb = s.range(of: b, range: ra.upperBound..<s.endIndex) else { return nil }
        return String(s[ra.upperBound..<rb.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func attribute(_ name: String, in s: String) -> String? {
        guard let r = s.range(of: "\(name)=\"") else { return nil }
        let rest = s[r.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[rest.startIndex..<end])
    }

    // MARK: Immagini

    /// Recupera i byte di un'immagine indicata da riga e posizione.
    /// Le immagini non viaggiano dentro l'elenco messaggi: sarebbero megabyte
    /// di base64 dentro un JSON. Si scaricano una per una, quando servono.
    static func image(url: URL, offset: UInt64, index: Int) -> (data: Data, mime: String)? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let _ = try? handle.seek(toOffset: offset) else { return nil }
        var line = Data()
        while line.count < 24 * 1024 * 1024 {
            let chunk = handle.readData(ofLength: 256 * 1024)
            if chunk.isEmpty { break }
            if let nl = chunk.firstIndex(of: 0x0A) {
                line.append(chunk[chunk.startIndex..<nl])
                break
            }
            line.append(chunk)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let msg = obj["message"] as? [String: Any],
              let blocks = msg["content"] as? [[String: Any]],
              index < blocks.count,
              let src = blocks[index]["source"] as? [String: Any],
              let b64 = src["data"] as? String,
              let data = Data(base64Encoded: b64) else { return nil }
        return (data, (src["media_type"] as? String) ?? "image/png")
    }
}

extension ISO8601DateFormatter {
    /// I timestamp dei transcript hanno i millisecondi.
    static let riflesso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
