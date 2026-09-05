import Foundation
import AppKit
import CoreGraphics

/// Tiene insieme cattura, rete e input. Un solo posto in cui passano
/// tutte le decisioni, cosi' la mappatura delle coordinate vive in un punto solo.
/// `@unchecked Sendable`: ogni campo mutabile passa da `stateQueue`.
final class AppHub: ServerDelegate, @unchecked Sendable {
    static let shared = AppHub()

    let server = Server(port: 7654)
    let injector = InputInjector.shared

    private let stateQueue = DispatchQueue(label: "riflesso.hub")
    private var knownWindows: [WindowRef] = []
    private var windowsRefreshedAt = Date.distantPast
    /// Le chat in cui sta rispondendo il Desktop, non noi.
    private var desktopAnswering: Set<String> = []
    /// L'orologio che ricontrolla l'elenco finche' c'e' un telefono collegato.
    private var listClock: DispatchSourceTimer?

    /// I file della webapp, letti una volta e tenuti gia' compressi, con la
    /// loro impronta. Si rileggono solo se misura o data cambiano: durante lo
    /// sviluppo basta salvare il file, in produzione non cambiano mai.
    private struct StaticAsset {
        var size: UInt64
        var modified: Date
        var etag: String
        var raw: Data
        var gzip: Data?
    }
    private var assets: [String: StaticAsset] = [:]

    /// Notifica la UI del menu bar.
    var onStateChange: (() -> Void)?

    private(set) var serverStatusCode = "stopped"
    private(set) var serverStatusDetail = ""
    var serverStatusText: String { L.server(code: serverStatusCode, port: server.port, detail: serverStatusDetail) }

    private init() {}

    // MARK: - Avvio

    func start() {
        server.delegate = self
        server.onStateChange = { [weak self] code, detail in
            self?.serverStatusCode = code
            self?.serverStatusDetail = detail
            DispatchQueue.main.async { self?.onStateChange?() }
        }
        // **La cattura non parte all'avvio.** Aprire Riflesso non deve
        // accendere la condivisione dello schermo: parte solo quando qualcuno
        // apre davvero lo specchio dal telefono, e si spegne appena lo chiude.
        // Vedi `rivalutaCattura()`.
        SessionsIndex.shared.prime()

        // L'app di chat: indice dei transcript, elenco, invio, diretta.
        TranscriptIndex.shared.prime()
        ChatList.shared.prime()
        ChatSender.shared.emit = { [weak self] event in self?.broadcastChat(event) }
        DesktopBridge.shared.emit = { [weak self] event in self?.broadcastChat(event) }
        TranscriptWatcher.shared.emit = { [weak self] event in self?.broadcastChat(event) }
        TranscriptWatcher.shared.start()

        // **L'elenco si spinge.** Finche' c'e' un telefono sulla diretta, ogni
        // cinque secondi si ricontrolla l'elenco (costa pochi millisecondi:
        // un giro di `stat` e le sole anteprime cambiate) e, se e' cambiato,
        // parte un evento; il telefono richiede solo allora. Senza telefoni
        // collegati non gira niente.
        ChatList.shared.onChanged = { [weak self] kind in
            self?.broadcastChat(["t": "chatsChanged", "kind": kind])
        }
        let orologio = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        orologio.schedule(deadline: .now() + 5, repeating: 5)
        orologio.setEventHandler { [weak self] in
            guard let self, !self.server.webSocketClients.isEmpty else { return }
            ChatList.shared.refresh()
        }
        orologio.resume()
        listClock = orologio

        // Le due strade del telefono (`Strade.swift`): la rete di casa, che
        // e' la 7654 e basta; e il ponte, due attese lunghe sul punto
        // d'incontro — una per i telefoni accoppiati, una sulla stanza del
        // codice — acceso insieme al servizio e spento con lui. Da spento non
        // fa **nessuna** chiamata a Internet; senza un indirizzo configurato,
        // nemmeno da acceso.
        RemoteLink.shared.onStateChange = { [weak self] in
            DispatchQueue.main.async { self?.onStateChange?() }
        }

        // Il codice si legge solo da questo Mac, e solo da un processo di
        // questo utente: e' la porta di `--print-pin`, e sostituisce
        // `GET /api/pin`, che dietro un inoltro leggeva chiunque.
        PinSocket.start()

        // Il servizio si apre solo se l'interruttore in cima al pannello e'
        // acceso. Da spento l'app parte lo stesso — il pannello serve proprio a
        // riaccenderla — ma non apre nessuna porta e non chiama nessuno.
        if servizioAcceso {
            accendi()
        } else {
            serverStatusCode = "stopped"
            Log.info("servizio spento: il Mac non serve niente al telefono")
        }

    }

    /// **L'interruttore in cima al pannello.** Non e' lo specchio: e' il
    /// servizio. Da spento il Mac smette di essere raggiungibile — la pagina
    /// non si apre piu', il punto d'incontro si chiude e i telefoni collegati
    /// vengono mandati via. Resta in piedi solo il pannello, che e' l'unico
    /// modo per riaccenderlo.
    ///
    /// La scelta si ricorda: se lo spegni, alla riapertura resta spento.
    var servizioAcceso: Bool {
        get { UserDefaults.standard.object(forKey: "riflesso.servizio.acceso") as? Bool ?? true }
        set {
            guard newValue != servizioAcceso else { return }
            UserDefaults.standard.set(newValue, forKey: "riflesso.servizio.acceso")
            if newValue { accendi() } else { spegni() }
            DispatchQueue.main.async { self.onStateChange?() }
        }
    }

    private func accendi() {
        do {
            try server.start()
            Log.info("servizio acceso: in ascolto sulla porta", server.port)
        } catch {
            serverStatusCode = "port_busy"
            serverStatusDetail = error.localizedDescription
            Log.error("server non avviato:", error.localizedDescription)
        }
        // Il ponte si accende col servizio (e senza un indirizzo non fa niente).
        RemoteLink.shared.start()
    }

    /// Spegnere deve **spegnere davvero**, non mettere in pausa: chi era
    /// collegato viene chiuso subito, altrimenti resterebbe li' a guardare uno
    /// schermo che nessuno aggiorna piu' e crederebbe che tutto vada bene.
    private func spegni() {
        server.disconnectAll()
        stop()
        serverStatusCode = "stopped"
        serverStatusDetail = ""
        Log.info("servizio spento dal pannello: porta chiusa, punto d'incontro chiuso, telefoni scollegati")
    }

    /// Gli eventi di chat vanno a tutti i telefoni collegati: se ce ne sono due,
    /// devono vedere la stessa conversazione crescere.
    private func broadcastChat(_ event: [String: Any]) {
        for c in server.webSocketClients { c.sendWSJSON(event) }
        if let t = event["t"] as? String, t == "chatDone", let id = event["chat"] as? String {
            TranscriptWatcher.shared.pokeSoon(cliId: id)
        }
    }

    /// Cartella, modello e permessi con cui riprendere una sessione.
    ///
    /// La cartella la decide **il posto in cui il CLI tiene il transcript**,
    /// non la `cwd` sbirciata dal transcript: dentro una sessione un `cd`
    /// sposta la cartella di lavoro e il CLI la scrive nei record successivi,
    /// quindi in fondo al file si legge spesso una sottocartella. Ripreso da
    /// li', il CLI risponde «No conversation found». Vedi `ProjectFolder`.
    private func chatContext(cliId: String) -> (cwd: String, model: String, mode: String)? {
        guard let folder = ProjectFolder.folder(cliId: cliId) else { return nil }
        let entry = SessionsIndex.shared.entry(cliSessionId: cliId)
        return (folder.path, entry?.model ?? "", entry?.permissionMode ?? "default")
    }

    // MARK: - L'invio dal telefono

    /// **Chi lavora e' Claude Desktop.** Il messaggio del telefono viene
    /// consegnato dentro il suo compositore e mandato da li': cosi' e' il Mac a
    /// rispondere, a disegnare e ad aggiornare il suo indice, e le due parti non
    /// possono divergere perche' il motore e' uno solo.
    ///
    /// Il vecchio motore (`claude --resume`) resta **solo come ripiego**,
    /// quando il Desktop non e' in esecuzione — e in quel caso si dice.
    private func sendMessage(cliId: String, text: String,
                             attachment: Uploads.Pending? = nil,
                             to client: ClientConnection) {
        // La strada si sceglie **subito**, con la copia in memoria: qui c'è un
        // messaggio che aspetta di partire, e non è il momento di rileggere
        // seicento file. Se questa conversazione non risulta fra quelle del
        // Desktop si va di ripiego — dicendolo per quello che è (vedi
        // `sendWithCLI`), non fingendo che Claude sia chiuso.
        let entry = SessionsIndex.shared.entry(cliSessionId: cliId)
        if DesktopBridge.shared.isRunning, let entry, !entry.title.isEmpty {
            client.sendWSJSON(PhoneNotice("delivering").asDict(t: "chatNote", chat: cliId))
            DesktopBridge.shared.async {
                defer { if let a = attachment { Uploads.shared.discard(id: a.id) } }
                switch DesktopBridge.shared.send(cliId: cliId, entry: entry, text: text,
                                                 attachment: attachment) {
                case .delivered:
                    // Da qui in poi lavora il Desktop: il telefono vede la
                    // risposta perche' il transcript lo guardiamo gia'.
                    self.broadcastChat(["t": "chatStart", "chat": cliId, "text": text,
                                        "at": Int(Date().timeIntervalSince1970 * 1000)])
                    ChatList.shared.touch(cliId: cliId)
                    self.waitForDesktopAnswer(cliId: cliId, sessionId: entry.sessionId)
                case .refused(let why):
                    Log.warn("Desktop: consegna rifiutata ·", why.code)
                    self.broadcastChat(why.asDict(t: "chatDone", chat: cliId, extra: ["ok": false]))
                case .notRunning:
                    // Un allegato non sa passare dal CLI: e' stato controllato
                    // prima di arrivare qui, ma se il Desktop si chiude proprio
                    // adesso si dice invece di mandare il testo mutilato.
                    if attachment != nil {
                        self.broadcastChat(PhoneNotice("attachment_needs_desktop")
                            .asDict(t: "chatDone", chat: cliId, extra: ["ok": false]))
                    } else {
                        self.sendWithCLI(cliId: cliId, text: text)
                    }
                }
            }
            return
        }

        sendWithCLI(cliId: cliId, text: text)
    }

    /// Il ripiego, e va detto in faccia: senza il Desktop la conversazione va
    /// avanti lo stesso, ma sul Mac si vedra' solo riaprendola.
    private func sendWithCLI(cliId: String, text: String) {
        guard let ctx = chatContext(cliId: cliId) else {
            broadcastChat(PhoneNotice("conversation_gone").asDict(t: "chatDone", chat: cliId, extra: ["ok": false]))
            return
        }
        // Qui i motori tornano a essere due, quindi torna anche il pericolo:
        // due scritture insieme biforcano il transcript senza dare errore.
        guard !ChatSender.shared.liveOnMac(cliId: cliId) else {
            Log.warn("invio rifiutato: chat in uso sul Mac", cliId)
            broadcastChat(PhoneNotice("conversation_in_use").asDict(t: "chatDone", chat: cliId,
                                                                   extra: ["ok": false, "live": true]))
            return
        }
        // Due motivi diversi per ripiegare, e vanno detti diversi: «Claude non
        // c'è» quando davvero non c'è, e «questa conversazione lui non ce
        // l'ha» quando è aperto ma non la conosce (succede per meta' delle
        // conversazioni). Dire la prima al posto della seconda è una bugia
        // che manda a cercare un problema che non esiste.
        broadcastChat(PhoneNotice(DesktopBridge.shared.isRunning ? "fallback_unknown" : "fallback_closed")
            .asDict(t: "chatNote", chat: cliId))
        Log.info("ripiego CLI: invio verso", cliId, "in", ctx.cwd,
                 "·", ProjectFolder.folder(cliId: cliId)?.why ?? "")
        // **Dal telefono, mai senza conferma.** Qui si ereditava la modalita'
        // permessi con cui la sessione girava sul Mac — e se era
        // `bypassPermissions` un messaggio scritto dal telefono poteva eseguire
        // comandi sul Mac senza che comparisse nessuna richiesta. Sul percorso
        // remoto la modalita' e' sempre quella normale: Claude risponde, e per
        // qualunque cosa che chieda un permesso si ferma, perche' davanti al
        // Mac non c'e' nessuno a dargli il consenso.
        ChatSender.shared.send(cliId: cliId, cwd: ctx.cwd, model: ctx.model,
                               permissionMode: "default", text: text)
    }

    func desktopIsAnswering(cliId: String) -> Bool {
        stateQueue.sync { desktopAnswering.contains(cliId) }
    }

    /// Aspetta che il Desktop finisca. Il testo della risposta arriva da solo
    /// (lo scrive lui nel transcript, e il sorvegliante lo spinge sul telefono):
    /// qui si aspetta soltanto il momento in cui togliere «sta lavorando…».
    ///
    /// Il segnale buono e' quello che dichiara il Desktop stesso a fine turno.
    /// Il silenzio del file e' la rete di sotto, per quando quella riga non
    /// arriva: meglio togliere lo spinner con qualche secondo di ritardo che
    /// lasciarlo girare per sempre.
    private func waitForDesktopAnswer(cliId: String, sessionId: String) {
        stateQueue.sync { _ = desktopAnswering.insert(cliId) }
        defer { stateQueue.sync { desktopAnswering.remove(cliId) } }

        let turnsBefore = DesktopBridge.shared.completions(sessionId: sessionId)
        let start = Date()
        let deadline = start.addingTimeInterval(30 * 60)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 1.5)
            if DesktopBridge.shared.completions(sessionId: sessionId) > turnsBefore {
                broadcastChat(["t": "chatDone", "chat": cliId, "ok": true, "desktop": true])
                TranscriptWatcher.shared.pokeSoon(cliId: cliId)
                return
            }
            TranscriptIndex.shared.refreshNow()
            let modified = TranscriptIndex.shared.cachedInfo(for: cliId)?.modified ?? .distantPast
            guard Date().timeIntervalSince(start) > 10 else { continue }
            if Date().timeIntervalSince(modified) > 25 {
                broadcastChat(["t": "chatDone", "chat": cliId, "ok": true, "desktop": true])
                return
            }
        }
        broadcastChat(PhoneNotice("desktop_still_working").asDict(t: "chatDone", chat: cliId,
                                                                  extra: ["ok": true, "desktop": true]))
    }

    func stop() {
        RemoteLink.shared.stop()
        server.stop()
    }

    // MARK: - Indirizzi

    var localHostName: String {
        let name = (Host.current().localizedName ?? "mac")
        let cleaned = name.replacingOccurrences(of: " ", with: "-")
        return cleaned.hasSuffix(".local") ? cleaned : cleaned + ".local"
    }

    /// Indirizzi IPv4 privati utilizzabili dal telefono.
    var lanAddresses: [String] {
        var results: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return results }
        defer { freeifaddrs(ifaddr) }
        var ptr = first
        while true {
            let flags = Int32(ptr.pointee.ifa_flags)
            if let sa = ptr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
               (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count),
                               nil, 0, NI_NUMERICHOST) == 0 {
                    let ip = String(cString: host)
                    if ip.hasPrefix("10.") || ip.hasPrefix("192.168.") || ip.hasPrefix("172.") {
                        results.append(ip)
                    }
                }
            }
            guard let next = ptr.pointee.ifa_next else { break }
            ptr = next
        }
        return results
    }

    var primaryURL: String { "http://\(localHostName):\(server.port)" }

    /// Un delta assurdo (dito che salta, pacchetto vecchio) non deve far
    /// schizzare la conversazione all'altro capo della pagina.
    private func clampDelta(_ v: Double) -> Double {
        guard v.isFinite else { return 0 }
        return min(max(v, -600), 600)
    }

    // MARK: - HTTP

    func handleHTTP(_ request: HTTPRequest, from client: ClientConnection) -> HTTPResponse? {
        switch (request.method, request.path) {
        case ("GET", "/health"):
            return .json(["ok": true, "app": "Riflesso", "port": Int(server.port),
                          "version": Build.version,
                          "build": Build.stamp,
                          "binary": Build.executablePath,
                          "webapp": Build.webapp,
                          "webappBuild": Build.webappStamp])

        // **Il codice non si legge via HTTP.** Qui c'era `GET /api/pin`,
        // difeso da «chi bussa da 127.0.0.1 e' questo Mac»: con un inoltro
        // davanti alla 7654 (`tailscale serve`, allora) l'inoltro bussa da
        // 127.0.0.1, e il codice lo leggeva chiunque arrivasse all'inoltro
        // (provato il 02/09/2026 con un `curl`). Chi ne ha bisogno passa da
        // `PinSocket`. La pagina ponte, per parte sua, si rifiuta comunque di
        // inoltrare `/api/pin`.
        //
        // L'accoppiamento arriva da due strade e non le distingue: dalla rete
        // di casa e' una POST normale, dal ponte e' la stessa POST dentro il
        // canale diretto aperto sulla stanza del codice. In tutti i casi e'
        // `AuthStore` a contare i tentativi e a bruciare il codice.
        case ("POST", "/api/pair"):
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let pin = (body["pin"] as? String) ?? ""
            let label = (body["label"] as? String) ?? "iPhone"
            // Chi e' il browser, se lo sa dire: serve a non moltiplicare lo
            // stesso telefono a ogni riaccoppiamento.
            let devId = (body["id"] as? String).map { String($0.prefix(64)) }
            let via = describeVia(request, client)
            switch AuthStore.shared.pair(pin: pin, label: label, deviceId: devId) {
            case .ok(let token):
                Log.info("nuovo dispositivo accoppiato:", label, "·", via)
                DispatchQueue.main.async { self.onStateChange?() }
                // `meet` e' il segreto del Mac: da li' il telefono ricava la
                // stanza unica sul ponte. Viaggia dentro il canale gia' aperto
                // (o sulla rete privata), mai verso il punto d'incontro.
                return .json(["ok": true, "token": token,
                              "meet": AuthStore.shared.meetSecret])
            case .wrongPIN(let remaining):
                Log.warn("accoppiamento rifiutato: codice errato ·", via)
                return .json(["ok": false, "code": "pin_wrong", "remaining": remaining], status: 401)
            case .expired:
                return .json(["ok": false, "code": "pin_expired"], status: 401)
            case .locked(let seconds):
                return .json(["ok": false, "burned": true, "code": "pin_locked",
                              "seconds": seconds], status: 429)
            }

        // «Dimentica questo dispositivo» detto per davvero: il telefono lascia
        // il posto anche sul Mac, invece di restare nell'elenco. Scollega
        // **solo** chi chiede: il gettone e' la prova di essere lui.
        case ("POST", "/api/forget"):
            guard let token = request.bearerToken, AuthStore.shared.isValid(token: token) else {
                return unauthorized()
            }
            let label = AuthStore.shared.device(for: token)?.label ?? "Dispositivo"
            // **Prima si risponde, poi si scollega.** Revocare qui chiuderebbe
            // la diretta di quel telefono mentre «fatto» e' ancora per strada,
            // e il telefono vedrebbe un errore per un'operazione riuscita. Un
            // secondo basta e avanza.
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                AuthStore.shared.revoke(token: token)
                self.server.disconnect(token: token)
                Log.info("dispositivo scollegato su sua richiesta:", label)
                DispatchQueue.main.async { self.onStateChange?() }
            }
            return .json(["ok": true])

        case ("GET", "/api/status"):
            guard authorized(request) else { return unauthorized() }
            return .json(statusPayload())

        // Un allegato che sale dal telefono, **un pezzo per volta**. Il perche'
        // dei pezzi sta in `Uploads`: una richiesta HTTP qui si ferma a 1 MB.
        case ("POST", "/api/upload"):
            guard authorized(request) else { return unauthorized() }
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let index = (body["i"] as? Int) ?? 0
            let total = (body["n"] as? Int) ?? 1
            guard let b64 = body["b"] as? String,
                  let bytes = Data(base64Encoded: b64) else {
                return .json(["ok": false, "code": "upload_failed"], status: 400)
            }
            do {
                let p = try Uploads.shared.accept(
                    id: (body["id"] as? String) ?? "",
                    name: (body["name"] as? String) ?? "allegato",
                    mime: (body["mime"] as? String) ?? "application/octet-stream",
                    declaredSize: (body["size"] as? Int) ?? bytes.count,
                    index: index, total: total, bytes: bytes)
                if p.complete {
                    Log.info("allegato ricevuto:", p.name, "·", p.written, "byte in", p.chunks, "pezzi")
                }
                return .json(["ok": true, "id": p.id, "name": p.name,
                              "got": p.written, "done": p.complete])
            } catch let e as Uploads.Failure {
                return .json(["ok": false, "code": e.rawValue,
                              "max": Uploads.maxBytes], status: 400)
            } catch {
                return .json(["ok": false, "code": "upload_failed"], status: 500)
            }

        // **La dettatura.** L'audio e' gia' salito con `/api/upload`, a pezzi,
        // come un allegato; qui lo si trascrive sul Mac (`Trascrizione`) e si
        // rimanda il **testo**, che sul telefono finisce nel riquadro di
        // scrittura per essere riletto prima dell'invio. L'audio non entra mai
        // in Claude. La risposta e' **rimandata** (`nil`): la trascrizione
        // dura da mezzo secondo a qualche secondo e non deve tenere ferma la
        // coda del server, dove passa anche la diretta degli altri.
        case ("POST", "/api/transcribe"):
            guard authorized(request) else { return unauthorized() }
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let id = (body["id"] as? String) ?? ""
            let lingua = String(((body["lang"] as? String) ?? "").prefix(16))
            guard let p = Uploads.shared.file(id: id) else {
                return .json(["ok": false, "code": "upload_missing"], status: 400)
            }
            Log.info("dettatura: ricevuti", p.written, "byte (\(p.mime)), lingua", lingua.isEmpty ? "?" : lingua)
            Trascrizione.trascrivi(url: p.url, lingua: lingua) { esito in
                Uploads.shared.discard(id: id)
                let r: HTTPResponse
                switch esito {
                case .testo(let s):
                    r = .json(["ok": true, "text": s])
                case .rifiuto(let code, let detail):
                    Log.warn("dettatura rifiutata:", code, "·", detail)
                    r = .json(["ok": false, "code": code, "detail": detail], status: 422)
                }
                self.server.reply(r, to: client, for: request)
            }
            return nil

        // Il punto d'incontro: si legge da qualunque telefono accoppiato (gli
        // serve per la diagnostica) e si imposta da qui o dal pannello sul Mac.
        case ("GET", "/api/remote"):
            guard authorized(request) else { return unauthorized() }
            var p = RemoteLink.shared.payload
            p["ok"] = true
            return .json(p)

        case ("POST", "/api/remote"):
            guard authorized(request) else { return unauthorized() }
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            var base: String?
            if let raw = body["base"] as? String {
                let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard cleaned.isEmpty || RemoteLink.isAcceptable(base: cleaned) else {
                    return .json(["ok": false, "code": "remote_https"], status: 400)
                }
                base = cleaned
            }
            RemoteLink.shared.configure(base: base, enabled: body["on"] as? Bool)
            DispatchQueue.main.async { self.onStateChange?() }
            var p = RemoteLink.shared.payload
            p["ok"] = true
            return .json(p)

        case ("GET", "/api/sessions"):
            guard authorized(request) else { return unauthorized() }
            let q = (request.query["q"] ?? "").lowercased()
            var list = SessionsIndex.shared.entries()
            if !q.isEmpty {
                list = list.filter {
                    $0.title.lowercased().contains(q) || $0.cwd.lowercased().contains(q)
                }
            }
            return .json(["ok": true,
                          "readOnly": true,
                          "ready": !SessionsIndex.shared.isCold,
                          "items": list.prefix(200).map { $0.dict }])

        // MARK: l'app di chat

        case ("GET", "/api/chats"):
            guard authorized(request) else { return unauthorized() }
            // Di suo l'elenco mostra **le conversazioni**. Le routine — le
            // sessioni aperte da un'attivita' programmata — stanno dietro una
            // voce del menu: sono 293 su 305 e altrimenti coprono tutto.
            let routines = (request.query["kind"] ?? "") == "routine"
            let rows = ChatList.shared.items(query: request.query["q"] ?? "", routines: routines)
            let counts = ChatList.shared.counts()
            let ready = !ChatList.shared.isCold && !(routines && ChatList.shared.routinesCold)
            return .json(["ok": true,
                          "ready": ready,
                          "kind": routines ? "routine" : "chat",
                          "chats": counts.chats,
                          "routines": counts.routines,
                          "cli": ChatSender.claudeBinary() != nil,
                          "busy": ChatSender.shared.busyChatIds,
                          // I gruppi del Desktop, nel suo stesso ordine. Le
                          // routine non ne hanno: li' l'elenco resta piatto.
                          "groups": routines ? [] : DesktopGroups.shared.groups().map { $0.dict },
                          "items": rows.map { $0.dict }])

        case ("GET", let p) where p.hasPrefix("/api/chat/"):
            guard authorized(request) else { return unauthorized() }
            let rest = String(p.dropFirst("/api/chat/".count))
            let parts = rest.split(separator: "/", maxSplits: 1).map(String.init)
            guard let cliId = parts.first, !cliId.isEmpty else {
                return .json(["ok": false, "code": "chat_unspecified"], status: 400)
            }
            guard let info = TranscriptIndex.shared.info(for: cliId) else {
                // Succede spesso: 469 sessioni su 638 non hanno il testo su disco.
                return .json(["ok": false, "empty": true, "code": "transcript_gone"], status: 404)
            }

            if parts.count > 1, parts[1].hasPrefix("image") {
                let off = UInt64(request.query["o"] ?? "") ?? 0
                let idx = Int(request.query["i"] ?? "") ?? 0
                guard let img = TranscriptReader.image(url: info.url, offset: off, index: idx) else {
                    return .text("immagine non trovata", status: 404)
                }
                return .file(img.data, contentType: img.mime)
            }

            let before = UInt64(request.query["before"] ?? "")
            let count = min(max(Int(request.query["n"] ?? "") ?? 40, 5), 120)
            let w = TranscriptReader.window(url: info.url, before: before, wantItems: count)
            let row = ChatList.shared.row(for: cliId)
            let fallbackTitle = (w.cwd as NSString?)?.lastPathComponent ?? ""
            return .json(["ok": true,
                          "id": cliId,
                          "title": row?.title ?? fallbackTitle,
                          "project": row?.project ?? "",
                          "model": w.model.map(ChatList.shortModel) ?? row?.model ?? "",
                          "items": w.items,
                          "first": w.firstOffset,
                          "end": w.endOffset,
                          "more": w.hasMore,
                          "effort": SessionsIndex.shared.entry(cliSessionId: cliId)?.effort ?? "",
                          "busy": ChatSender.shared.isBusy(cliId: cliId),
                          "live": ChatSender.shared.liveOnMac(cliId: cliId)])

        case ("GET", _):
            return serveStatic(request)

        default:
            return .text("Not found", status: 404)
        }
    }

    /// I modelli che il telefono puo' scegliere. La lista e' **chiusa**: il
    /// testo arriva da fuori e finisce in un comando, quindi non si passa
    /// niente che non sia in questo elenco.
    static let modelliAmmessi: [(id: String, nome: String)] = [
        ("claude-fable-5",            "Fable 5"),
        ("claude-opus-5",             "Opus 5"),
        ("claude-sonnet-5",           "Sonnet 5"),
        ("claude-opus-4-8",           "Opus 4.8"),
        ("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ]

    private func authorized(_ r: HTTPRequest) -> Bool {
        AuthStore.shared.isValid(token: r.bearerToken)
    }

    private func unauthorized() -> HTTPResponse {
        .json(["ok": false, "code": "unauthorized"], status: 401)
    }

    /// Da che strada e' arrivata una richiesta, per il registro. Dal ponte la
    /// pagina ponte marca ogni richiesta con `X-Riflesso-Via` (e il vicino e'
    /// 127.0.0.1, cioe' la WebView); dietro un inoltro il vicino e' di nuovo
    /// 127.0.0.1, ma chi bussa sta in `X-Forwarded-For`; dalla rete di casa
    /// e' l'indirizzo del telefono.
    private func describeVia(_ request: HTTPRequest, _ client: ClientConnection) -> String {
        if request.header("x-riflesso-via") != nil { return "ponte (canale diretto)" }
        if let f = request.header("x-forwarded-for"), !f.isEmpty { return "inoltro (\(f))" }
        return "rete locale (\(client.remoteDescription))"
    }

    func statusPayload() -> [String: Any] {
        let d: [String: Any] = [
            "ok": true,
            "clients": server.connectedDeviceCount,
            "injection": injector.mode.rawValue,
            "accessibility": injector.accessibilityGranted,
            "devices": AuthStore.shared.pairedCount,
            // Quante cifre ha il codice: la webapp non deve indovinarlo.
            "pinDigits": AuthStore.pinDigits,
            // Senza il CLI l'app puo' leggere le chat ma non rispondere:
            // meglio dirlo subito che scoprirlo al primo invio.
            "cli": ChatSender.claudeBinary() != nil,
            // Col Desktop aperto e' lui a rispondere e tutto resta allineato;
            // senza, si va di ripiego e il telefono deve saperlo.
            "desktop": DesktopBridge.shared.isRunning,
            // Il segreto della stanza sul ponte: un telefono accoppiato in
            // casa deve poterlo avere senza rifare il codice.
            "meet": AuthStore.shared.meetSecret,
            // Com'e' messo il ponte, per la diagnostica sul telefono.
            "remote": RemoteLink.shared.payload,
        ]
        return d
    }

    // MARK: - File statici

    static let webappDirectory: URL = {
        // 1) dentro l'app impacchettata
        if let res = Bundle.main.resourceURL {
            let candidate = res.appendingPathComponent("webapp", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("index.html").path) {
                return candidate
            }
        }
        // 2) percorso esplicito, comodo durante lo sviluppo
        if let env = ProcessInfo.processInfo.environment["RIFLESSO_WEBAPP"] {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        // 3) `swift run` dalla cartella host-mac
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        var dir = exe.deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("webapp", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("index.html").path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("webapp")
    }()

    /// Un file della webapp, **con l'impronta e gia' compresso**.
    ///
    /// Misurato il 04/09/2026: la pagina pesava 208 KB e viaggiava in chiaro,
    /// e alla seconda apertura tornava tutta di nuovo — undici richieste, zero
    /// 304 — perche' `no-cache` senza un `ETag` vuol dire «riscarica sempre».
    /// Adesso: se il browser ha gia' la versione giusta risponde un 304 vuoto;
    /// se no il file parte in gzip (68 KB → 22 KB per `app.js`), compresso una
    /// volta sola e tenuto in memoria finche' su disco non cambia.
    private func serveStatic(_ request: HTTPRequest) -> HTTPResponse {
        let path = request.path
        var rel = path == "/" ? "index.html" : String(path.dropFirst())
        if rel.hasSuffix("/") { rel += "index.html" }
        let root = AppHub.webappDirectory.standardizedFileURL
        let target = root.appendingPathComponent(rel).standardizedFileURL
        // Nessuna uscita dalla cartella della webapp.
        guard target.path.hasPrefix(root.path) else { return .text("Forbidden", status: 403) }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
              (attrs[.type] as? FileAttributeType) != .typeDirectory else {
            return .text("Not found: \(rel)", status: 404)
        }
        let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        let modified = (attrs[.modificationDate] as? Date) ?? .distantPast
        let etag = HTTPResponse.etag(size: size, modified: modified)
        let contentType = MIME.forPath(rel)

        // «Ce l'ho gia'»: si controlla **prima** di leggere il file.
        if request.ifNoneMatch.contains(where: { $0 == etag || $0 == "*" }) {
            return .notModified(etag: etag)
        }

        let asset: StaticAsset? = stateQueue.sync {
            if let a = assets[rel], a.size == size, a.modified == modified { return a }
            guard let data = try? Data(contentsOf: target) else { return nil }
            let gz = HTTPResponse.isCompressible(contentType: contentType) && data.count >= 1024
                ? Gzip.compress(data) : nil
            let a = StaticAsset(size: size, modified: modified, etag: etag, raw: data, gzip: gz)
            assets[rel] = a
            return a
        }
        guard let asset else { return .text("Not found: \(rel)", status: 404) }

        if request.acceptsGzip, let gz = asset.gzip {
            var r = HTTPResponse.file(gz, contentType: contentType, etag: etag)
            r.headers["Content-Encoding"] = "gzip"
            r.headers["Vary"] = "Accept-Encoding"
            return r
        }
        return .file(asset.raw, contentType: contentType, etag: etag)
    }

    // MARK: - WebSocket

    func clientDidOpenWebSocket(_ client: ClientConnection) {
        sendInfo(to: client)
        // Un telefono appena arrivato vuole l'elenco fresco: si ricontrolla
        // subito, senza aspettare il giro dell'orologio.
        ChatList.shared.refresh()
        DispatchQueue.main.async { self.onStateChange?() }
    }

    func clientDidCloseWebSocket(_ client: ClientConnection) {
        Log.info("WebSocket chiuso:", client.label)
        DispatchQueue.main.async { self.onStateChange?() }
    }

    /// **Il Mac non guarda mai lo schermo.** Lo specchio — vedere lo schermo
    /// del Mac dal telefono — e' stato tolto il 30/08/2026: era l'unica
    /// funzione che chiedeva il permesso di Registrazione schermo, e per mesi
    /// non e' nemmeno stata raggiungibile, perche' il tasto per aprirla nasceva
    /// nascosto. Con lei se ne sono andati il motore di cattura, il codificatore
    /// dei fotogrammi e il telecomando (tocchi, trascinamenti, tastiera).
    private func broadcastInfo() {
        for c in server.webSocketClients { sendInfo(to: c) }
    }

    private func sendInfo(to client: ClientConnection) {
        var payload = statusPayload()
        payload["t"] = "info"
        client.sendWSJSON(payload)
    }

    func handleWebSocketText(_ text: String, from client: ClientConnection) {
        guard let data = text.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = msg["t"] as? String else { return }
        guard AuthStore.shared.isValid(token: client.token) else {
            client.close()
            return
        }

        switch type {
        case "ping":
            client.sendWSJSON(["t": "pong", "ts": msg["ts"] ?? 0,
                               "ts2": Date().timeIntervalSince1970])

        case "openChat":
            guard let id = msg["id"] as? String else { return }
            let end = UInt64((msg["end"] as? Double) ?? 0)
            TranscriptWatcher.shared.open(cliId: id, from: end)

        case "closeChat":
            if let id = msg["id"] as? String { TranscriptWatcher.shared.close(cliId: id) }

        case "sendChat":
            guard let id = msg["id"] as? String else { return }
            let text = (msg["text"] as? String) ?? ""
            let fileId = (msg["file"] as? String) ?? ""
            // Un allegato senza didascalia e' una cosa normale: una foto si
            // manda anche da sola. Il vuoto vuoto invece non si manda.
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !fileId.isEmpty else { return }
            guard TranscriptIndex.shared.info(for: id) != nil else {
                client.sendWSJSON(PhoneNotice("transcript_missing").asDict(t: "chatDone", chat: id,
                                                                          extra: ["ok": false]))
                return
            }
            var allegato: Uploads.Pending?
            if !fileId.isEmpty {
                // Il file dev'essere arrivato tutto: un caricamento a meta' non
                // si allega, si dice.
                guard let p = Uploads.shared.file(id: fileId) else {
                    client.sendWSJSON(PhoneNotice("upload_missing").asDict(t: "chatDone", chat: id,
                                                                          extra: ["ok": false]))
                    return
                }
                // Il ripiego col CLI non sa allegare niente: prima di scrivere
                // meta' del messaggio si dice che senza il Desktop non si fa.
                guard DesktopBridge.shared.isRunning,
                      let e = SessionsIndex.shared.entry(cliSessionId: id), !e.title.isEmpty else {
                    client.sendWSJSON(PhoneNotice("attachment_needs_desktop").asDict(t: "chatDone", chat: id,
                                                                                     extra: ["ok": false]))
                    return
                }
                allegato = p
            }
            sendMessage(cliId: id, text: text, attachment: allegato, to: client)

        // Il modello si cambia con il comando `/model`, consegnato dal Desktop
        // come qualunque altro messaggio: cosi' cambia davvero per quella
        // conversazione, e si vede anche sul Mac.
        case "setModel":
            guard let id = msg["id"] as? String, let model = msg["model"] as? String else { return }
            guard AppHub.modelliAmmessi.contains(where: { $0.id == model }) else {
                client.sendWSJSON(PhoneNotice("unknown_model").asDict(t: "chatDone", chat: id,
                                                                     extra: ["ok": false]))
                return
            }
            guard DesktopBridge.shared.isRunning else {
                client.sendWSJSON(PhoneNotice("model_needs_desktop").asDict(t: "chatDone", chat: id,
                                                                           extra: ["ok": false]))
                return
            }
            sendMessage(cliId: id, text: "/model \(model)", to: client)

        // L'impegno non ha un comando: e' un cursore dentro il pannello di
        // Claude. Si muove con la stessa verifica della consegna, perche' vale
        // per la conversazione **aperta**.
        case "setEffort":
            guard let id = msg["id"] as? String, let liv = msg["level"] as? Int else { return }
            guard (0...5).contains(liv) else {
                client.sendWSJSON(PhoneNotice("effort_invalid").asDict(t: "chatDone", chat: id,
                                                                      extra: ["ok": false]))
                return
            }
            guard DesktopBridge.shared.isRunning else {
                client.sendWSJSON(PhoneNotice("effort_needs_desktop").asDict(t: "chatDone", chat: id,
                                                                            extra: ["ok": false]))
                return
            }
            client.sendWSJSON(PhoneNotice("moving_effort").asDict(t: "chatNote", chat: id))
            DesktopBridge.shared.async {
                // Fuori dalla coda del server si può rileggere l'indice: una
                // conversazione appena aperta sul Mac non è ancora nella copia
                // in memoria, e rifiutare sarebbe una bugia.
                guard let entry = SessionsIndex.shared.entryFresh(cliSessionId: id) else {
                    self.broadcastChat(PhoneNotice("unknown_to_desktop").asDict(t: "chatDone", chat: id,
                                                                               extra: ["ok": false]))
                    return
                }
                // Haiku non ha il cursore dell'impegno: si dice, invece di
                // provarci e fallire con un messaggio oscuro.
                guard !entry.model.lowercased().contains("haiku") else {
                    self.broadcastChat(PhoneNotice("effort_unsupported",
                                                   ["model": ChatList.shortModel(entry.model)])
                        .asDict(t: "chatDone", chat: id, extra: ["ok": false]))
                    return
                }
                switch DesktopBridge.shared.setEffort(cliId: id, entry: entry, to: liv) {
                case .delivered:
                    self.broadcastChat(PhoneNotice("effort_changed").asDict(t: "chatDone", chat: id,
                                                                            extra: ["ok": true]))
                case .refused(let why):
                    self.broadcastChat(why.asDict(t: "chatDone", chat: id, extra: ["ok": false]))
                case .notRunning:
                    self.broadcastChat(PhoneNotice("desktop_not_running").asDict(t: "chatDone", chat: id,
                                                                                extra: ["ok": false]))
                }
            }

        case "stopChat":
            guard let id = msg["id"] as? String else { return }
            // Sul percorso del Desktop il tasto ferma fa quel che farebbe
            // chi e' davanti al Mac: preme Esc nella finestra di Claude.
            if DesktopBridge.shared.isBusy(cliId: id) || desktopIsAnswering(cliId: id) {
                DesktopBridge.shared.stop()
            } else {
                ChatSender.shared.stop(cliId: id)
            }

        case "mode":
            if let v = msg["v"] as? String, let m = InjectionMode(rawValue: v) {
                injector.mode = m
                Log.info("modalita' iniezione impostata a", v)
                broadcastInfo()
                DispatchQueue.main.async { self.onStateChange?() }
            }

        default:
            break
        }
    }
}
