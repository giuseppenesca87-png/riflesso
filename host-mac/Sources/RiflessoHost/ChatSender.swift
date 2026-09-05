import Foundation

/// Consegna un messaggio del telefono dentro una conversazione esistente,
/// usando il `claude` ufficiale gia' installato e autenticato su questo Mac.
///
/// Non esiste nessun'altra strada: niente token estratti, niente endpoint non
/// documentati, niente clic simulati. Il motore e' il CLI, l'umano preme invio.
///
/// Tre cose imparate provando (vedi PROGRESS §0) e che qui sono legge:
/// 1. il processo **deve** partire dentro la `cwd` della sessione, altrimenti
///    il CLI risponde «No conversation found»;
/// 2. il CLI **non ha un lucchetto**: due invii insieme biforcano il transcript
///    senza dare errore, quindi la fila la teniamo noi;
/// 3. il CLI **non aggiorna** l'indice del Desktop, quindi a fine invio
///    l'elenco chat va risistemato a mano.
final class ChatSender {
    static let shared = ChatSender()

    /// Un messaggio in attesa del suo turno.
    private struct Pending {
        let cliId: String
        let cwd: String
        let model: String
        let permissionMode: String
        let text: String
    }

    private let lock = NSLock()
    private var running: [String: Process] = [:]
    private var queues: [String: [Pending]] = [:]
    /// Quando **noi** abbiamo scritto l'ultima volta in una chat. Senza questo,
    /// l'eco della nostra stessa risposta farebbe sembrare la chat «in uso sul
    /// Mac» e il telefono si bloccherebbe da solo subito dopo aver inviato.
    private var lastSelfWrite: [String: Date] = [:]
    private let work = DispatchQueue(label: "riflesso.sender", qos: .userInitiated)

    /// Il Desktop tocca il `.jsonl` anche solo aprendo la conversazione: un
    /// file scritto pochi secondi fa vuol dire «questa chat ce l'ha in mano lui».
    static let liveWindow: TimeInterval = 30

    /// Impostato da AppHub: manda un evento a tutti i telefoni collegati.
    var emit: (([String: Any]) -> Void)?

    private init() {}

    // MARK: - Stato

    func isBusy(cliId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return running[cliId] != nil
    }

    var busyChatIds: [String] {
        lock.lock(); defer { lock.unlock() }
        return Array(running.keys)
    }

    /// Vero quando la conversazione si sta muovendo **sul Mac adesso**.
    ///
    /// Scrivere qui dentro e' la cosa peggiore che l'app possa fare: due
    /// scritture insieme biforcano il transcript **senza dare errore**
    /// (PROGRESS §0, scoperta n. 4). Ci si e' finiti al primo tentativo,
    /// mandando il messaggio proprio nella chat aperta davanti a lui.
    func liveOnMac(cliId: String) -> Bool {
        // Un invio nostro in corso non e' il Mac: quello lo gestisce la fila.
        if isBusy(cliId: cliId) { return false }
        guard let info = TranscriptIndex.shared.info(for: cliId) else { return false }
        // Fermo da un pezzo: non lo sta usando nessuno.
        guard Date().timeIntervalSince(info.modified) < ChatSender.liveWindow else { return false }

        lock.lock()
        let mine = lastSelfWrite[cliId] ?? .distantPast
        lock.unlock()
        // Il file e' caldo: la domanda vera e' **chi** l'ha scaldato. Se si e'
        // mosso dopo la nostra ultima scrittura, non siamo stati noi.
        //
        // Prima si guardava solo l'orologio — «abbiamo scritto meno di 30
        // secondi fa, quindi e' roba nostra» — e in quei trenta secondi una
        // risposta vera del Mac passava inosservata: cioe' proprio quando due
        // scritture insieme avrebbero biforcato il transcript.
        return info.modified > mine.addingTimeInterval(1)
    }

    private func markSelfWrite(_ cliId: String) {
        lock.lock(); lastSelfWrite[cliId] = Date(); lock.unlock()
    }

    // MARK: - Invio

    func send(cliId: String, cwd: String, model: String, permissionMode: String, text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        guard clean.count < 500_000 else {
            fail(cliId, PhoneNotice("message_too_long"))
            return
        }
        let job = Pending(cliId: cliId, cwd: cwd, model: model,
                          permissionMode: permissionMode, text: clean)

        lock.lock()
        let busy = running[cliId] != nil
        if busy {
            queues[cliId, default: []].append(job)
            let position = queues[cliId]?.count ?? 1
            lock.unlock()
            // Mai due scritture insieme sullo stesso transcript: si accoda e si dice.
            emit?(PhoneNotice("queued", ["n": position]).asDict(t: "chatQueued", chat: cliId))
            return
        }
        running[cliId] = Process()   // segnaposto: il posto e' occupato
        lock.unlock()

        work.async { self.run(job) }
    }

    func stop(cliId: String) {
        lock.lock()
        let proc = running[cliId]
        queues[cliId] = []
        lock.unlock()
        guard let proc, proc.isRunning else { return }
        proc.terminate()
        Log.info("invio interrotto a mano su", cliId)
    }

    // MARK: - Esecuzione

    private func run(_ job: Pending) {
        guard let binary = ChatSender.claudeBinary() else {
            finish(job.cliId)
            fail(job.cliId, PhoneNotice("cli_missing"))
            return
        }
        guard FileManager.default.fileExists(atPath: job.cwd) else {
            finish(job.cliId)
            fail(job.cliId, PhoneNotice("folder_gone", ["cwd": job.cwd]))
            return
        }

        // Il Mac sta gia' scrivendo in questa chat? Non si scrive alla cieca.
        waitForQuietTranscript(job.cliId)

        var attempt = 0
        var useModel = ChatSender.usableModel(job.model)
        while true {
            attempt += 1
            let outcome = launch(job, binary: binary, model: useModel)
            // Un nome di modello non accettato non deve far perdere il messaggio:
            // si riprova col predefinito, dicendolo.
            if outcome == .badModel && attempt == 1 && useModel != nil {
                emit?(PhoneNotice("cli_model_fallback").asDict(t: "chatNote", chat: job.cliId))
                useModel = nil
                continue
            }
            break
        }

        finish(job.cliId)
        ChatList.shared.touch(cliId: job.cliId)

        // Il prossimo della fila, se c'e'.
        lock.lock()
        let next = queues[job.cliId]?.isEmpty == false ? queues[job.cliId]!.removeFirst() : nil
        if next != nil { running[job.cliId] = Process() }
        lock.unlock()
        if let next { work.async { self.run(next) } }
    }

    private enum Outcome { case ok, badModel, failed }

    private func launch(_ job: Pending, binary: String, model: String?) -> Outcome {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.currentDirectoryURL = URL(fileURLWithPath: job.cwd)

        var args = ["--resume", job.cliId,
                    "-p",
                    "--output-format", "stream-json",
                    "--verbose",
                    "--include-partial-messages"]
        if let model { args += ["--model", model] }
        if let mode = ChatSender.usableMode(job.permissionMode) { args += ["--permission-mode", mode] }
        args.append(job.text)
        proc.arguments = args

        proc.environment = ChatSender.childEnvironment(binary: binary)

        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        proc.standardInput = FileHandle.nullDevice

        let state = StreamState(cliId: job.cliId, emit: emit)
        let parseQueue = DispatchQueue(label: "riflesso.sender.parse")

        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            parseQueue.async { state.feed(data) }
        }
        var stderrText = ""
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            parseQueue.async { stderrText += s }
        }

        emit?(["t": "chatStart", "chat": job.cliId, "text": job.text,
               "at": Int(Date().timeIntervalSince1970 * 1000)])

        do {
            try proc.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            fail(job.cliId, PhoneNotice("cli_start_failed", ["detail": error.localizedDescription]))
            return .failed
        }

        lock.lock(); running[job.cliId] = proc; lock.unlock()
        markSelfWrite(job.cliId)
        proc.waitUntilExit()
        // Anche alla fine: il file resta «caldo» per un po', e quell'eco e'
        // nostra, non del Mac.
        markSelfWrite(job.cliId)

        // Coda di analisi svuotata prima di guardare l'esito.
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        let rest = out.fileHandleForReading.readDataToEndOfFile()
        parseQueue.sync { if !rest.isEmpty { state.feed(rest) }; state.flush() }

        let errText = parseQueue.sync { stderrText }
        let status = proc.terminationStatus

        if state.sawResult {
            if state.resultIsError {
                let why = state.resultError
                emit?(PhoneNotice("cli_error", ["detail": why])
                    .asDict(t: "chatDone", chat: job.cliId,
                            extra: ["ok": false, "model": state.model ?? ""]))
                if why.lowercased().contains("model") { return .badModel }
                return .failed
            }
            emit?(["t": "chatDone", "chat": job.cliId, "ok": true,
                   "model": state.model ?? "",
                   "denials": state.denials,
                   "cost": state.cost])
            return .ok
        }

        // Nessun `result`: o e' stato fermato a mano, o e' andato storto davvero.
        if proc.terminationReason == .uncaughtSignal {
            emit?(PhoneNotice("stopped").asDict(t: "chatDone", chat: job.cliId,
                                               extra: ["ok": false, "stopped": true]))
            return .ok
        }
        let detail = errText.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = detail.lowercased()
        if lower.contains("--model") || lower.contains("invalid model") || lower.contains("unknown model") {
            return .badModel
        }
        if detail.isEmpty {
            fail(job.cliId, PhoneNotice("cli_silent", ["status": "\(status)"]))
        } else {
            fail(job.cliId, PhoneNotice("cli_error", ["detail": String(detail.prefix(500))]))
        }
        return .failed
    }

    private func finish(_ cliId: String) {
        lock.lock(); running[cliId] = nil; lock.unlock()
    }

    private func fail(_ cliId: String, _ notice: PhoneNotice) {
        Log.error("invio fallito su", cliId, notice.code)
        emit?(notice.asDict(t: "chatDone", chat: cliId, extra: ["ok": false]))
    }

    /// Se il file della chat sta cambiando adesso, qualcun altro ci sta
    /// scrivendo — quasi certamente il Mac. Si aspetta che si fermi.
    private func waitForQuietTranscript(_ cliId: String) {
        guard let info = TranscriptIndex.shared.info(for: cliId) else { return }
        var last = info.modified
        guard Date().timeIntervalSince(last) < 15 else { return }

        emit?(PhoneNotice("waiting_mac_busy").asDict(t: "chatNote", chat: cliId))
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 2)
            TranscriptIndex.shared.refreshNow()
            guard let now = TranscriptIndex.shared.cachedInfo(for: cliId) else { break }
            if now.modified == last, Date().timeIntervalSince(now.modified) > 10 { return }
            last = now.modified
        }
        emit?(PhoneNotice("sending_anyway").asDict(t: "chatNote", chat: cliId))
    }

    // MARK: - Dove sta il CLI, e con quale ambiente

    private static var cachedBinary: String?
    private static let binaryLock = NSLock()

    /// Un'app della barra dei menu non eredita il PATH del terminale: `nvm`,
    /// homebrew e compagnia non ci sono. Il comando va cercato davvero.
    static func claudeBinary() -> String? {
        binaryLock.lock(); defer { binaryLock.unlock() }
        if let c = cachedBinary { return c }

        let fm = FileManager.default
        var candidates: [String] = []
        if let env = ProcessInfo.processInfo.environment["RIFLESSO_CLAUDE"] { candidates.append(env) }
        let home = fm.homeDirectoryForCurrentUser.path
        candidates += [
            "\(home)/.claude/local/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            "\(home)/.local/bin/claude",
        ]
        // nvm: si prende la versione piu' recente installata.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted(by: >) { candidates.append("\(nvm)/\(v)/bin/claude") }
        }
        for c in candidates where fm.isExecutableFile(atPath: c) {
            cachedBinary = c
            Log.info("CLI trovato:", c)
            return c
        }

        // Ultima spiaggia: chiederlo alla shell di login, che il PATH ce l'ha.
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
        probe.arguments = ["-lc", "command -v claude"]
        let pipe = Pipe()
        probe.standardOutput = pipe
        probe.standardError = FileHandle.nullDevice
        try? probe.run()
        probe.waitUntilExit()
        let found = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !found.isEmpty, fm.isExecutableFile(atPath: found) {
            cachedBinary = found
            Log.info("CLI trovato dalla shell di login:", found)
            return found
        }
        Log.error("comando claude non trovato")
        return nil
    }

    static func childEnvironment(binary: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        // Le sessioni del Desktop vivono in ~/.claude: se qualcuno ha puntato
        // altrove la configurazione, il CLI non troverebbe piu' nessuna chat.
        env.removeValue(forKey: "CLAUDE_CONFIG_DIR")
        let binDir = (binary as NSString).deletingLastPathComponent
        let path = env["PATH"] ?? ""
        env["PATH"] = ([binDir] + path.split(separator: ":").map(String.init)
                       + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
            .reduce(into: [String]()) { acc, p in if !acc.contains(p) { acc.append(p) } }
            .joined(separator: ":")
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        return env
    }

    /// `claude-opus-4-8[1m]` va ripulito; se non somiglia a un modello, meglio
    /// non passarlo affatto che inventarselo.
    static func usableModel(_ raw: String) -> String? {
        var m = raw.trimmingCharacters(in: .whitespaces)
        if let r = m.range(of: "[") { m = String(m[m.startIndex..<r.lowerBound]) }
        guard m.hasPrefix("claude-"), m.count > 8 else { return nil }
        return m
    }

    /// I modi accettati dal CLI, verificati con `claude --help`.
    static func usableMode(_ raw: String) -> String? {
        let ok: Set<String> = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]
        return ok.contains(raw) ? raw : nil
    }
}

// MARK: - Analisi dello stream

/// Trasforma lo `stream-json` del CLI in eventi piccoli per il telefono.
/// Il testo esce **mentre si forma**: e' cio' che fa sembrare la chat viva.
private final class StreamState {
    let cliId: String
    let emit: (([String: Any]) -> Void)?
    private var buffer = Data()

    private(set) var sawResult = false
    private(set) var resultIsError = false
    private(set) var resultError = ""
    private(set) var model: String?
    private(set) var denials: [String] = []
    private(set) var cost: Double = 0

    /// Quale blocco e' in corso, per indice: testo, ragionamento o strumento.
    private var blockKind: [Int: String] = [:]

    init(cliId: String, emit: (([String: Any]) -> Void)?) {
        self.cliId = cliId
        self.emit = emit
    }

    func feed(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[buffer.startIndex..<nl])
            buffer.removeSubrange(buffer.startIndex...nl)
            handle(line)
        }
        // Una riga singola smisurata non deve far crescere la memoria all'infinito.
        if buffer.count > 32 * 1024 * 1024 { buffer.removeAll() }
    }

    func flush() {
        guard !buffer.isEmpty else { return }
        let line = buffer
        buffer.removeAll()
        handle(line)
    }

    private func handle(_ line: Data) {
        guard !line.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case "system":
            guard (obj["subtype"] as? String) == "init" else { return }
            if let m = obj["model"] as? String { model = m }
            emit?(["t": "chatReady", "chat": cliId, "model": model ?? "",
                   "mode": obj["permissionMode"] as? String ?? ""])

        case "stream_event":
            guard let ev = obj["event"] as? [String: Any],
                  let kind = ev["type"] as? String else { return }
            switch kind {
            case "message_start":
                if let msg = ev["message"] as? [String: Any], let m = msg["model"] as? String {
                    model = m
                    emit?(["t": "chatModel", "chat": cliId, "model": m])
                }
            case "content_block_start":
                let idx = (ev["index"] as? Int) ?? 0
                let block = (ev["content_block"] as? [String: Any]) ?? [:]
                let bt = (block["type"] as? String) ?? "text"
                blockKind[idx] = bt
                if bt == "tool_use" {
                    emit?(["t": "chatTool", "chat": cliId, "i": idx,
                           "name": (block["name"] as? String) ?? "tool"])
                } else if bt == "thinking" {
                    emit?(["t": "chatThinking", "chat": cliId, "i": idx])
                } else if bt == "text" {
                    emit?(["t": "chatTextStart", "chat": cliId, "i": idx])
                }
            case "content_block_delta":
                let idx = (ev["index"] as? Int) ?? 0
                guard let delta = ev["delta"] as? [String: Any] else { return }
                switch delta["type"] as? String {
                case "text_delta":
                    if let s = delta["text"] as? String, !s.isEmpty {
                        emit?(["t": "chatDelta", "chat": cliId, "i": idx, "s": s])
                    }
                case "thinking_delta":
                    if let s = delta["thinking"] as? String, !s.isEmpty {
                        emit?(["t": "chatThinkDelta", "chat": cliId, "i": idx, "s": s])
                    }
                default: break
                }
            case "content_block_stop":
                let idx = (ev["index"] as? Int) ?? 0
                emit?(["t": "chatBlockEnd", "chat": cliId, "i": idx,
                       "kind": blockKind[idx] ?? "text"])
            default:
                break
            }

        case "assistant":
            // Riepilogo del blocco: serve per gli strumenti, di cui lo stream
            // a pezzetti non da' mai il riassunto in chiaro.
            guard let msg = obj["message"] as? [String: Any] else { return }
            if let m = msg["model"] as? String { model = m }
            for b in (msg["content"] as? [[String: Any]]) ?? [] {
                guard (b["type"] as? String) == "tool_use" else { continue }
                emit?(["t": "chatToolReady", "chat": cliId,
                       "name": (b["name"] as? String) ?? "tool",
                       "brief": StreamState.brief(b["input"] as? [String: Any] ?? [:])])
            }

        case "user":
            guard let msg = obj["message"] as? [String: Any],
                  let blocks = msg["content"] as? [[String: Any]] else { return }
            for b in blocks where (b["type"] as? String) == "tool_result" {
                let bad = (b["is_error"] as? Bool) ?? false
                emit?(["t": "chatToolDone", "chat": cliId, "ok": !bad])
            }

        case "result":
            sawResult = true
            resultIsError = (obj["is_error"] as? Bool) ?? false
            cost = (obj["total_cost_usd"] as? Double) ?? 0
            if let errs = obj["errors"] as? [Any], !errs.isEmpty {
                resultError = errs.compactMap { $0 as? String }.joined(separator: "\n")
                if resultError.isEmpty { resultError = String(describing: errs.first!) }
            } else if let r = obj["result"] as? String, resultIsError {
                resultError = r
            }
            // Uno strumento bloccato si dice, non si nasconde.
            if let d = obj["permission_denials"] as? [[String: Any]] {
                denials = d.map { item in
                    let name = (item["tool_name"] as? String) ?? "tool"
                    return name
                }
            }

        default:
            break
        }
    }

    private static func brief(_ input: [String: Any]) -> String {
        let keys = ["command", "file_path", "pattern", "description", "url", "query", "subject"]
        for k in keys {
            if let v = input[k] as? String, !v.isEmpty {
                let one = v.replacingOccurrences(of: "\n", with: " ")
                return String(one.prefix(90))
            }
        }
        return ""
    }
}
