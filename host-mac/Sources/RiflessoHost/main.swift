import AppKit
import SwiftUI
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    /// La barra dei menu puo' essere **piena** — su un portatile col notch e'
    /// normale che l'icona non entri. L'app non deve dipenderne: riaprendola
    /// (Spotlight, Finder, `open -a Riflesso`) lo stesso pannello compare come
    /// finestra vera.
    private var panelWindow: NSWindow?
    private var pannelloHost: NSHostingController<MenuBarPanel>?
    private let model = HostViewModel()


    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.info("Riflesso avviato · webapp:", AppHub.webappDirectory.path)

        // L'icona nella barra dei menu e' **l'unica porta** dell'app: non c'e'
        // piu' niente nel Dock. Quindi qui non si apre nessuna finestra —
        // un'app della barra parte in silenzio, e il pannello si apre quando lo
        // chiedi tu. L'unica eccezione la decide `controllaIcona`: se dopo i
        // tentativi il sistema non le da' un posto, apre la finestra da sola,
        // perche' un'app avviata e irraggiungibile sarebbe peggio.
        registraAvvioAutomatico()
        setupStatusItem()
        AppHub.shared.start()

        // Solo per collaudo: normalmente il PIN si legge dalla barra dei menu
        // e non finisce mai su disco.
        if CommandLine.arguments.contains("--emit-pin") {
            print("PIN=\(AuthStore.shared.currentPIN)")
            fflush(stdout)
            // Il PIN e' monouso e si rigenera a ogni accoppiamento: durante il
            // collaudo servono anche i successivi, altrimenti la seconda prova
            // di fila trova sempre un codice gia' bruciato.
            var last = AuthStore.shared.currentPIN
            Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
                let now = AuthStore.shared.currentPIN
                guard now != last else { return }
                last = now
                print("PIN=\(now)")
                fflush(stdout)
            }
        }

        // **All'avvio non si chiede niente.** La Registrazione schermo serve a
        // una cosa sola — lo specchio — e chiederla appena si apre l'app vuol
        // dire pretendere un permesso pesante per una funzione che magari non
        // userai mai. Si chiede quando serve: dal pulsante «Concedi» nel
        // pannello, o quando apri davvero lo specchio. Tutto il resto — chat,
        // invio, allegati — non ne ha bisogno.
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppHub.shared.stop()
        PinSocket.stop()
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = Self.immagineBarra(acceso: AppHub.shared.servizioAcceso, telefoni: 0)
            button.action = #selector(togglePopover(_:))
            button.target = self
        }
        // Spento il servizio — o arrivato (o andato via) l'ultimo telefono —
        // l'icona cambia faccia: e' l'unico modo di accorgersene senza aprire
        // il pannello.
        model.onIconaCambia = { [weak self] acceso, telefoni in
            self?.statusItem?.button?.image = Self.immagineBarra(acceso: acceso, telefoni: telefoni)
        }
        statusItem = item
        controllaIcona(tentativo: 1)

    }

    /// **Nascere non basta: bisogna che il sistema le dia un posto.** macOS crea
    /// l'elemento, dice `isVisible=true`, e poi puo' comunque parcheggiarne la
    /// finestra fuori dallo schermo (0,-6) o sopra l'orologio (1688,1095): da
    /// li' non si vede e non si clicca, pur esistendo. Non c'e' un modo di
    /// chiedergli «mettila a posto», quindi la si fa rinascere: ogni volta il
    /// motore della barra rifa' i conti, e spesso alla seconda ci sta.
    ///
    /// Dopo l'ultimo tentativo, se il posto non arriva, si apre la finestra:
    /// meglio un pannello sullo schermo che un'app avviata e invisibile.
    ///
    /// **Tre facce per lo stesso posto**, non due. Le onde sono il glifo piu'
    /// affollato dei tre e a 16 punti su una barra piena si leggono male:
    /// compaiono solo quando c'e' davvero un telefono dall'altra parte. Cosi'
    /// il disordine arriva insieme all'informazione, e dalla barra si sa se
    /// qualcuno e' collegato **senza aprire il pannello** — che e' la cosa
    /// piu' utile che quei 16 punti possano dire.
    ///
    /// Resta monocromatica per forza (immagine *template*): la differenza la
    /// fa la forma, non il colore.
    private static func immagineBarra(acceso: Bool, telefoni: Int) -> NSImage? {
        let nome = !acceso ? "iphone.gen3.slash"
                 : telefoni > 0 ? "iphone.gen3.radiowaves.left.and.right"
                 : "iphone.gen3"
        let img = NSImage(systemSymbolName: nome, accessibilityDescription: "Riflesso")
        img?.isTemplate = true
        return img
    }

    /// **Si guarda, non si insiste.**
    ///
    /// Prima qui c'era un giro di tentativi che buttava via l'elemento e ne
    /// creava un altro, fino a quattro volte per avvio. Non ha mai funzionato —
    /// quattro rifiuti su quattro, sempre — e c'e' il sospetto fondato che sia
    /// **lui** a bruciare l'identita' dell'app agli occhi della barra: creare e
    /// distruggere elementi a raffica e' esattamente quello che fa un'app
    /// impazzita, ed e' successo due volte che dopo un po' di quel viavai
    /// (e qualche schianto in mezzo) macOS smettesse di dare un posto a
    /// **questa** app, mentre a un'app qualunque appena compilata lo dava
    /// subito. Quindi: l'elemento si crea una volta sola e non lo si tocca piu'.
    ///
    /// Se il posto non arriva, si apre la finestra: meglio un pannello sullo
    /// schermo che un'app avviata e invisibile.
    private func controllaIcona(tentativo: Int = 1) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, let item = self.statusItem, let button = item.button else { return }
            let cornice = button.window?.frame ?? .zero
            // Anche qui conta lo schermo dell'icona: con due monitor,
            // misurare contro quello col fuoco diceva «senza posto» a un'icona
            // che stava benissimo sull'altro.
            let schermo = self.schermoDellIcona.frame
            let inAlto = cornice.maxY > schermo.maxY - 40 && cornice.maxY <= schermo.maxY
            let nonSulBordo = cornice.maxX < schermo.maxX - 1
            let visibile = inAlto && nonSulBordo
                && (button.window?.isVisible ?? false) && item.isVisible
            Log.info("icona nella barra:", visibile ? "a posto" : "senza posto",
                     "· finestra=\(Int(cornice.origin.x)),\(Int(cornice.origin.y))",
                     "\(Int(cornice.width))x\(Int(cornice.height))")
            if !visibile {
                Log.warn("il sistema non da' un posto all'icona: apro la finestra")
                self.showPanelWindow()
            }
        }
    }

    /// Riapertura dell'app: e' il gesto di chi non trova l'icona.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanelWindow()
        return true
    }

    /// **Il pannello e' una finestra, non piu' una bolla.**
    ///
    /// Da bolla (`NSPopover`) il posto lo sceglieva macOS, e lo sceglieva male:
    /// il pannello e' alto, e la testata — nome, stato, interruttore — finiva
    /// **sopra il bordo dello schermo**, tagliata via. Da una bolla non si puo'
    /// discutere: si apre dove vuole lei. Cosi' invece il posto lo decidiamo:
    /// incollata a destra e appesa sotto la barra dei menu, come il Centro di
    /// Controllo. E l'altezza non supera mai lo spazio disponibile — se un
    /// giorno il contenuto crescesse, si scorre invece di sparire fuori.
    func showPanelWindow() {
        model.refresh()
        let w = panelWindow ?? creaPannello()
        panelWindow = w
        posizionaPannello(w)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func creaPannello() -> NSWindow {
        // La finestra si lascia dimensionare **dal contenuto**: e' AppKit a
        // chiedere a SwiftUI quanto vuole essere, e la risposta e' giusta
        // perche' la vista sta dentro una finestra vera. Misurarla a mano prima,
        // su una copia mai mostrata, dava numeri diversi a ogni giro — 785 la
        // prima volta, 352 la seconda, sullo stesso identico contenuto.
        let host = NSHostingController(rootView: MenuBarPanel(model: model))
        // Senza questo la finestra prende la misura del pannello **com'era
        // nell'istante in cui e' nata** — spesso vuoto, QR non ancora
        // disegnato: 323 punti per un contenuto che ne vuole 750 — e non la
        // aggiorna piu'. Con `preferredContentSize` la finestra insegue il
        // contenuto: si allunga quando il QR arriva e si accorcia da sola
        // quando spegni il servizio.
        if #available(macOS 13.0, *) { host.sizingOptions = [.preferredContentSize] }
        // **Niente area sicura, o il pannello si schianta quando si accorcia.**
        //
        // Con `fullSizeContentView` SwiftUI riserva in cima i punti della
        // testata, e li ricalcola a ogni cambio di misura della finestra. Ma la
        // misura della finestra qui la decide il contenuto
        // (`preferredContentSize`): spegnendo il servizio la finestra si
        // accorcia, l'accorciamento fa ricalcolare l'area sicura, e il
        // ricalcolo chiede alla finestra un altro giro di layout **mentre
        // quello di prima è ancora in corso**. AppKit solleva un'eccezione e
        // l'app muore:
        //
        //     -[NSWindow _changeWindowFrameFromConstraintsIfNecessary]
        //       -[NSView setFrameSize:]
        //         NSHostingView.invalidateSafeAreaInsets()
        //           -[NSWindow _postWindowNeedsUpdateConstraints]   → throw
        //
        // Succedeva al primo tocco dell'interruttore in cima al pannello, ogni
        // volta. Senza area sicura il giro non parte: la striscia in cima sotto
        // cui passa il semaforo di chiusura la mette il pannello con la sua
        // imbottitura, che è una misura fissa e non fa ricalcolare niente.
        host.safeAreaRegions = []
        pannelloHost = host
        // La maschera si da' **alla nascita**, non dopo: creando la finestra
        // con `NSWindow(contentViewController:)` e aggiungendo
        // `fullSizeContentView` un attimo dopo, la vista resta dov'era —
        // sotto la testata — e il semaforo di chiusura finisce a galleggiare
        // 23 punti sopra il pannello, fuori dal vetro. Si vede benissimo, ed
        // e' esattamente la cosa che si voleva togliere.
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 600),
                         styleMask: [.titled, .closable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.contentViewController = host
        // **Questo non e' un documento.** Con `[.titled, .closable]` e basta,
        // il pannello indossava la cornice di una finestra di testo: barra del
        // titolo grigia, tre semafori e la scritta «Riflesso» sopra una cosa
        // che vorrebbe essere il Centro di Controllo. Era il pezzo piu' datato
        // di tutta l'app, ed e' fuori da `MenuBarUI.swift`: per questo
        // sfuggiva.
        //
        // `fullSizeContentView` fa arrivare il contenuto fin sotto la testata,
        // trasparente e senza titolo. **Il semaforo rosso resta**, e i due
        // grigi no: chiudere serve — e' il ripiego di quando macOS non da' un
        // posto all'icona nella barra e questa finestra e' l'unico modo di
        // arrivare all'app — mentre ridurre a icona e ingrandire, su un
        // pannello che decide da solo la sua altezza, non vogliono dire
        // niente.
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isMovableByWindowBackground = true
        w.standardWindowButton(.miniaturizeButton)?.isHidden = true
        w.standardWindowButton(.zoomButton)?.isHidden = true
        // Senza queste due il vetro non si vede: `NSVisualEffectView` in
        // `.behindWindow` ha bisogno che la finestra lo lasci passare, e un
        // `.background()` in SwiftUI da solo non basta.
        w.backgroundColor = .clear
        w.isOpaque = false
        w.hasShadow = true
        // **Scuro di suo**, come il telefono. Il pannello e' costruito con la
        // luce che batte dall'alto su un fondo tiepido — schede fatte di
        // bianco al 4%, fili di bianco al 7%: su una finestra chiara non
        // sarebbero deboli, sarebbero **invisibili**. Seguire l'aspetto di
        // sistema vorrebbe dire disegnarne due, e le due facce di Riflesso
        // smetterebbero di rimare proprio qui.
        w.appearance = NSAppearance(named: .darkAqua)
        w.title = "Riflesso"
        w.isReleasedWhenClosed = false
        w.level = .floating
        return w
    }

    /// **Si avvia da sola al login.** Serve perche' Riflesso ha senso quando sei
    /// fuori: se il Mac si riavvia e l'app non riparte, te ne accorgi dal
    /// telefono — cioe' nell'unico momento in cui non puoi accenderla, perche'
    /// per farlo dovresti essere davanti al Mac.
    ///
    /// Si chiede **una volta sola**. Se poi lo spegni in Impostazioni →
    /// Generali → Elementi di apertura, l'app non te lo riaccende al prossimo
    /// avvio: un'app che rimette da sola una scelta che hai disfatto e' un'app
    /// di cui non ti fidi piu'.
    private func registraAvvioAutomatico() {
        let chiave = "riflesso.avvio.gia.chiesto"
        guard !UserDefaults.standard.bool(forKey: chiave) else { return }
        UserDefaults.standard.set(true, forKey: chiave)
        do {
            try SMAppService.mainApp.register()
            Log.info("avvio automatico: attivato")
        } catch {
            Log.warn("avvio automatico non attivato:", error.localizedDescription)
        }
    }

    /// Lo schermo su cui vive **l'icona**, non quello che ha il fuoco.
    ///
    /// `NSScreen.main` non vuol dire «lo schermo principale»: vuol dire «quello
    /// che in questo momento ha il fuoco della tastiera». Con due monitor il
    /// pannello seguiva il fuoco invece della sua icona, e finiva a (1801,
    /// -1406) — cioe' fuori da tutti e due gli schermi visibili. Il pannello
    /// pende dall'icona: l'ancora giusta e' lo schermo dell'icona.
    private var schermoDellIcona: NSScreen {
        // Nemmeno `window?.screen` va bene: per una finestra di barra dei menu
        // risponde a modo suo. Lo si calcola a mano — quale schermo contiene il
        // punto dove l'icona sta davvero — e in mancanza si usa lo schermo
        // **primario**, che e' quello che possiede la barra dei menu
        // (`NSScreen.screens[0]`), non quello col fuoco.
        if let p = statusItem?.button?.window?.frame.origin,
           let s = NSScreen.screens.first(where: { NSPointInRect(p, $0.frame) }) {
            return s
        }
        return NSScreen.screens.first ?? NSScreen.main!
    }

    private func posizionaPannello(_ w: NSWindow) {
        let libero = schermoDellIcona.visibleFrame
        // **L'altezza non si tocca.** La decide SwiftUI, e la finestra la
        // segue da sola anche quando il contenuto cambia — da servizio spento
        // il pannello e' meta', e si accorcia senza che nessuno glielo dica.
        // Ogni tentativo di misurarla a mano ha dato numeri sbagliati: 323
        // punti per un contenuto che ne vuole 750. Si interviene solo se non
        // ci sta nello schermo, che e' l'unico caso in cui SwiftUI non puo'
        // saperlo.
        let massima = libero.height - 24
        if w.frame.height > massima {
            w.setContentSize(NSSize(width: 360, height: massima - 28))
        }
        // `visibleFrame` finisce gia' sotto la barra dei menu: appoggiarcisi
        // vuol dire non entrarci mai dentro.
        // La larghezza va scritta a mano, non chiesta alla finestra: alla
        // **prima** apertura la finestra non ha ancora preso la sua misura, e
        // `w.frame.width` vale quasi zero — il pannello finiva incollato al
        // bordo destro, fuori per tre quarti.
        w.setFrameTopLeftPoint(NSPoint(x: libero.maxX - 360 - 12,
                                       y: libero.maxY - 4))
    }

    @objc private func togglePopover(_ sender: Any?) {
        if let w = panelWindow, w.isVisible {
            w.orderOut(sender)
        } else {
            showPanelWindow()
        }
    }
}

// L'app vive nella barra dei menu: nessuna icona nel Dock, nessuna finestra principale.
let arguments = CommandLine.arguments

// Prova del lettore senza interfaccia: utile in fase di collaudo.
if arguments.contains("--chatdump") {
    ChatDump.run()
    exit(0)
}

// `--print-pin` **non avvia niente**: chiede il PIN all'istanza gia' in
// esecuzione — dal socket Unix di `PinSocket`, non piu' via HTTP — lo stampa
// ed esce. Prima apriva una seconda copia che litigava sulla porta («Address
// already in use»).
// `--axdump` elenca i comandi che la finestra di Claude espone: serve a
// trovare il selettore dell'effort prima di poterlo premere.
// `--effortprobe` apre il pannello dell'effort e dice com'e' fatto il cursore.
// `--effortmap` prova ogni posizione del cursore e dice come si chiama.
if arguments.contains("--effortmap") {
    let b = DesktopBridge.shared
    guard let picker = b.waitForEffortPicker() else { print("selettore non trovato"); exit(1) }
    DesktopBridge.app?.activate(); Thread.sleep(forTimeInterval: 0.4)
    b.clickCenter(of: picker)
    guard let slider = b.effortSlider(), let start = b.sliderNumbers(slider) else {
        print("cursore non trovato"); exit(1)
    }
    print(String(format: "partenza: %.0f (%@)", start.val, b.effortLabel() ?? "?"))
    for v in stride(from: start.min, through: start.max, by: 1) {
        _ = b.setSlider(slider, to: v)
        let letto = b.sliderNumbers(slider)?.val ?? -1
        print(String(format: "  posizione %.0f → letto %.0f · etichetta %@", v, letto, b.effortLabel() ?? "?"))
    }
    _ = b.setSlider(slider, to: start.val)
    print(String(format: "rimesso a %.0f (%@)", start.val, b.effortLabel() ?? "?"))
    exit(0)
}

if arguments.contains("--effortprobe") {
    let b = DesktopBridge.shared
    guard let picker = b.waitForEffortPicker() else { print("selettore non trovato"); exit(1) }
    DesktopBridge.app?.activate()
    Thread.sleep(forTimeInterval: 0.4)
    b.clickCenter(of: picker)
    guard let slider = b.effortSlider() else { print("cursore non trovato"); exit(1) }
    if let n = b.sliderNumbers(slider) {
        print(String(format: "cursore: valore %.3f · da %.3f a %.3f", n.val, n.min, n.max))
    } else {
        print("cursore trovato ma senza numeri leggibili")
    }
    print("etichetta del selettore adesso: \(b.effortLabel() ?? "?")")
    exit(0)
}

if arguments.contains("--effortmenu") {
    let o = DesktopBridge.shared.effortOptions()
    if o.isEmpty {
        let prima = Set(DesktopBridge.primaDellaPressione)
        let nuovi = DesktopBridge.dopoLaPressione.filter { !prima.contains($0) }
        if !DesktopBridge.primaDellaPressione.isEmpty {
            print("selettore TROVATO. Comparso dopo la pressione (\(nuovi.count) voci):")
            for l in nuovi.prefix(14) { print("   ", l.trimmingCharacters(in: .whitespaces)) }
            exit(0)
        }
        print("selettore dell'effort non trovato · etichette come le vede il cercatore:")
        for l in DesktopBridge.ultimeEtichette.suffix(6) { print("   [\(l)]") }
        print("--- e come le vede il dump:")
        for l in DesktopBridge.shared.dumpControls() where l.contains("AXPopUpButton") { print("   ", l.trimmingCharacters(in: .whitespaces)) }
    } else {
        print("voci: " + o.joined(separator: " · "))
    }
    exit(0)
}

// `--groupsprobe [file]` dice cosa legge l'app dalla configurazione di Claude
// Desktop: quali gruppi, e quale conversazione sta in quale. Sola lettura —
// quel file non lo scriviamo mai. Con un percorso si prova su un file finto,
// che è il modo di controllare che una forma diversa da quella attesa non
// rompa niente ma faccia solo tornare l'elenco piatto.
if let i = arguments.firstIndex(of: "--groupsprobe") {
    let url = i + 1 < arguments.count && !arguments[i + 1].hasPrefix("--")
        ? URL(fileURLWithPath: arguments[i + 1])
        : DesktopGroups.configURL
    print("leggo: \(url.path)")
    let (gruppi, assegnazioni, fissate) = DesktopGroups.parse(url: url)
    print("fissate: \(fissate.count) in ordine")
    if gruppi.isEmpty {
        print("nessun gruppo → l'elenco resta piatto, come prima.")
        exit(0)
    }
    SessionsIndex.shared.reloadNow()
    let sessioni = SessionsIndex.shared.entries(includeArchived: true, limit: 2000)
    for g in gruppi {
        let dentro = assegnazioni.filter { $0.value == g.id }.keys
        let vive = dentro.compactMap { sid in sessioni.first { $0.sessionId == sid } }
        print("\n\(g.name)\(g.starred ? " ★" : "")  ·  \(dentro.count) assegnazioni, \(vive.count) ancora sul disco")
        for s in vive.sorted(by: { $0.lastActivityAt > $1.lastActivityAt }) {
            print("   \(s.isArchived ? "archiviata" : "          ")  \(s.title)")
        }
    }
    let senza = sessioni.filter { !$0.isArchived && !$0.isRoutine && assegnazioni[$0.sessionId] == nil }
    print("\nsenza gruppo: \(senza.count) conversazioni — restano dove sono, senza intestazione.")
    exit(0)
}

if arguments.contains("--axdump") {
    for line in DesktopBridge.shared.dumpControls() { print(line) }
    exit(0)
}

if arguments.contains("--print-pin") {
    exit(PinClient.printPIN())
}

// `--desktopread` dice cosa vede l'host della finestra di Claude Desktop:
// quale conversazione ha davanti, se il riquadro di scrittura e' vuoto, quali
// righe ci sono nella barra laterale e quali stanno lavorando. Sola lettura:
// e' il modo di controllare le verifiche **senza** scrivere niente.
if arguments.contains("--desktopread") {
    guard DesktopBridge.shared.isRunning else {
        print("Claude Desktop non è in esecuzione.")
        exit(1)
    }
    let t0 = Date()
    let box = DesktopBridge.shared.composer()
    let rows = DesktopBridge.shared.rows()
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    let focused = DesktopBridge.shared.focusedSessionId()
    SessionsIndex.shared.reloadNow()
    let entry = SessionsIndex.shared.entries(includeArchived: true, limit: 1000)
        .first { $0.sessionId == focused }
    print("conversazione aperta: \(entry?.title ?? "—")  [\(focused ?? "nessuna")]")
    if let cli = entry?.cliSessionId, !cli.isEmpty {
        let safe = DesktopBridge.deepLinkIsSafe(cliId: cli, desktopSessionId: entry?.sessionId ?? "")
        print("deep link:            \(safe ? "sicuro (naviga e basta)" : "NO — importerebbe un doppione")")
    }
    if let box {
        print("compositore:          \(box.isEmpty ? "vuoto" : "CONTIENE TESTO")"
              + (box.isFocused ? " · col fuoco" : "")
              + (box.canSend ? " · «Invia» acceso" : ""))
        if !box.isEmpty {
            print("  dentro c'è:         «\(box.text.prefix(60))»")
        }
    } else {
        print("compositore:          non trovato (albero di accessibilità illeggibile)")
    }
    let working = rows.filter { $0.running == true }.map { $0.title }
    print("righe nella barra:    \(rows.count)"
          + (working.isEmpty ? "" : " · in esecuzione: \(working.joined(separator: ", "))"))
    print("lettura in:           \(ms) ms")
    exit(0)
}

// `--attachprobe <file>` risponde alle domande che contano sugli allegati, e
// le risponde **senza mandare niente**:
//
//   1. mettere un file negli appunti e incollarlo nel compositore lo allega
//      davvero? (la pastiglia `epitaxy-attachment-pill`)
//   2. la si ritrova, e si riesce a **toglierla**?
//   3. l'allegato e la didascalia convivono, con «Invia» acceso? — cioè:
//      tutto il giro di `DesktopBridge.send` tranne l'ultima pressione, che
//      è la stessa già usata da anni per i messaggi di solo testo.
//
// Alla fine ripulisce quello che ha messo. Da rifare a ogni versione nuova
// di Claude Desktop: è lì che si scopre se la pastiglia si chiama ancora
// così. Rifiuta di partire se nel riquadro c'è già roba di qualcuno.
if let i = arguments.firstIndex(of: "--attachprobe") {
    guard i + 1 < arguments.count else {
        FileHandle.standardError.write(Data("uso: Riflesso --attachprobe <file> [didascalia]\n".utf8))
        exit(2)
    }
    let path = arguments[i + 1]
    let didascalia = i + 2 < arguments.count ? arguments[i + 2] : "prova di allegato — NON inviare"
    guard FileManager.default.fileExists(atPath: path) else { print("manca il file \(path)"); exit(2) }
    guard let app = DesktopBridge.app else { print("Claude Desktop non è in esecuzione."); exit(1) }
    let pid = app.processIdentifier
    DesktopBridge.shared.enableAXPublic(pid: pid)

    guard let prima = DesktopBridge.shared.composer() else {
        print("compositore non trovato"); exit(1)
    }
    guard prima.isEmpty, prima.pills.isEmpty else {
        print("il riquadro non è vuoto (\(prima.pills.count) allegati): non tocco niente")
        exit(1)
    }
    print("prima:      riquadro vuoto · «Invia» \(prima.canSend ? "acceso" : "spento")")

    // Senza Claude davanti i tasti non arrivano (nota 5 in DesktopBridge), e
    // la prova direbbe «l'incolla non funziona» quando invece non è nemmeno
    // partita. Succede sul serio: con un'app a tutto schermo davanti — un
    // video, per dire — macOS **rifiuta** di cedere il primo piano.
    app.activate()
    Thread.sleep(forTimeInterval: 1.2)
    let davanti = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    guard davanti else {
        let chi = NSWorkspace.shared.frontmostApplication?.localizedName ?? "un'altra app"
        print("Claude non viene davanti: davanti c'è \(chi).")
        print("Senza il primo piano i tasti non arrivano e questa prova non dice niente.")
        print("Chiudi o riduci quella finestra e rilancia.")
        exit(2)
    }
    InputInjector.shared.pasteFile(URL(fileURLWithPath: path), pid: pid)
    Thread.sleep(forTimeInterval: 3)

    let dopo = DesktopBridge.shared.composer()
    print("allegato:   \(dopo?.pills.count ?? 0) pastiglie · «Invia» \(dopo?.canSend == true ? "acceso" : "spento")")
    for p in dopo?.pills ?? [] {
        print("            · «\(p.name)» \(p.remove == nil ? "SENZA pulsante rimuovi" : "con pulsante rimuovi")")
    }

    // La didascalia sopra l'allegato: è il passo che nella consegna vera
    // viene subito dopo, ed è quello che potrebbe mangiarsi la pastiglia.
    InputInjector.shared.pasteText(didascalia, pid: pid)
    Thread.sleep(forTimeInterval: 2)
    let insieme = DesktopBridge.shared.composer()
    let convivono = (insieme?.pills.count ?? 0) == 1 && insieme?.canSend == true
        && !(insieme?.isEmpty ?? true)
    print("con testo:  \(insieme?.pills.count ?? 0) pastiglie · testo «\((insieme?.text ?? "").prefix(40))»"
          + " · «Invia» \(insieme?.canSend == true ? "acceso" : "spento")")
    print("            → allegato e didascalia \(convivono ? "convivono: si potrebbe inviare" : "NON convivono")")

    // Si rimette tutto com'era: prima il testo, poi la pastiglia.
    InputInjector.shared.sendKeyCode(0, flags: .maskCommand, pid: pid)   // ⌘A
    Thread.sleep(forTimeInterval: 0.2)
    InputInjector.shared.sendKey(.backspace, pid: pid)
    Thread.sleep(forTimeInterval: 0.4)
    DesktopBridge.shared.removeOurPillsPublic(pid: pid)
    let pulito = DesktopBridge.shared.composer()
    print("pulito:     \(pulito?.pills.count ?? 0) pastiglie · riquadro "
          + "\(pulito?.isEmpty == true ? "vuoto" : "CON TESTO") · «Invia» "
          + "\(pulito?.canSend == true ? "acceso" : "spento")")

    let tuttoBene = (dopo?.pills.count ?? 0) == 1 && convivono
        && (pulito?.pills.count ?? 1) == 0 && pulito?.isEmpty == true
    print(tuttoBene ? "\nesito: la strada degli allegati regge." : "\nesito: qualcosa non torna, vedi sopra.")
    exit(tuttoBene ? 0 : 1)
}

// `--desktopsend <cliId> <testo> [--allega <file>]` consegna un messaggio
// **attraverso il Desktop**, con tutte le verifiche. Serve al collaudo: si usa
// solo su una sessione di prova. Con `--allega` fa il giro intero degli
// allegati (appunti → pastiglia → testo → invio) senza passare dal telefono.
if let i = arguments.firstIndex(of: "--desktopsend") {
    guard i + 2 < arguments.count else {
        FileHandle.standardError.write(Data("uso: Riflesso --desktopsend <cliSessionId> <testo> [--allega <file>]\n".utf8))
        exit(2)
    }
    let id = arguments[i + 1], body = arguments[i + 2]
    var allegato: Uploads.Pending?
    if let f = arguments.firstIndex(of: "--allega"), f + 1 < arguments.count {
        let url = URL(fileURLWithPath: arguments[f + 1])
        guard let data = try? Data(contentsOf: url) else {
            print("non riesco a leggere \(url.path)"); exit(2)
        }
        // Si fa passare dalla stessa porta del telefono, cosi' la prova
        // esercita anche la cartella temporanea e la ripulitura del nome.
        guard let p = try? Uploads.shared.accept(id: "", name: url.lastPathComponent,
                                                 mime: "application/octet-stream",
                                                 declaredSize: data.count,
                                                 index: 0, total: 1, bytes: data) else {
            print("l'allegato non è stato accettato (troppo grande?)"); exit(2)
        }
        allegato = p
        print("allegato: \(p.name) · \(p.written) byte")
    }
    SessionsIndex.shared.reloadNow()
    guard let entry = SessionsIndex.shared.entry(cliSessionId: id) else {
        print("questa conversazione non è fra quelle del Desktop")
        exit(1)
    }
    print("verso: «\(entry.title)» [\(entry.sessionId)]")
    switch DesktopBridge.shared.send(cliId: id, entry: entry, text: body, attachment: allegato) {
    case .delivered:
        print("consegnato al Desktop e inviato.")
        exit(0)
    case .refused(let why):
        print("non inviato: \(why.code)")
        exit(1)
    case .notRunning:
        print("Claude Desktop non è in esecuzione.")
        exit(1)
    }
}

// `--where <id>` dice con quale cartella si riprenderebbe una conversazione,
// e perche'. Sola lettura: e' il modo di controllare la scelta senza scrivere
// dentro una chat.
if let i = arguments.firstIndex(of: "--where") {
    guard i + 1 < arguments.count else {
        FileHandle.standardError.write(Data("uso: Riflesso --where <cliSessionId>\n".utf8))
        exit(2)
    }
    let id = arguments[i + 1]
    SessionsIndex.shared.reloadNow()
    TranscriptIndex.shared.refreshNow()
    guard let info = TranscriptIndex.shared.info(for: id) else {
        print("transcript: nessuno su questo Mac")
        exit(1)
    }
    let peek = TranscriptReader.window(url: info.url, wantItems: 1, maxScan: 256 * 1024).cwd ?? "—"
    print("transcript:        \(info.url.path)")
    print("cartella-progetto: \(info.url.deletingLastPathComponent().lastPathComponent)")
    print("cwd nel file:      \(peek)")
    guard let scelta = ProjectFolder.folder(cliId: id) else {
        print("scelta:            nessuna")
        exit(1)
    }
    print("scelta:            \(scelta.path)")
    print("perche':           \(scelta.why)")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// **Si vive nella barra dei menu, non nel Dock.** `.accessory` toglie l'icona dal
// Dock e dal Cmd-Tab: l'app resta raggiungibile dall'icona in alto, e si chiude
// dal pulsante «Esci» del pannello. Va detto anche qui e non solo nell'Info.plist:
// una `.regular` scritta a mano rimetterebbe l'icona nel Dock a dispetto di
// `LSUIElement`.
app.setActivationPolicy(.accessory)
app.run()
