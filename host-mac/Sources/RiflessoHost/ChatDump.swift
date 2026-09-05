import Foundation

/// Prova su strada del lettore, senza interfaccia e senza rete.
/// `Riflesso --chatdump` risponde alle domande che contano: l'elenco si apre
/// in meno di un secondo? un transcript da 1 GB si apre senza soffocare?
/// le anteprime sono testo leggibile o JSON?
enum ChatDump {

    static func run() {
        let t0 = Date()
        SessionsIndex.shared.prime()
        TranscriptIndex.shared.prime()
        ChatList.shared.prime()
        while ChatList.shared.isCold && Date().timeIntervalSince(t0) < 60 {
            Thread.sleep(forTimeInterval: 0.05)
        }
        let cold = Date().timeIntervalSince(t0)

        let t1 = Date()
        let rows = ChatList.shared.items()
        let warm = Date().timeIntervalSince(t1)
        let counts = ChatList.shared.counts()

        print(String(format: "elenco chat: %d voci · prima costruzione %.2fs · da fermo %.4fs",
                     rows.count, cold, warm))
        print(String(format: "  %@", warm < 1.0 ? "[OK] si apre in meno di un secondo"
                                                : "[ATTENZIONE] troppo lento"))

        // F3 — nell'elenco solo le chat. Le routine sono le sessioni aperte da
        // un'attività programmata: qui erano 293 su 305, e coprivano tutto.
        print("\n--- F3 · chat contro routine ---")
        print("elenco principale: \(counts.chats) chat · fuori: \(counts.routines) routine")
        let intrusi = rows.filter { $0.routine }
        print(intrusi.isEmpty
              ? "[OK] nessuna routine nell'elenco delle conversazioni"
              : "[ATTENZIONE] \(intrusi.count) routine sono finite fra le chat")

        print("\n--- le chat, come le vede il telefono ---")
        for r in rows.prefix(14) {
            let when = relative(r.lastActivity)
            let flag = r.openable ? (r.active ? "●" : " ") : "×"
            print(String(format: "%@ %-26@ %-9@ %-7@ t=%-4d %@",
                         flag, String(r.title.prefix(26)), when, r.model, r.turns,
                         String(r.preview.prefix(60))))
        }

        let openable = rows.filter { $0.openable }
        print("\napribili: \(openable.count) su \(rows.count) "
              + "(le altre non hanno più il testo su disco)")

        // F4 — le anteprime devono essere l'ultimo messaggio vero.
        print("\n--- F4 · anteprime pulite ---")
        let sporche = openable.filter { r in
            let p = r.preview
            return p.hasPrefix("{") || p.hasPrefix("[{") || p.hasPrefix("<")
                || p.contains("task-notification") || p.contains("system-reminder")
                || p.contains("toolu_") || p.contains("</")
        }
        if sporche.isEmpty {
            print("[OK] nessuna anteprima mostra roba interna")
        } else {
            print("[ATTENZIONE] \(sporche.count) anteprime sporche:")
            for r in sporche.prefix(5) { print("    \(r.title): \(r.preview.prefix(70))") }
        }

        // F1 — la cartella da cui riprendere. È la cartella-progetto in cui il
        // CLI tiene il transcript, non la `cwd` sbirciata in fondo al file.
        print("\n--- F1 · cartella con cui riprendere (sola lettura) ---")
        var storte = 0
        for r in openable.prefix(14) {
            guard let info = TranscriptIndex.shared.cachedInfo(for: r.cliId) else { continue }
            let slugVero = info.url.deletingLastPathComponent().lastPathComponent
            let scelta = ProjectFolder.folder(cliId: r.cliId)
            let peek = TranscriptReader.window(url: info.url, wantItems: 1, maxScan: 256 * 1024).cwd ?? "—"
            let ok = scelta.map { ProjectFolder.slug(for: $0.path) == slugVero } ?? false
            if !ok { storte += 1 }
            let nota = peek != scelta?.path ? "  (nel transcript c'era: \(peek))" : ""
            print("\(ok ? "[OK]" : "[NO]") \(String(r.title.prefix(24)))"
                  + " → \(scelta?.path ?? "nessuna")\(nota)")
        }
        print(storte == 0
              ? "[OK] tutte combaciano con la cartella-progetto del transcript"
              : "[ATTENZIONE] \(storte) non combaciano")

        // Il caso peggiore: il file più grosso che c'è.
        guard let biggest = openable
            .compactMap({ r -> (ChatRow, TranscriptIndex.Info)? in
                guard let i = TranscriptIndex.shared.cachedInfo(for: r.cliId) else { return nil }
                return (r, i)
            })
            .max(by: { $0.1.size < $1.1.size }) else {
            print("nessun transcript da provare")
            return
        }

        let (row, info) = biggest
        print(String(format: "\n--- caso peggiore: «%@» · %.1f MB ---",
                     row.title, Double(info.size) / 1e6))

        let t2 = Date()
        let w = TranscriptReader.window(url: info.url, wantItems: 40)
        let dt = Date().timeIntervalSince(t2)
        print(String(format: "apertura: %.3fs · %d blocchi · altri indietro: %@",
                     dt, w.items.count, w.hasMore ? "sì" : "no"))
        print(dt < 2.0 ? "[OK] si apre in fretta" : "[ATTENZIONE] apertura lenta")

        var byKind: [String: Int] = [:]
        for i in w.items { byKind[(i["k"] as? String) ?? "?", default: 0] += 1 }
        print("blocchi per tipo: " + byKind.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: " "))
        // F5 — quante righe si scorrono davvero. In una schermata vera
        // erano 12 su 16 di lavoro: strumenti e ragionamenti consecutivi ora
        // fanno una riga sola.
        let work: Set<String> = ["tool", "think"]
        let kinds = w.items.map { ($0["k"] as? String) ?? "?" }
        var righe = 0, i = 0
        while i < kinds.count {
            if work.contains(kinds[i]) { while i < kinds.count && work.contains(kinds[i]) { i += 1 } }
            else { i += 1 }
            righe += 1
        }
        let lavoro = kinds.filter { work.contains($0) }.count
        print("F5 · \(kinds.count) blocchi, di cui \(lavoro) di lavoro → \(righe) righe da scorrere")
        print(righe <= kinds.count - lavoro + (kinds.count / 4)
              ? "[OK] a schermo restano soprattutto domande e risposte"
              : "[ATTENZIONE] il lavoro domina ancora la lettura")

        let payload = (try? JSONSerialization.data(withJSONObject: w.items)) ?? Data()
        print(String(format: "peso mandato al telefono: %.0f KB (il file è %.0f MB)",
                     Double(payload.count) / 1024, Double(info.size) / 1e6))
        print(payload.count < 800_000 ? "[OK] carico leggero" : "[ATTENZIONE] troppo pesante")

        print("\n--- gli ultimi 6 blocchi, come si leggono ---")
        for i in w.items.suffix(6) {
            let k = (i["k"] as? String) ?? "?"
            var line = ""
            switch k {
            case "tool":
                line = "⚙ \((i["name"] as? String) ?? "") · \((i["brief"] as? String) ?? "")"
            case "think":
                line = "💭 \(String(((i["text"] as? String) ?? "").prefix(60)))"
            default:
                line = String(ChatList.oneLine((i["text"] as? String) ?? "").prefix(90))
            }
            print(String(format: "  %-7@ %@", k, line))
        }

        // Pagina all'indietro: «carica altri» deve dare blocchi diversi.
        let older = TranscriptReader.window(url: info.url, before: w.firstOffset, wantItems: 20)
        print(String(format: "\ncarica altri: %d blocchi più vecchi · offset %llu → %llu",
                     older.items.count, w.firstOffset, older.firstOffset))
        print(older.firstOffset < w.firstOffset && !older.items.isEmpty
              ? "[OK] si risale indietro davvero" : "[ATTENZIONE] la paginazione non risale")

        // Le novità dopo un punto: è ciò che usa la diretta.
        let (afterItems, _, _) = TranscriptReader.itemsAfter(url: info.url, offset: w.firstOffset)
        print("novità dopo l'offset di partenza: \(afterItems.count) blocchi")

        print("\n--- il comando claude ---")
        if let bin = ChatSender.claudeBinary() {
            print("[OK] trovato: \(bin)")
        } else {
            print("[ATTENZIONE] non trovato: senza CLI non si può rispondere")
        }
    }

    private static func relative(_ d: Date) -> String {
        let s = Date().timeIntervalSince(d)
        if s < 3600 { return "ora" }
        if s < 86_400 { return "oggi" }
        if s < 172_800 { return "ieri" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "it_IT")
        f.dateFormat = s < 7 * 86_400 ? "EEE" : "d MMM"
        return f.string(from: d)
    }
}
