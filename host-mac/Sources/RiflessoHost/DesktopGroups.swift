import Foundation

/// I **gruppi** in cui Claude Desktop raccoglie le conversazioni.
///
/// Sul Mac la barra laterale non e' un elenco piatto: le chat stanno dentro
/// gruppi con un nome («LAVORO», «Casa»). Il telefono deve
/// far vedere la stessa divisione, quindi quel dato va letto da dove lo tiene
/// il Desktop:
///
/// ```
/// ~/Library/Application Support/Claude/claude_desktop_config.json
///   → preferences.epitaxyPrefs.dframe-group-scopes
///       → "<account>/<workspace>"
///           → groups:      [{ id: "cg-…", name: "…" }, …]
///           → assignments: { "code:local_<uuid>": "cg-…", … }
/// ```
///
/// Tre cose imparate leggendolo davvero, che spiegano il codice qui sotto:
///
/// 1. **La chiave e' `code:` + `sessionId`, non il `cliSessionId`.** Sono due
///    identificativi diversi e per alcune conversazioni non coincidono
///    (`local_4f2570bd…` ha `cliSessionId` `390722df…`). Il legame si fa con
///    `SessionEntry.sessionId`, altrimenti quelle chat perdono il gruppo.
/// 2. **Meta' delle assegnazioni punta a sessioni che non esistono piu'.** Il
///    Desktop non ripulisce il file quando una conversazione sparisce: 9 su 19,
///    qui. Non e' un errore, e non va segnalato: semplicemente non trovano
///    riscontro.
/// 3. **Il file e' di Claude Desktop.** Si apre in lettura e basta. Se manca, o
///    se ha una forma diversa da questa, non si indovina niente: si torna
///    all'elenco piatto di prima. E' configurazione altrui e puo' cambiare da
///    una versione all'altra — l'app non deve rompersi il giorno che succede.
struct ChatGroup {
    var id: String
    var name: String
    /// Messo in evidenza sul Mac (`starred-session-groups`).
    var starred: Bool = false

    var dict: [String: Any] { ["id": id, "name": name, "star": starred] }
}

final class DesktopGroups {
    static let shared = DesktopGroups()

    static let configURL: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Claude/claude_desktop_config.json")

    private let lock = NSLock()
    private var cachedGroups: [ChatGroup] = []
    /// `sessionId` (quello del Desktop, `local_…`) → identificativo del gruppo.
    private var cachedAssignments: [String: String] = [:]
    /// `sessionId` → posizione fra le fissate, nell'ordine in cui il Desktop
    /// le tiene in `starred-local-code-sessions`.
    private var cachedPinOrder: [String: Int] = [:]
    private var stamp: (size: UInt64, modified: Date)?
    private var everRead = false

    private init() {}

    /// I gruppi nell'ordine in cui li tiene il Desktop. Vuoto = elenco piatto.
    func groups() -> [ChatGroup] {
        reloadIfChanged()
        lock.lock(); defer { lock.unlock() }
        return cachedGroups
    }

    /// Il gruppo di una conversazione, o stringa vuota se non ne ha uno.
    /// **Non** si inventa un gruppo «Altro»: se sul Mac non c'e', non c'e'.
    func groupId(sessionId: String) -> String {
        guard !sessionId.isEmpty else { return "" }
        reloadIfChanged()
        lock.lock(); defer { lock.unlock() }
        return cachedAssignments[sessionId] ?? ""
    }

    /// Dove sta una conversazione fissata nell'elenco del Desktop. `nil` se
    /// non e' fissata. Serve perche' sul Mac le fissate stanno **tutte in una
    /// sezione loro, in cima**, e non dentro i gruppi: senza quest'ordine
    /// finirebbero mischiate.
    func pinRank(sessionId: String) -> Int? {
        guard !sessionId.isEmpty else { return nil }
        reloadIfChanged()
        lock.lock(); defer { lock.unlock() }
        return cachedPinOrder[sessionId]
    }

    /// Rilegge solo se il file e' cambiato davvero: sono 10 KB, ma questa
    /// funzione viene chiamata una volta per riga dell'elenco.
    private func reloadIfChanged() {
        let url = DesktopGroups.configURL
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? NSNumber)?.uint64Value ?? 0
        let modified = (attrs?[.modificationDate] as? Date) ?? .distantPast

        lock.lock()
        let same = stamp.map { $0.size == size && $0.modified == modified } ?? false
        let already = everRead
        lock.unlock()
        if same && already { return }

        let (groups, assignments, pinOrder) = DesktopGroups.parse(url: url)
        lock.lock()
        cachedGroups = groups
        cachedAssignments = assignments
        cachedPinOrder = pinOrder
        stamp = (size, modified)
        everRead = true
        lock.unlock()
    }

    /// Separata dalla lettura per poterla provare su un file finto.
    /// Ogni passaggio e' un `as?`: la forma sbagliata non lancia, torna vuoto.
    static func parse(url: URL) -> (groups: [ChatGroup], assignments: [String: String], pinOrder: [String: Int]) {
        guard let data = try? Data(contentsOf: url),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let prefs = root["preferences"] as? [String: Any],
              let epitaxy = prefs["epitaxyPrefs"] as? [String: Any],
              let scopes = epitaxy["dframe-group-scopes"] as? [String: Any]
        else { return ([], [:], [:]) }

        // I gruppi in evidenza: oggi e' un elenco di identificativi, ma vale la
        // pena reggere anche la forma a oggetti — costa due righe.
        var starred = Set<String>()
        for item in (epitaxy["starred-session-groups"] as? [Any]) ?? [] {
            if let s = item as? String { starred.insert(s) }
            else if let d = item as? [String: Any], let s = d["id"] as? String { starred.insert(s) }
        }

        // Le fissate: un elenco **ordinato** di sessionId. E' l'unico posto in
        // cui il Desktop dice in che ordine vanno, e vale per tutti gli spazi
        // insieme — il filtro a quelle che esistono davvero lo fa chi legge.
        var pinOrder: [String: Int] = [:]
        for (i, raw) in ((epitaxy["starred-local-code-sessions"] as? [Any]) ?? []).enumerated() {
            if let s = raw as? String, pinOrder[s] == nil { pinOrder[s] = i }
        }

        var groups: [ChatGroup] = []
        var seen = Set<String>()
        var assignments: [String: String] = [:]

        // Di norma c'e' una sola coppia account/spazio. Se ce ne fossero due,
        // si prendono tutte in ordine invece di indovinare quale sia «quella
        // giusta»: due gruppi con lo stesso nome sono meno peggio di una
        // divisione che sparisce.
        for key in scopes.keys.sorted() {
            guard let scope = scopes[key] as? [String: Any] else { continue }
            for raw in (scope["groups"] as? [Any]) ?? [] {
                guard let g = raw as? [String: Any],
                      let id = g["id"] as? String, !id.isEmpty,
                      let name = g["name"] as? String, !name.isEmpty,
                      !seen.contains(id) else { continue }
                seen.insert(id)
                groups.append(ChatGroup(id: id, name: name, starred: starred.contains(id)))
            }
            for (rawKey, rawValue) in (scope["assignments"] as? [String: Any]) ?? [:] {
                guard let gid = rawValue as? String, !gid.isEmpty else { continue }
                // `code:local_<uuid>` → `local_<uuid>`. Altri prefissi (se un
                // domani ne comparissero) non ci riguardano.
                guard rawKey.hasPrefix("code:") else { continue }
                let sid = String(rawKey.dropFirst("code:".count))
                guard !sid.isEmpty, assignments[sid] == nil else { continue }
                assignments[sid] = gid
            }
        }

        // Un'assegnazione a un gruppo che non esiste piu' e' come non averla.
        assignments = assignments.filter { seen.contains($0.value) }
        // In evidenza prima, poi l'ordine del Desktop. `sorted(by:)` non e'
        // stabile in Swift, quindi l'ordine di partenza si porta a mano.
        let order = Dictionary(uniqueKeysWithValues: groups.enumerated().map { ($1.id, $0) })
        groups.sort {
            $0.starred == $1.starred ? order[$0.id]! < order[$1.id]! : $0.starred && !$1.starred
        }
        return (groups, assignments, pinOrder)
    }
}
