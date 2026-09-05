import Foundation
import AppKit
import ApplicationServices

/// Il telefono e' una finestra sul Mac: chi lavora e' **Claude Desktop**.
///
/// Il messaggio che arriva dal telefono non viene eseguito da un secondo
/// processo `claude`: viene consegnato **dentro il compositore del Desktop** e
/// mandato da li', come se l'avesse digitato chi sta al Mac. Da quel momento
/// disegna il Desktop, aggiorna il suo indice e scrive il transcript: la
/// sincronizzazione non e' una funzione in piu', e' una conseguenza.
///
/// Quello che sta scritto qui sotto e' tutto misurato su Claude Desktop
/// 1.32885.1, e quasi tutto e' costato un errore.
///
/// 1. **Il deep link `claude://resume?session=<cliId>` importa, non naviga.**
///    Chiama `importCliSession`. Se il Desktop conosce gia' quella sessione
///    come `local_<cliId>` esce subito e porta solo la finestra li' (provato:
///    transcript intatto, stesso byte, stesso minuto). Se **non** la conosce,
///    la importa davvero: nasce una riga nuova nella barra laterale **e il
///    `.jsonl` viene riscritto** — nella prova il file di collaudo e' passato
///    da 125.580 a 86.197 byte, coi blocchi di ragionamento tolti. Quindi il
///    link si accende **solo** se `sessionId == "local_" + cliId`; per le altre
///    si tocca la riga nella barra laterale, che non scrive niente.
///
/// 2. **Il Desktop dichiara da solo quale chat ha davanti**, scrivendo nel suo
///    log `setFocusedSession: sessionId=…` a ogni cambio, anche quando a
///    cambiarla e' un clic di chi sta al Mac. E' la fonte piu' onesta che abbiamo.
///
/// 3. **Il suggerimento in grigio sembra testo.** Un compositore vuoto legge
///    «Digita / per i comandi». Il vuoto vero si riconosce dalla classe
///    `is-editor-empty` dell'editor (tiptap/ProseMirror), che non e' tradotta.
///
/// 4. **Scrivere il testo con l'accessibilita' non funziona, e mente.**
///    `AXValue` e `AXSelectedText` tornano «riuscito» e il riquadro *sembra*
///    pieno, ma ProseMirror non se n'e' accorto: il pulsante «Invia» resta
///    spento e si manderebbe il vuoto. Il testo va consegnato coi tasti veri.
///
/// 5. **I tasti arrivano solo alla finestra attiva.** Chromium butta via
///    l'incolla mandato a una finestra che non ha il fuoco del sistema. Quindi
///    per consegnare bisogna portare Claude davanti — e alla fine rimetterlo
///    com'era.
///
/// 6. **Attivare Claude puo' cambiargli la conversazione sotto le mani.**
///    Questo e' costato caro: la prima consegna riuscita e' finita in una chat
///    vera di chi usa il Mac. Verificato prima, attivato dopo, e nel frattempo il
///    Desktop e' saltato da solo su un'altra sessione (nel log: `handoff:
///    publishing session_…`). Da qui l'ordine di adesso — **prima si attiva,
///    poi si apre la conversazione, poi si verifica, e si ricontrolla ancora
///    subito prima di premere invio**: se qualcosa e' cambiato nel frattempo,
///    si pulisce e non si manda niente.
final class DesktopBridge {
    static let shared = DesktopBridge()

    /// Esito di una consegna. Il rifiuto e' un **codice** per il telefono,
    /// non una frase: la webapp la compone nella lingua scelta.
    enum Outcome {
        /// Consegnato e inviato dal Desktop: da qui in poi lavora lui.
        case delivered
        /// Non si e' scritto niente, e questo e' il motivo.
        case refused(PhoneNotice)
        /// Claude Desktop non e' in esecuzione: tocca al ripiego.
        case notRunning
    }

    private let work = DispatchQueue(label: "riflesso.desktop", qos: .userInitiated)
    private let lock = NSLock()
    private var axAsked = false
    /// Il suggerimento in grigio del compositore, imparato guardandolo vuoto.
    private var placeholder = ""
    /// Consegne in corso, per chat.
    private var inFlight: Set<String> = []
    /// Gli elementi trovati l'ultima volta: ritrovarli ogni volta con una
    /// passata dell'albero costa quasi un secondo, e qui si guarda spesso.
    private var cachedComposer: AXUIElement?

    /// Impostato da AppHub: manda un evento a tutti i telefoni collegati.
    var emit: (([String: Any]) -> Void)?

    private init() {}

    // MARK: - C'e' il Desktop?

    static let bundleID = "com.anthropic.claudefordesktop"

    static var app: NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleID }
    }

    var isRunning: Bool { DesktopBridge.app != nil }

    func isBusy(cliId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return inFlight.contains(cliId)
    }

    // MARK: - Accessibilita'

    /// Electron costruisce l'albero solo se qualcuno lo chiede. Si domanda una
    /// volta sola: da quel momento la finestra resta leggibile.
    func enableAXPublic(pid: pid_t) { enableAX(pid: pid) }
    private func enableAX(pid: pid_t) {
        lock.lock()
        let already = axAsked
        axAsked = true
        lock.unlock()
        guard !already else { return }
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 1.2)   // il primo albero non e' pronto sul colpo
    }

    private func value(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &v) == .success else { return nil }
        return v
    }

    private func text(_ e: AXUIElement, _ key: String) -> String {
        value(e, key) as? String ?? ""
    }

    private func children(_ e: AXUIElement) -> [AXUIElement] {
        value(e, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
    }

    private func role(_ e: AXUIElement) -> String { text(e, kAXRoleAttribute as String) }

    /// Le finestre vere di Claude. Ce n'e' una sola in uso, ma l'app ne espone
    /// anche una minuscola di servizio.
    private func windows(_ pid: pid_t) -> [AXUIElement] {
        let ax = AXUIElementCreateApplication(pid)
        let all = value(ax, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
        return all.filter { text($0, kAXTitleAttribute as String) == "Claude" }
    }

    // MARK: - Il compositore

    /// Com'e' messo il riquadro di scrittura, adesso.
    struct Composer {
        var element: AXUIElement
        /// Il testo **vero**: vuoto quando il riquadro e' vuoto, anche se
        /// l'accessibilita' ci legge dentro il suggerimento in grigio.
        var text: String
        var isEmpty: Bool
        var isFocused: Bool
        /// Il pulsante «Invia»: compare solo quando c'e' del contenuto.
        var sendButton: AXUIElement?
        /// **Il testimone che conta**: acceso solo quando l'editor ha davvero
        /// preso il testo. Vedi la nota 4 in cima.
        var canSend: Bool
        /// Gli allegati appesi al riquadro adesso: nome e pulsante «Rimuovi».
        /// Sono pastiglie a parte, non testo — svuotare il riquadro non le
        /// tocca, e vanno tolte una per una.
        var pills: [Pill] = []
    }

    /// Una pastiglia di allegato nel compositore.
    struct Pill {
        var name: String
        var remove: AXUIElement?
    }

    /// Solo per il registro: cosa sta mostrando Claude quando qualcosa non torna.
    func finestreDescritte(pid: pid_t) -> String {
        let app = AXUIElementCreateApplication(pid)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
              let finestre = raw as? [AXUIElement], !finestre.isEmpty else { return "nessuna finestra" }
        return finestre.prefix(3).map { w in
            let t = text(w, kAXTitleAttribute as String)
            return t.isEmpty ? "(senza titolo)" : "«\(t)»"
        }.joined(separator: ", ")
    }

    func composer() -> Composer? {
        guard let app = DesktopBridge.app else { return nil }
        enableAX(pid: app.processIdentifier)

        lock.lock(); let cached = cachedComposer; lock.unlock()
        var element = cached
        if element == nil || role(element!) != "AXTextArea" {
            element = findComposer(pid: app.processIdentifier)
            lock.lock(); cachedComposer = element; lock.unlock()
        }
        guard let element else { return nil }

        let raw = text(element, kAXValueAttribute as String)
        let empty = editorIsEmpty(element)
        let button = findSendButton(near: element)
        return Composer(element: element,
                        text: empty ? "" : raw,
                        isEmpty: empty,
                        isFocused: (value(element, kAXFocusedAttribute as String) as? Bool) ?? false,
                        sendButton: button,
                        canSend: button.map { (value($0, kAXEnabledAttribute as String) as? Bool) ?? false } ?? false,
                        pills: findPills(near: element))
    }

    /// Gli allegati appesi al compositore.
    ///
    /// Come sono fatti l'ho guardato invece di immaginarlo (`--attachprobe`):
    /// ogni allegato e' un `epitaxy-attachment-pill` con dentro una casella che
    /// porta il **nome del file** e un pulsante `epitaxy-pill-remove` la cui
    /// descrizione e' «Rimuovi <nome>». Il nome si legge dalla casella, non dal
    /// pulsante, cosi' non dipende dalla lingua del Desktop.
    private func findPills(near composer: AXUIElement) -> [Pill] {
        var top = composer
        for _ in 0..<3 {
            guard let parent = value(top, kAXParentAttribute as String) else { break }
            top = parent as! AXUIElement
        }
        var out: [Pill] = []
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard depth < 8, out.count < 20 else { return }
            if let classes = value(e, "AXDOMClassList") as? [String],
               classes.contains("epitaxy-attachment-pill") {
                var name = ""
                var remove: AXUIElement?
                func inside(_ x: AXUIElement, _ d: Int) {
                    guard d < 5 else { return }
                    let classes = (value(x, "AXDOMClassList") as? [String]) ?? []
                    if classes.contains("epitaxy-pill-remove") { remove = x }
                    else if classes.contains("epitaxy-pill-body"), name.isEmpty {
                        name = text(x, kAXDescriptionAttribute as String)
                    }
                    for c in children(x) { inside(c, d + 1) }
                }
                inside(e, 0)
                out.append(Pill(name: name, remove: remove))
                return
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        walk(top, 0)
        return out
    }

    private func findComposer(pid: pid_t) -> AXUIElement? {
        var found: AXUIElement?
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard found == nil, depth < 40, seen < 8000 else { return }
            seen += 1
            if role(e) == "AXTextArea",
               text(e, kAXDescriptionAttribute as String).lowercased().contains("prompt") {
                found = e
                return
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(pid) { walk(w, 0) }
        return found
    }

    /// Il pulsante sta accanto al riquadro, non dentro: si sale di qualche
    /// livello e si guarda li' intorno. Cosi' non serve ripercorrere l'albero
    /// intero ogni volta che si controlla.
    private func findSendButton(near composer: AXUIElement) -> AXUIElement? {
        var top = composer
        for _ in 0..<3 {
            guard let parent = value(top, kAXParentAttribute as String) else { break }
            top = parent as! AXUIElement
        }
        var found: AXUIElement?
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard found == nil, depth < 6 else { return }
            if role(e) == "AXButton" {
                let d = text(e, kAXDescriptionAttribute as String)
                if d == "Invia" || d == "Send" { found = e; return }
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        walk(top, 0)
        return found
    }

    /// Il riquadro e' vuoto?
    ///
    /// Non basta guardare il testo: quando il compositore e' vuoto
    /// l'accessibilita' ci legge dentro il **suggerimento in grigio**
    /// («Digita / per i comandi»), che sembra a tutti gli effetti roba scritta
    /// da qualcuno. Ci siamo cascati alla prima prova, e per fortuna la
    /// verifica ha rifiutato di scrivere invece di tirare a indovinare.
    private func editorIsEmpty(_ e: AXUIElement, depth: Int = 0) -> Bool {
        if depth == 0, text(e, kAXValueAttribute as String)
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if let classes = value(e, "AXDOMClassList") as? [String],
           classes.contains("is-editor-empty") || classes.contains("is-empty") {
            // Gia' che ci siamo impariamo com'e' scritto il suggerimento: se un
            // domani sparissero le classi, resta un modo di riconoscerlo.
            let hint = text(e, kAXValueAttribute as String)
            if !hint.isEmpty { lock.lock(); placeholder = hint; lock.unlock() }
            return true
        }
        if depth < 3 {
            for c in children(e) where editorIsEmpty(c, depth: depth + 1) { return true }
        }
        if depth == 0 {
            lock.lock(); let known = placeholder; lock.unlock()
            let v = text(e, kAXValueAttribute as String).trimmingCharacters(in: .whitespacesAndNewlines)
            if !known.isEmpty, v == known.trimmingCharacters(in: .whitespacesAndNewlines) { return true }
        }
        return false
    }

    // MARK: - Le righe della barra laterale

    struct Row {
        var title: String
        /// `nil` quando lo stato non si riconosce: non lo si inventa.
        var running: Bool?
        var element: AXUIElement
    }

    /// Costa una passata dell'albero intero: si chiama solo quando serve
    /// davvero (aprire una chat non raggiungibile col link, o sapere se il
    /// Desktop sta ancora rispondendo).
    func rows() -> [Row] {
        guard let app = DesktopBridge.app else { return [] }
        enableAX(pid: app.processIdentifier)
        var out: [Row] = []
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard depth < 40, seen < 8000 else { return }
            seen += 1
            if role(e) == "AXButton" {
                let label = text(e, kAXTitleAttribute as String)
                if !label.isEmpty, let plain = plainTitle(inside: e), label.hasSuffix(plain) {
                    let prefix = String(label.dropLast(plain.count))
                        .trimmingCharacters(in: .whitespaces)
                    out.append(Row(title: plain, running: runningState(prefix), element: e))
                }
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(app.processIdentifier) { walk(w, 0) }
        return out
    }

    /// Il selettore dell'effort («Impegno» nella lingua italiana, «Effort» in
    /// inglese). Sta in fondo alla finestra, accanto al modello, ed e' un
    /// AXPopUpButton annidato in profondita': si trova solo camminando l'albero.
    /// Solo per la sonda: le etichette dei pop-up viste nell'ultimo giro.
    static var ultimeEtichette: [String] = []
    /// Solo per la sonda: i comandi visibili subito dopo aver premuto.
    static var dopoLaPressione: [String] = []
    static var primaDellaPressione: [String] = []

    func effortPicker() -> AXUIElement? {
        DesktopBridge.ultimeEtichette = []
        guard let app = DesktopBridge.app else { return nil }
        enableAX(pid: app.processIdentifier)
        var found: AXUIElement?
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard found == nil, depth < 40, seen < 12000 else { return }
            seen += 1
            if role(e) == "AXPopUpButton" {
                // In Electron il titolo e' spesso vuoto e il testo vive nel
                // valore o in uno static text figlio: si guardano tutti e
                // quattro, altrimenti il selettore «c'e' ma non si trova».
                let label = [text(e, kAXTitleAttribute as String),
                             text(e, kAXDescriptionAttribute as String),
                             text(e, kAXValueAttribute as String),
                             plainTitle(inside: e) ?? ""].joined(separator: " ").lowercased()
                DesktopBridge.ultimeEtichette.append(label)
                if label.contains("impegno") || label.contains("effort") { found = e; return }
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(app.processIdentifier) { walk(w, 0) }
        return found
    }

    /// Il selettore, aspettandolo: dopo che Claude viene portata davanti la
    /// barra in fondo impiega un attimo a esistere, e cercarla subito significa
    /// non trovarla.
    func waitForEffortPicker(seconds: TimeInterval = 6) -> AXUIElement? {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if let p = effortPicker() { return p }
            Thread.sleep(forTimeInterval: 0.4)
        } while Date() < deadline
        return nil
    }

    /// Il rettangolo di un elemento sullo schermo, in coordinate globali.
    func frame(of e: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?, siz: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &siz) == .success
        else { return nil }
        var p = CGPoint.zero, z = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &p),
              AXValueGetValue(siz as! AXValue, .cgSize, &z) else { return nil }
        return CGRect(origin: p, size: z)
    }

    /// Un clic vero nel centro di un elemento. I componenti web di Electron non
    /// rispondono ad `AXPress`: aspettano il mouse, e il mouse deve **essere**
    /// li' (`.cghidEventTap` consegna alla finestra sotto al cursore vero).
    @discardableResult
    func clickCenter(of e: AXUIElement) -> Bool {
        guard let r = frame(of: e) else { return false }
        let c = CGPoint(x: r.midX, y: r.midY)
        CGWarpMouseCursorPosition(c)
        Thread.sleep(forTimeInterval: 0.06)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: c, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: c, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.5)
        return true
    }

    /// Le voci del menu dell'effort, aperte e richiuse: serve a sapere come si
    /// chiamano davvero prima di poterne premere una.
    func effortOptions() -> [String] {
        guard let picker = waitForEffortPicker() else { return [] }
        DesktopBridge.primaDellaPressione = dumpEverything()
        DesktopBridge.app?.activate()
        Thread.sleep(forTimeInterval: 0.4)
        clickCenter(of: picker)
        Thread.sleep(forTimeInterval: 0.3)
        // Il menu aperto puo' non essere figlio del pulsante: si ricerca in
        // tutta la finestra, e si richiude comunque.
        var out: [String] = []
        // Electron non apre un menu di sistema: le voci sono elementi web. Si
        // guarda cosa e' comparso confrontando i comandi prima e dopo.
        DesktopBridge.dopoLaPressione = dumpEverything()
        for e in menuItems() {
            let t = text(e, kAXTitleAttribute as String)
            let v = plainTitle(inside: e) ?? ""
            let label = t.isEmpty ? v : t
            if !label.isEmpty { out.append(label) }
        }
        closeMenu(picker)
        return out
    }

    /// Tutte le voci di menu visibili adesso, ovunque siano nell'albero.
    private func menuItems() -> [AXUIElement] {
        guard let app = DesktopBridge.app else { return [] }
        var out: [AXUIElement] = []
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard depth < 40, seen < 12000 else { return }
            seen += 1
            if role(e) == "AXMenuItem" { out.append(e) }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(app.processIdentifier) { walk(w, 0) }
        return out
    }

    private func closeMenu(_ picker: AXUIElement) {
        AXUIElementPerformAction(picker, kAXCancelAction as CFString)
        Thread.sleep(forTimeInterval: 0.2)
        if !menuItems().isEmpty {
            // Se il menu e' rimasto aperto, si chiude come farebbe una persona.
            let esc = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)
            esc?.post(tap: .cghidEventTap)
            CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
        }
    }

    /// Il cursore, aspettandolo: il pannello e' una finestrella web e ci mette
    /// un attimo a comparire. Se al primo colpo non c'e', si riprova a premere
    /// una volta sola — non si martella l'interfaccia.
    func waitForSlider(picker: AXUIElement, seconds: TimeInterval = 3) -> AXUIElement? {
        func cerca() -> AXUIElement? {
            let deadline = Date().addingTimeInterval(seconds)
            repeat {
                if let s = effortSlider() { return s }
                Thread.sleep(forTimeInterval: 0.25)
            } while Date() < deadline
            return nil
        }
        if let s = cerca() { return s }
        clickCenter(of: picker)
        return cerca()
    }

    /// Sposta il cursore su un valore. Prima si prova a scriverlo; se il
    /// componente non lo accetta si usano le frecce, che e' quello che farebbe
    /// una persona con la tastiera.
    @discardableResult
    func setSlider(_ e: AXUIElement, to target: Double) -> Bool {
        let n = NSNumber(value: target)
        if AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, n) == .success {
            Thread.sleep(forTimeInterval: 0.35)
            if let now = sliderNumbers(e), abs(now.val - target) < 0.01 { return true }
        }
        guard let now = sliderNumbers(e) else { return false }
        AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let steps = Int((target - now.val).rounded())
        let key: CGKeyCode = steps > 0 ? 124 : 123   // freccia destra / sinistra
        for _ in 0..<abs(steps) {
            CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)?.post(tap: .cghidEventTap)
            CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.12)
        }
        Thread.sleep(forTimeInterval: 0.25)
        return sliderNumbers(e).map { abs($0.val - target) < 0.01 } ?? false
    }

    /// L'etichetta attuale del selettore, per verificare che il cambio abbia
    /// davvero fatto effetto: «Impegno: Max».
    func effortLabel() -> String? {
        guard let p = effortPicker() else { return nil }
        let t = text(p, kAXTitleAttribute as String)
        return t.isEmpty ? (plainTitle(inside: p) ?? nil) : t
    }

    /// Il cursore dell'effort dentro il pannello aperto dal selettore.
    /// **Non e' un menu**: e' un `AXSlider` che va da «Piu' veloce» a
    /// «Piu' intelligente».
    func effortSlider() -> AXUIElement? {
        guard let app = DesktopBridge.app else { return nil }
        var found: AXUIElement?
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard found == nil, depth < 40, seen < 20000 else { return }
            seen += 1
            if role(e) == "AXSlider" {
                let label = [text(e, kAXTitleAttribute as String),
                             text(e, kAXDescriptionAttribute as String)].joined(separator: " ").lowercased()
                if label.contains("impegno") || label.contains("effort") { found = e; return }
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(app.processIdentifier) { walk(w, 0) }
        return found
    }

    /// Valore, minimo e massimo del cursore, come numeri.
    func sliderNumbers(_ e: AXUIElement) -> (val: Double, min: Double, max: Double)? {
        func num(_ key: String) -> Double? {
            var v: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, key as CFString, &v) == .success else { return nil }
            if let n = v as? NSNumber { return n.doubleValue }
            return nil
        }
        guard let v = num(kAXValueAttribute as String) else { return nil }
        return (v, num(kAXMinValueAttribute as String) ?? 0, num(kAXMaxValueAttribute as String) ?? 0)
    }

    /// Tutto quello che ha del testo, qualunque sia il ruolo: serve quando il
    /// menu non e' un menu ma un pezzo di pagina web.
    func dumpEverything() -> [String] {
        guard let app = DesktopBridge.app else { return [] }
        enableAX(pid: app.processIdentifier)
        var out: [String] = []
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard depth < 40, seen < 20000 else { return }
            seen += 1
            let bits = [text(e, kAXTitleAttribute as String),
                        text(e, kAXDescriptionAttribute as String),
                        text(e, kAXValueAttribute as String)].filter { !$0.isEmpty }
            if !bits.isEmpty { out.append("\(role(e)) · \(bits.joined(separator: " | "))") }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(app.processIdentifier) { walk(w, 0) }
        return out
    }

    /// Elenco grezzo dei comandi della finestra: serve a **trovare** un
    /// controllo prima di poterlo premere (per esempio il selettore
    /// dell'effort). Sola lettura, usato solo dal collaudo.
    func dumpControls() -> [String] {
        guard let app = DesktopBridge.app else { return ["Claude Desktop non è in esecuzione"] }
        enableAX(pid: app.processIdentifier)
        var out: [String] = []
        var seen = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            guard depth < 40, seen < 12000 else { return }
            seen += 1
            let r = role(e)
            if ["AXButton", "AXPopUpButton", "AXMenuButton", "AXRadioButton",
                "AXCheckBox", "AXMenuItem"].contains(r) {
                let title = text(e, kAXTitleAttribute as String)
                let desc  = text(e, kAXDescriptionAttribute as String)
                let val   = text(e, kAXValueAttribute as String)
                let inner = plainTitle(inside: e) ?? ""
                let bits = [title, desc, val, inner].filter { !$0.isEmpty }
                if !bits.isEmpty {
                    out.append("\(String(repeating: " ", count: min(depth, 12)))\(r) · \(bits.joined(separator: " | "))")
                }
            }
            for c in children(e) { walk(c, depth + 1) }
        }
        for w in windows(app.processIdentifier) { walk(w, 0) }
        return out
    }

    /// Il titolo «pulito» di una riga: il primo AXStaticText subito sotto.
    private func plainTitle(inside e: AXUIElement, depth: Int = 0) -> String? {
        guard depth < 3 else { return nil }
        for c in children(e) {
            if role(c) == "AXStaticText" {
                let v = text(c, kAXValueAttribute as String)
                if !v.isEmpty { return v }
            }
            if let deeper = plainTitle(inside: c, depth: depth + 1) { return deeper }
        }
        return nil
    }

    /// «Inattivo Progetto» → non sta lavorando. «In esecuzione Progetto» →
    /// sta lavorando. Qualunque altra cosa: non si sa, e si dice che non si sa.
    private func runningState(_ prefix: String) -> Bool? {
        switch prefix.lowercased() {
        case "inattivo", "idle": return false
        case "in esecuzione", "running": return true
        default: return nil
        }
    }

    // MARK: - Quale chat ha davanti il Desktop

    private static let desktopLog = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Claude/main.log")

    /// La conversazione aperta adesso sul Desktop, **e quante volte e'
    /// cambiata**. Il numero serve come sigillo: se fra due controlli e'
    /// cresciuto, in mezzo il Desktop e' saltato altrove e quello che stavamo
    /// per fare non vale piu'.
    struct Focus: Equatable {
        var session: String?
        var changes: Int
    }

    func focus() -> Focus {
        let marker = "setFocusedSession: sessionId="
        guard let handle = try? FileHandle(forReadingFrom: DesktopBridge.desktopLog) else {
            return Focus(session: nil, changes: -1)
        }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let window: UInt64 = 512 * 1024
        try? handle.seek(toOffset: size > window ? size - window : 0)
        guard let data = try? handle.readToEnd(),
              let tail = String(data: data, encoding: .utf8) else {
            return Focus(session: nil, changes: -1)
        }
        var count = 0
        var last: String?
        for line in tail.split(separator: "\n") {
            guard let r = line.range(of: marker) else { continue }
            count += 1
            let id = line[r.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
            last = (id == "null" || id.isEmpty) ? nil : id
        }
        return Focus(session: last, changes: count)
    }

    func focusedSessionId() -> String? { focus().session }

    /// Quante volte il Desktop ha dichiarato **finito un turno** in questa
    /// sessione. Lo scrive lui nel log (`Query completed for session …`) ed e'
    /// l'unico segnale netto che abbiamo: la riga della barra laterale dice
    /// «In esecuzione» anche solo perche' la sessione e' calda, non perche'
    /// stia rispondendo — controllato, e infatti non serve a questo.
    func completions(sessionId: String) -> Int {
        guard let handle = try? FileHandle(forReadingFrom: DesktopBridge.desktopLog) else { return -1 }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let window: UInt64 = 512 * 1024
        try? handle.seek(toOffset: size > window ? size - window : 0)
        guard let data = try? handle.readToEnd(),
              let tail = String(data: data, encoding: .utf8) else { return -1 }
        let marker = "Query completed for session \(sessionId)"
        return tail.components(separatedBy: marker).count - 1
    }

    // MARK: - Portare il Desktop sulla conversazione giusta

    /// Vero quando il deep link e' **innocuo**: il Desktop conosce gia' quella
    /// sessione con questo identificativo, quindi `importCliSession` esce
    /// subito senza toccare il file. Vedi la nota 1 in cima.
    static func deepLinkIsSafe(cliId: String, desktopSessionId: String) -> Bool {
        desktopSessionId == "local_" + cliId
    }

    /// Apre la conversazione sul Desktop e **aspetta che sia lui a dire**
    /// di esserci arrivato.
    private func bringUp(cliId: String, entry: SessionEntry) -> Outcome {
        let want = entry.sessionId
        guard !want.isEmpty else {
            return .refused(PhoneNotice("unknown_session_id"))
        }
        if focus().session == want { return .delivered }

        if DesktopBridge.deepLinkIsSafe(cliId: cliId, desktopSessionId: want) {
            guard let url = URL(string: "claude://resume?session=\(cliId)") else {
                return .refused(PhoneNotice("bad_conversation_url"))
            }
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = false
            NSWorkspace.shared.open(url, configuration: cfg, completionHandler: nil)
            Log.info("Desktop: apro", cliId, "col deep link")
        } else {
            // Il link qui **importerebbe** una copia e riscriverebbe il file:
            // si tocca la riga nella barra laterale, che non scrive niente.
            let matches = rows().filter { $0.title == entry.title }
            guard matches.count == 1 else {
                return .refused(PhoneNotice("sidebar_ambiguous", ["title": entry.title]))
            }
            AXUIElementPerformAction(matches[0].element, kAXPressAction as CFString)
            Log.info("Desktop: apro «\(entry.title)» dalla barra laterale (niente deep link)")
        }

        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            if focus().session == want { return .delivered }
        }
        return .refused(PhoneNotice("desktop_didnt_switch"))
    }

    // MARK: - Consegna

    /// Consegna il testo dentro il compositore del Desktop e lo manda.
    /// Torna solo dopo aver **visto** che il messaggio e' partito.
    /// Cambia l'**impegno** (effort) di una conversazione muovendo il cursore
    /// dentro il pannello di Claude — la stessa cosa che farebbe chi sta al Mac.
    ///
    /// Il cursore vale per la chat **aperta**, quindi vale la stessa regola
    /// della consegna: prima si apre quella giusta e si verifica, poi si tocca.
    /// Se la verifica non riesce, non si muove niente.
    func setEffort(cliId: String, entry: SessionEntry, to target: Int) -> Outcome {
        guard let app = DesktopBridge.app else { return .notRunning }
        let pid = app.processIdentifier
        enableAX(pid: pid)

        if let why = waitForUser(pid: pid) { return .refused(why) }

        let previous = NSWorkspace.shared.frontmostApplication
        defer { restore(previous, pid: pid) }
        bringForward(pid: pid)

        switch bringUp(cliId: cliId, entry: entry) {
        case .refused(let why): return .refused(why)
        case .notRunning: return .notRunning
        case .delivered: break
        }
        let want = entry.sessionId
        guard focus().session == want else {
            return .refused(PhoneNotice("effort_wrong_chat"))
        }

        guard let picker = waitForEffortPicker() else {
            return .refused(PhoneNotice("effort_picker_missing"))
        }
        clickCenter(of: picker)
        guard let slider = waitForSlider(picker: picker), let now = sliderNumbers(slider) else {
            chiudiPannello()
            return .refused(PhoneNotice("effort_panel_closed"))
        }
        let v = Double(min(max(target, Int(now.min)), Int(now.max)))
        let ok = setSlider(slider, to: v)
        let etichetta = effortLabel() ?? ""
        chiudiPannello()

        // Si ricontrolla che nel frattempo il Desktop non sia saltato altrove.
        guard focus().session == want else {
            return .refused(PhoneNotice("effort_switched_away"))
        }
        guard ok else { return .refused(PhoneNotice("effort_slider_stuck")) }
        Log.info("Desktop: impegno di «\(entry.title)» →", etichetta)
        return .delivered
    }

    /// Chiude il pannello dell'impegno come farebbe una persona.
    private func chiudiPannello() {
        CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.25)
    }

    /// Consegna un messaggio, e se c'e' anche un **allegato**.
    ///
    /// L'allegato non si descrive a parole: si mette il file negli appunti e si
    /// incolla nel compositore, che e' quello che farebbe una persona. Provato
    /// davvero prima di scriverlo (`--attachprobe`): nasce una pastiglia
    /// `epitaxy-attachment-pill` col nome del file, e il pulsante «Invia» si
    /// accende anche senza testo — una foto si manda anche senza didascalia.
    ///
    /// L'ordine e': prima l'allegato, poi il testo. Al contrario ⌘V
    /// sostituirebbe la selezione appena scritta.
    func send(cliId: String, entry: SessionEntry, text message: String,
              attachment: Uploads.Pending? = nil) -> Outcome {
        guard let app = DesktopBridge.app else { return .notRunning }
        let pid = app.processIdentifier
        enableAX(pid: pid)

        lock.lock()
        guard !inFlight.contains(cliId) else {
            lock.unlock()
            return .refused(PhoneNotice("delivery_in_flight"))
        }
        inFlight.insert(cliId)
        lock.unlock()
        defer { lock.lock(); inFlight.remove(cliId); lock.unlock() }

        // 1. Rispetto di chi sta al Mac: se Claude e' davanti ed e' stato
        //    toccato da pochi secondi, potrebbe esserci qualcuno.
        if let why = waitForUser(pid: pid) { return .refused(why) }

        // 2. Si attiva **prima di tutto**, perche' attivare puo' far cambiare
        //    conversazione al Desktop da solo (nota 6). Tutto quel che conta si
        //    verifica dopo. Alla fine si rimette davanti l'app di prima.
        let previous = NSWorkspace.shared.frontmostApplication
        defer { restore(previous, pid: pid) }
        bringForward(pid: pid)

        // 3. La conversazione giusta, aperta davvero.
        switch bringUp(cliId: cliId, entry: entry) {
        case .refused(let why): return .refused(why)
        case .notRunning: return .notRunning
        case .delivered: break
        }
        let want = entry.sessionId

        // 4. Il compositore: dev'esserci, essere vuoto e prendere il fuoco.
        //
        // **Una lettura mancata non e' una risposta: si richiede.** L'albero di
        // accessibilita' di Claude Desktop e' enorme e la lettura costa oltre un
        // secondo; se in quell'istante la finestra sta cambiando — una finestra
        // appena portata avanti, un pannello che si chiude — il riquadro non si
        // trova e il messaggio veniva rifiutato all'istante. Si riprova due
        // volte a mezzo secondo, buttando via l'elemento in cache che potrebbe
        // essere quello vecchio. Se non c'e' davvero, ci si ferma lo stesso:
        // scrivere alla cieca resta fuori discussione.
        var box: Composer
        if let subito = composer() {
            box = subito
        } else {
            var trovato: Composer?
            for _ in 0..<2 {
                Thread.sleep(forTimeInterval: 0.5)
                lock.lock(); cachedComposer = nil; lock.unlock()
                if let c = composer() { trovato = c; break }
            }
            guard let c = trovato else {
                // Perche' non si e' letto: senza questo, la prossima volta si
                // ricomincia a indovinare da capo.
                let davanti = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
                let titolo = DesktopBridge.app.map { finestreDescritte(pid: $0.processIdentifier) } ?? "nessuna app"
                Log.warn("compositore illeggibile · davanti c'è:", davanti, "· Claude mostra:", titolo)
                return .refused(PhoneNotice("composer_unreadable"))
            }
            box = c
        }
        guard box.isEmpty else {
            return .refused(PhoneNotice("composer_not_empty"))
        }
        // Un allegato lasciato li' da qualcun altro non e' roba nostra e
        // partirebbe insieme al nostro messaggio: non si toglie, ci si ferma.
        guard box.pills.isEmpty else {
            return .refused(PhoneNotice("composer_has_attachment", ["name": box.pills[0].name]))
        }
        AXUIElementSetAttributeValue(box.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.3)
        box = composer() ?? box
        guard box.isFocused else {
            return .refused(PhoneNotice("composer_unfocused"))
        }

        // 5. Il sigillo: da qui in poi la conversazione non deve cambiare.
        let sealed = focus()
        guard sealed.session == want else {
            return .refused(PhoneNotice("conversation_switched"))
        }

        // 6. L'allegato, se c'e', **prima** del testo: ⌘V mangerebbe quello
        //    che abbiamo appena scritto.
        if let attachment {
            guard let landed = attachFile(attachment, pid: pid) else {
                removeOurPills(pid: pid)
                return .refused(PhoneNotice("attach_failed", ["name": attachment.name]))
            }
            guard landed else {
                removeOurPills(pid: pid)
                return .refused(PhoneNotice("attach_mismatch", ["name": attachment.name]))
            }
            // Anche l'allegato e' scrittura dentro una conversazione: la stessa
            // verifica del testo, subito dopo averlo appeso.
            guard focus() == sealed else {
                removeOurPills(pid: pid)
                Log.warn("Desktop: la conversazione è cambiata mentre allegavo, non ho mandato niente")
                return .refused(PhoneNotice("conversation_changed_while_writing"))
            }
        }

        // 7. Il testo. Non basta vederlo: deve accendersi «Invia».
        //    Con un allegato la didascalia puo' mancare: la pastiglia da sola
        //    accende gia' «Invia», e non c'e' niente da scrivere.
        if !message.isEmpty {
            guard let landed = deliverText(message, pid: pid) else {
                clearAll(pid: pid, hadAttachment: attachment != nil)
                return .refused(PhoneNotice("text_not_delivered"))
            }
            guard landed else {
                clearAll(pid: pid, hadAttachment: attachment != nil)
                return .refused(PhoneNotice("text_mismatch"))
            }
        }

        // 8. Si ricontrolla **subito prima di mandare**: se nel frattempo il
        //    Desktop e' saltato su un'altra chat, quel che c'e' nel riquadro
        //    non e' piu' roba nostra da mandare — si pulisce e si dice.
        guard focus() == sealed else {
            clearAll(pid: pid, hadAttachment: attachment != nil)
            Log.warn("Desktop: la conversazione è cambiata durante la consegna, non ho mandato niente")
            return .refused(PhoneNotice("conversation_changed_while_writing"))
        }
        guard let now = composer(), let button = now.sendButton, now.canSend,
              message.isEmpty || sameText(now.text, message),
              attachment == nil || now.pills.count == 1 else {
            clearAll(pid: pid, hadAttachment: attachment != nil)
            return .refused(PhoneNotice("composer_lost_message"))
        }
        AXUIElementPerformAction(button, kAXPressAction as CFString)

        // 9. E' partito davvero? Il riquadro torna vuoto, la pastiglia sparisce
        //    e «Invia» si spegne.
        let sent = waitUntil(seconds: 8) {
            guard let after = self.composer() else { return false }
            return after.isEmpty && after.pills.isEmpty && !after.canSend
        }
        guard sent else {
            clearAll(pid: pid, hadAttachment: attachment != nil)
            return .refused(PhoneNotice("send_rejected"))
        }
        Log.info("Desktop: consegnato e inviato in «\(entry.title)» (\(message.count) caratteri"
                 + (attachment.map { ", allegato \($0.name)" } ?? "") + ")")
        return .delivered
    }

    /// Appende il file al compositore: appunti + ⌘V, come farebbe una persona.
    /// `nil` = non e' comparsa nessuna pastiglia; `false` = ne e' comparsa una
    /// che non e' la nostra.
    private func attachFile(_ file: Uploads.Pending, pid: pid_t) -> Bool? {
        InputInjector.shared.pasteFile(file.url, pid: pid)
        var seen: [Pill] = []
        // Un file va letto dal disco e caricato: e' piu' lento di un incolla di
        // testo, e su un allegato da qualche mega si vede.
        let ok = waitUntil(seconds: 12) {
            guard let now = self.composer() else { return false }
            seen = now.pills
            return !now.pills.isEmpty && now.canSend
        }
        guard ok else { return nil }
        guard seen.count == 1 else { return false }
        // Il nome nella pastiglia e' quello del file: se non combacia, quello
        // che sta per partire non e' roba nostra.
        return seen[0].name.isEmpty || seen[0].name == file.name
    }

    /// Toglie le pastiglie che abbiamo appeso noi. Si chiama solo dopo aver
    /// verificato che prima non ce n'erano: qui dentro non c'e' roba di
    /// chi usa il Mac.
    /// Solo per `--attachprobe`: la prova deve poter rimettere a posto.
    func removeOurPillsPublic(pid: pid_t) { removeOurPills(pid: pid) }

    private func removeOurPills(pid: pid_t) {
        for _ in 0..<4 {
            guard let box = composer(), !box.pills.isEmpty else { return }
            guard let button = box.pills[0].remove else { break }
            AXUIElementPerformAction(button, kAXPressAction as CFString)
            Thread.sleep(forTimeInterval: 0.35)
        }
        if let box = composer(), !box.pills.isEmpty {
            Log.warn("Desktop: non sono riuscito a togliere l'allegato dal riquadro")
        }
    }

    private func clearAll(pid: pid_t, hadAttachment: Bool) {
        clearComposer(pid: pid)
        if hadAttachment { removeOurPills(pid: pid) }
    }

    /// Consegna il testo e rilegge. `nil` = non e' arrivato niente;
    /// `false` = e' arrivato qualcosa che non e' il nostro testo.
    private func deliverText(_ message: String, pid: pid_t) -> Bool? {
        for attempt in 1...2 {
            if attempt == 1 {
                InputInjector.shared.pasteText(message, pid: pid)
            } else {
                // L'incolla verso il pid ogni tanto non attecchisce su questa
                // build (PROGRESS §6): la seconda volta si scrive il testo
                // dentro l'evento, senza passare dagli appunti.
                Log.warn("Desktop: l'incolla non è attecchita, riprovo scrivendo il testo")
                InputInjector.shared.typeUnicode(message, pid: pid)
            }
            var seen = ""
            let ok = waitUntil(seconds: 3) {
                guard let now = self.composer() else { return false }
                seen = now.text
                // Il pulsante acceso vuol dire che il testo e' contenuto vero,
                // non solo qualcosa che si vede.
                return now.canSend && !now.isEmpty
            }
            guard ok else { continue }
            return sameText(seen, message)
        }
        return nil
    }

    /// Il compositore normalizza gli a capo: si confronta il contenuto, non il
    /// byte esatto.
    private func sameText(_ got: String, _ want: String) -> Bool {
        let a = got.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = want.trimmingCharacters(in: .whitespacesAndNewlines)
        return a == b || (b.count > 80 && a.hasPrefix(String(b.prefix(80))))
    }

    /// Toglie dal riquadro quello che ci abbiamo messo noi. Si chiama solo
    /// quando il riquadro era vuoto prima: qui dentro non c'e' roba di chi usa il Mac.
    private func clearComposer(pid: pid_t) {
        InputInjector.shared.sendKeyCode(0, flags: .maskCommand, pid: pid)  // ⌘A
        Thread.sleep(forTimeInterval: 0.15)
        InputInjector.shared.sendKey(.backspace, pid: pid)
        Thread.sleep(forTimeInterval: 0.3)
        if let box = composer(), !box.isEmpty {
            Log.warn("Desktop: non sono riuscito a ripulire il riquadro")
        }
    }

    /// Porta Claude davanti: senza, i tasti non arrivano.
    private func bringForward(pid: pid_t) {
        DispatchQueue.main.async { InputInjector.shared.activate(pid: pid) }
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// Rimette davanti l'app che c'era prima. Se il Mac era gia' su Claude non
    /// si tocca niente.
    private func restore(_ app: NSRunningApplication?, pid: pid_t) {
        guard let app, app.processIdentifier != pid, !app.isTerminated else { return }
        DispatchQueue.main.async { app.activate() }
        Thread.sleep(forTimeInterval: 0.25)
    }

    /// Al Mac c'e' qualcuno?
    ///
    /// Per consegnare bisogna portare Claude davanti (nota 5), e rubare il
    /// primo piano a chi sta digitando e' il modo piu' sicuro di far finire i
    /// suoi tasti dentro Claude. Quindi non basta guardare Claude: si guarda
    /// **la tastiera e il mouse del Mac**, chiunque li stia usando.
    ///
    /// Quando qualcuno sta lavorando, si aspetta; se non smette, non si scrive
    /// e lo si dice sul telefono. Chi e' seduto al Mac ha la precedenza:
    /// scrivere da li' gli costa meno che a noi rubargli la scrivania.
    private func macIsInUse(pid: pid_t) -> Bool {
        let keys = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
        let clicks = CGEventSource.secondsSinceLastEventType(.combinedSessionState,
                                                             eventType: .leftMouseDown)
        let moves = CGEventSource.secondsSinceLastEventType(.combinedSessionState,
                                                            eventType: .mouseMoved)
        let idle = min(keys, min(clicks, moves))
        // Con Claude davanti si e' piu' prudenti: li' un tasto in piu' finisce
        // dentro una conversazione.
        let onClaude = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        return idle < (onClaude ? 20 : 10)
    }

    private func waitForUser(pid: pid_t) -> PhoneNotice? {
        guard macIsInUse(pid: pid) else { return nil }
        emit?(["t": "chatNote", "code": "mac_busy_wait"])
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 1)
            if !macIsInUse(pid: pid) { return nil }
        }
        return PhoneNotice("mac_in_use")
    }

    private func waitUntil(seconds: TimeInterval, _ test: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if test() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return test()
    }

    // MARK: - Fermare

    /// Ferma la risposta come farebbe un umano: Esc alla finestra di Claude.
    func stop() {
        guard let app = DesktopBridge.app else { return }
        InputInjector.shared.sendKey(.escape, pid: app.processIdentifier)
        Log.info("Desktop: premuto Esc per fermare")
    }

    /// Esegue la consegna fuori dal filo del server.
    func async(_ block: @escaping () -> Void) { work.async(execute: block) }
}
