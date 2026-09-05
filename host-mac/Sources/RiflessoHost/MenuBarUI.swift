import SwiftUI
import AppKit
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins

final class HostViewModel: ObservableObject {
    @Published var lang = L.resolved()
    @Published var serverStatus = ""
    @Published var url = ""
    @Published var lanURLs: [String] = []
    @Published var pin = ""
    @Published var pinNote = ""
    @Published var deviceCount = 0
    @Published var liveClients = 0
    @Published var accessibilityGranted = false
    @Published var injectionMode: InjectionMode = .pid
    @Published var windows: [WindowRef] = []
    @Published var lastAction = ""
    /// Il segreto della stanza sul ponte e' rinato con dei telefoni gia'
    /// accoppiati: quelli collegati dal ponte bussano a una stanza vuota e
    /// devono rifare il QR. Vedi `AuthStore.meetSecretReborn`.
    @Published var meetReborn = false
    /// Il ponte: stato, telefoni collegati, indirizzo, avvisi.
    @Published var remoteState = ""
    @Published var remoteUp = 0
    @Published var remoteBase = ""
    @Published var remoteNote = ""
    @Published var remoteError = false
    @Published var remoteConfigured = false
    /// Quale delle due strade sta dentro il QR adesso.
    @Published var strada: Strade.Scelta = .casa("")
    /// L'indirizzo dell'accoppiamento (link **e** codice insieme), il suo QR e
    /// la misura **in punti** a cui va mostrato. La misura viaggia con
    /// l'immagine perche' il numero di moduli dipende dalla lunghezza
    /// dell'indirizzo: vedi `qr(for:)`.
    @Published var pairURL = ""
    @Published var pairQR: NSImage?
    @Published var pairQRSide: CGFloat = 124

    /// Acceso/spento del **servizio**, non dello specchio.
    @Published var serviceOn = true
    /// L'icona nella barra deve cambiare faccia quando il servizio si spegne
    /// **e** quando arriva o se ne va l'ultimo telefono: e' l'unica cosa che si
    /// vede senza aprire il pannello.
    var onIconaCambia: ((Bool, Int) -> Void)?
    /// L'ultima faccia mostrata: (acceso, c'e' almeno un telefono).
    private var facciaIcona: (Bool, Bool) = (true, false)

    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        AuthStore.shared.onChange = { [weak self] in self?.refresh() }
        AppHub.shared.onStateChange = { [weak self] in self?.refresh() }
    }

    func refresh() {
        let hub = AppHub.shared
        lang = L.resolved()
        serverStatus = hub.serverStatusText
        url = hub.primaryURL
        lanURLs = hub.lanAddresses.map { "http://\($0):\(hub.server.port)" }
        // Un codice scaduto sullo schermo manda a battere otto cifre che
        pin = AuthStore.shared.currentPIN
        let pinCode = AuthStore.shared.pinNote
        pinNote = pinCode.isEmpty ? "" : L.t(pinCode)
        deviceCount = AuthStore.shared.pairedCount
        liveClients = hub.server.connectedDeviceCount
        accessibilityGranted = AXIsProcessTrusted()
        injectionMode = hub.injector.mode
        let acceso = AppHub.shared.servizioAcceso
        if acceso != serviceOn { serviceOn = acceso }
        // L'icona ha tre facce e la terza dipende dai telefoni: si ridisegna
        // anche quando `liveClients` attraversa lo zero, non solo quando
        // cambia l'interruttore.
        let faccia = (acceso, liveClients > 0)
        if faccia != facciaIcona {
            facciaIcona = faccia
            onIconaCambia?(acceso, liveClients)
        }
        meetReborn = AuthStore.shared.meetSecretReborn

        let ponte = RemoteLink.shared
        remoteUp = ponte.upCount
        let codice = ponte.statusCode
        remoteState = L.remote(code: codice, n: remoteUp, detail: ponte.lastErrorText)
        remoteNote = ponte.bridgeNote
        remoteError = codice == "bad_url" || codice == "listening_error"
        remoteConfigured = ponte.canPair
        // Mentre lo si sta scrivendo non glielo si riscrive sotto le dita.
        if !editingRemoteBase { remoteBase = ponte.baseURL }
        strada = Strade.perQR

        // Il QR si rifà **solo** quando cambia l'indirizzo: ridisegnarlo ogni
        // secondo vorrebbe dire un giro di CoreImage al secondo per un'immagine
        // identica.
        let wanted = Strade.pairingURL
        if wanted != pairURL {
            pairURL = wanted
            if wanted.isEmpty {
                pairQR = nil
            } else if let (img, lato) = HostViewModel.qr(for: wanted) {
                pairQR = img
                pairQRSide = lato
            } else {
                pairQR = nil
            }
        }
    }

    /// Vero mentre si sta digitando l'indirizzo del ponte.
    var editingRemoteBase = false

    /// L'indirizzo del ponte scritto nel pannello diventa quello vero.
    func salvaPonte() {
        RemoteLink.shared.baseURL = remoteBase
        editingRemoteBase = false
        lastAction = remoteBase.isEmpty ? L.t("bridge_cleared") : L.t("bridge_saved")
        refresh()
    }

    /// Il QR con dentro link e codice insieme, **e la misura in punti a cui va
    /// mostrato**. `CIQRCodeGenerator` è dentro macOS: nessuna libreria in
    /// più, coerente col resto del progetto.
    ///
    /// Correzione `M`: il codice viene inquadrato da vicino su uno schermo, non
    /// stampato su una scatola. Nessun filtro di ingrandimento — il QR nasce
    /// piccolissimo (una cella per pixel) e va scalato **a blocchi**, altrimenti
    /// l'interpolazione sfuma i bordi e la fotocamera fatica.
    ///
    /// **Qui il codice diceva la cosa giusta e faceva quella sbagliata**, due
    /// volte. Misurato sul payload vero (37 byte, 31 moduli):
    ///
    ///     passo 1   lato 132 / 31 moduli      = ×4,2581  → CoreImage interpola
    ///     passo 2   132 px mostrati a 110 pt  = ×1,6667  → nearest neighbour
    ///
    /// Nessuno dei due rapporti è intero, quindi succedeva esattamente quello
    /// che il commento voleva evitare: i moduli finivano larghi 7 o 8 pixel a
    /// seconda di dove cadevano. E il QR *è* il prodotto — se non si inquadra
    /// al primo colpo, l'app non parte.
    ///
    /// Adesso si sceglie **quanti pixel-schermo vale un modulo** — un numero
    /// intero — e tutto il resto discende. L'immagine dichiara la sua misura in
    /// punti, così un pixel dell'immagine è un pixel dello schermo e non resta
    /// niente da ricampionare.
    ///
    /// La misura torna insieme all'immagine perché il numero di moduli dipende
    /// dalla lunghezza dell'indirizzo (col ponte cambia): un `frame`
    /// costante non potrebbe essere sempre un multiplo intero. **La vista deve
    /// usare il valore tornato, non una costante.**
    static func qr(for text: String, puntiVoluti: CGFloat = 132) -> (NSImage, CGFloat)? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage else { return nil }

        let scalaSchermo = NSScreen.main?.backingScaleFactor ?? 2
        let moduli = max(out.extent.width, 1)
        let k = max(1, (puntiVoluti * scalaSchermo / moduli).rounded(.down))
        let latoPx = moduli * k
        let big = out.transformed(by: CGAffineTransform(scaleX: k, y: k))
        guard let cg = CIContext().createCGImage(big, from: big.extent) else { return nil }

        let punti = latoPx / scalaSchermo
        return (NSImage(cgImage: cg, size: NSSize(width: punti, height: punti)), punti)
    }


}

// MARK: - I pezzi della veste
//
// Sul telefono queste tre cose le fa il CSS in una riga l'una. Qui vanno
// scritte a mano, e sono le uniche tre che servono: il vetro, la scheda, il
// filo. Tutto il resto del pannello è composto con queste.

/// **Il vetro.** È la stessa idea delle barre della webapp: sotto si intravede
/// quello che c'è, e questo dice da solo che il pannello sta *sopra* qualcosa
/// invece di essere una scatola grigia appoggiata al niente. Finché una faccia
/// dell'app era vetro e l'altra cartone, la parentela fra le due non si vedeva.
///
/// `.behindWindow` è quello che fa vedere la scrivania sotto; `.withinWindow`
/// sfocherebbe solo il contenuto della finestra, cioè qui niente. Serve che la
/// finestra sia trasparente (`main.swift`): un `.background()` non basta.
struct Vetro: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover
    var raggio: CGFloat = 12

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.blendingMode = .behindWindow
        v.state = .active            // vetro anche quando la finestra non ha il fuoco
        v.material = material
        // Gli angoli li arrotonda il layer e non un `clipShape` di SwiftUI: la
        // maschera di SwiftUI e il layer di AppKit non sempre vanno d'accordo,
        // e quando non vanno d'accordo restano gli angoli quadri.
        v.wantsLayer = true
        v.layer?.cornerRadius = raggio
        v.layer?.cornerCurve = .continuous
        v.layer?.masksToBounds = true
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.layer?.cornerRadius = raggio
    }
}

/// **La scheda.** La regola «i bordi sono luce, non righe» tradotta in SwiftUI:
/// il bordo è un gradiente, chiaro in cima dove batte la luce e quasi niente in
/// fondo. È l'`inset 0 1px 0 var(--edge-lit)` del foglio di stile.
struct Riquadro<Contenuto: View>: View {
    var raggio: CGFloat = 10
    var imbottitura: CGFloat = 12
    @ViewBuilder var contenuto: Contenuto

    var body: some View {
        contenuto
            .padding(imbottitura)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: raggio, style: .continuous)
                    .fill(LinearGradient(colors: [.white.opacity(0.045),
                                                  .white.opacity(0.030)],
                                         startPoint: .top, endPoint: .bottom))
            )
            .overlay(
                RoundedRectangle(cornerRadius: raggio, style: .continuous)
                    .strokeBorder(LinearGradient(colors: [.white.opacity(0.11),
                                                          .white.opacity(0.03)],
                                                 startPoint: .top, endPoint: .bottom),
                                  lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.22), radius: 1, y: 1)
    }
}

/// Il filo fra due righe. `Divider()` su macOS si porta dietro rientri e un
/// colore suoi, e in otto punti diversi non venivano mai uguali: un rettangolo
/// è prevedibile.
struct Filo: View {
    var body: some View {
        Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
    }
}

extension Color {
    /// **L'accento di Riflesso.** Non `Color.orange`: su macOS quello è
    /// `#FF9500`, l'arancione semaforo che il sistema usa per «attenzione», e
    /// non è una sfumatura diversa — è un altro colore. Il pannello ne aveva
    /// nove, e chi guardava il telefono e poi il Mac vedeva due prodotti.
    ///
    /// La divisione, adesso: `.brace` = il marchio e le cose che puoi toccare;
    /// `.yellow` = qualcosa richiede la tua attenzione; `.green` = a posto;
    /// `.red` = distruttivo. Prima l'arancio faceva tutti e quattro i mestieri.
    static let brace = Color(red: 217/255, green: 119/255, blue: 87/255)
}

// MARK: - Il pannello

struct MenuBarPanel: View {
    @ObservedObject var model: HostViewModel
    /// Primo tocco su «Scollega tutti»: armato per quattro secondi.
    @State private var scollegaArmato = false

    /// Quale riga della scheda di stato è aperta. Una sola alla volta: due
    /// dettagli aperti insieme fanno crescere il pannello per niente.
    @State private var aperta: Dettaglio?
    enum Dettaglio { case casa, ponte }

    /// Quattro blocchi al posto di otto, e uno solo è grande.
    ///
    /// Otto sezioni separate da otto righe grigie dicevano una cosa sola:
    /// «queste otto cose sono pari fra loro». Non lo sono. Il pannello serve, il
    /// 95% delle volte, a rispondere a tre domande — *è acceso? come ci entro
    /// col telefono? c'è un telefono attaccato?* — e tutto il resto è
    /// manutenzione, che serve il giorno in cui si rompe qualcosa.
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            // Il segreto della stanza sul ponte e' rinato con dei telefoni
            // gia' accoppiati (04/09/2026): quelli collegati dal ponte bussano
            // a una stanza vuota, e il Mac non scriveva niente. Qui lo si dice,
            // con la stessa forma di «Servizio spento»: non ripara, ma smette
            // di mentire.
            if model.meetReborn {
                meetRebornSection
            }
            // Da spento QR, codice e indirizzi sarebbero **istruzioni per una
            // porta chiusa**: non si mostrano. Al loro posto c'e' scritto in
            // chiaro cosa non funziona e come rimetterlo in piedi.
            if model.serviceOn {
                // Il QR porta sempre da qualche parte — al ponte o alla rete
                // di casa — e **sotto c'e' scritto dove**. Un QR verso una
                // porta chiusa sembra un'app rotta (01/09/2026): la riga sotto
                // il QR dice se vale solo in casa.
                schedaEroe
                rigaDispositivi
                schedaStrade
                schedaStato
            } else {
                spentoSection
            }
            schedaLingua
            fondo
        }
        // 30 in cima: sotto ci passa il semaforo di chiusura, che la finestra
        // disegna sopra il contenuto. Quella striscia è anche la presa per
        // spostare il pannello. È imbottitura nostra e non area sicura di
        // sistema: l'area sicura la ricalcolerebbe SwiftUI a ogni cambio di
        // altezza, e in una finestra che insegue il contenuto quel ricalcolo
        // fa morire l'app — vedi `creaPannello()` in `main.swift`.
        .padding(EdgeInsets(top: 30, leading: 14, bottom: 14, trailing: 14))
        .frame(width: 360)
        .background(fondale)
        .animation(.easeOut(duration: 0.18), value: model.serviceOn)
    }

    /// Il fondo del pannello, in tre strati — ed è **qui** che le due facce di
    /// Riflesso cominciano a somigliarsi.
    ///
    /// 1. il vetro, che lascia intravedere quello che c'è sotto;
    /// 2. il buio tiepido del telefono steso sopra: il vetro di macOS da solo è
    ///    un grigio neutro, e sopra un grigio neutro l'arancio di Claude
    ///    litiga. È lo stesso `#0d0c0c` del foglio di stile;
    /// 3. la stessa luce calda in alto che sulla webapp fa `body::before`.
    ///    Il buio ha una sorgente, non è una vernice.
    ///
    /// Da spento il vetro passa a `.hudWindow`, più spesso e più freddo: il
    /// pannello **si sente chiuso prima ancora di leggerlo**, e a dirlo non è
    /// più un colore d'allarme.
    private var fondale: some View {
        ZStack {
            Vetro(material: model.serviceOn ? .popover : .hudWindow)
            Color(red: 13/255, green: 12/255, blue: 12/255)
                .opacity(model.serviceOn ? 0.52 : 0.62)
            RadialGradient(colors: [Color.brace.opacity(0.11), .clear],
                           center: UnitPoint(x: 0.5, y: -0.28),
                           startRadius: 0, endRadius: 330)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: intestazione

    private var statoTesta: String {
        guard model.serviceOn else { return L.t("service_off_head") }
        guard model.liveClients > 0 else { return L.t("service_on_head") }
        return model.liveClients == 1
            ? L.t("devices_live_one")
            : L.t("devices_live_many", ["n": "\(model.liveClients)"])
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: model.serviceOn
                  ? "iphone.gen3.radiowaves.left.and.right" : "iphone.gen3.slash")
                .font(.system(size: 17))
                .foregroundStyle(model.serviceOn ? Color.primary : Color.brace)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text("Riflesso").font(.system(size: 14.5, weight: .semibold))
                HStack(spacing: 5) {
                    if model.serviceOn && model.liveClients > 0 {
                        Circle().fill(Color.green).frame(width: 6, height: 6)
                    }
                    // Il numero nudo con il pallino accanto — «● 0» — non
                    // diceva di cosa fosse il conto. Adesso lo dice a parole, e
                    // solo quando c'è qualcuno da contare.
                    Text(statoTesta)
                        .font(.system(size: 11.5))
                        .foregroundStyle(model.serviceOn ? Color.secondary : Color.brace)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            // **L'acceso/spento del servizio**, e l'unico interruttore a
            // grandezza piena di tutto il pannello: è l'unica cosa che spegne
            // Riflesso davvero.
            Toggle("", isOn: Binding(
                get: { model.serviceOn },
                set: { AppHub.shared.servizioAcceso = $0; model.refresh() }
            ))
            .labelsHidden().toggleStyle(.switch).tint(.brace)
            .help(L.t("service_toggle"))
        }
    }

    // MARK: la scheda eroe — come entra il telefono

    /// QR e codice sono **lo stesso oggetto**: il QR *contiene* il codice. Prima
    /// stavano in due sezioni divise da una riga grigia, come se fossero due
    /// strade diverse. Stanno nella stessa scheda, e non ce n'è un'altra grande
    /// quanto questa in tutto il pannello.
    private var schedaEroe: some View {
        Riquadro {
            VStack(alignment: .leading, spacing: 10) {
                Text(L.t("open_on_phone"))
                    .font(.system(size: 10.5, weight: .semibold))
                    .textCase(.uppercase)
                    .kerning(0.7)
                    .foregroundStyle(.secondary)

                HStack(alignment: .top, spacing: 12) {
                    if let qr = model.pairQR {
                        // La misura la decide il modello, non una costante: con
                        // un `frame` fisso il QR tornerebbe morbido ogni volta
                        // che cambia la lunghezza dell'indirizzo.
                        Image(nsImage: qr)
                            .interpolation(.none)
                            .resizable()
                            .frame(width: model.pairQRSide, height: model.pairQRSide)
                            .padding(6)
                            // Il bianco pieno intorno al QR non è decorazione:
                            // è la zona di quiete, e senza quella le fotocamere
                            // faticano.
                            .background(Color.white)
                            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        // La spaziatura fra le lettere aggiunge un vuoto anche
                        // **dopo** l'ultima cifra: senza quel −2,5 il blocco
                        // sborda a destra di quel vuoto.
                        Text(model.pin)
                            .font(.system(size: 25, weight: .semibold, design: .monospaced))
                            .kerning(2.5)
                            .monospacedDigit()
                            .padding(.trailing, -2.5)
                            .textSelection(.enabled)
                        Text(L.t("pin_stable"))
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundStyle(.secondary)
                        Button(L.t("new_code")) {
                            AuthStore.shared.rotatePIN()
                            model.refresh()
                        }
                        .controlSize(.small)
                        if !model.pinNote.isEmpty {
                            // Un codice rigenerato dopo troppi tentativi
                            // sbagliati è un **avviso**, e un avviso non è il
                            // marchio: giallo, non terracotta.
                            Text(model.pinNote)
                                .font(.system(size: 11))
                                .foregroundStyle(.yellow)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 4)
                        // La riga d'aiuto sta **accanto** al QR e non sotto:
                        // il QR è alto quanto tre righe di testo, e messa
                        // sotto lasciava un rettangolo vuoto grande come una
                        // sezione intera.
                        if model.pairQR != nil {
                            Text(L.t("scan_qr"))
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(minHeight: model.pairQR != nil ? model.pairQRSide + 12 : 0,
                           alignment: .top)
                    Spacer(minLength: 0)
                }

                Filo()

                // **Dove sta mandando.** Sotto il QR c'e' scritto quale delle
                // due strade contiene e l'indirizzo: e' la riga che manca
                // quando il telefono bussa e non entra, e la prima cosa da
                // leggere in quel momento. L'host sta su una riga sua, intero:
                // su una riga sola con «Copia il link» accanto finiva tagliato
                // proprio nel nome.
                rigaStradaQR
            }
        }
    }

    private var rigaStradaQR: some View {
        let (icona, colore, testo): (String, Color, String) = {
            switch model.strada {
            case .ponte: return ("globe", .green, L.t("qr_via_bridge"))
            case .casa: return ("wifi", .yellow, L.t("qr_via_home"))
            }
        }()
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: icona)
                    .font(.system(size: 10))
                    .foregroundStyle(colore)
                Text(testo)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.pairURL, forType: .string)
                    model.lastAction = L.t("copied_pair_link")
                } label: {
                    Text(L.t("copy_link")).font(.system(size: 11.5))
                }
                .buttonStyle(.borderless)
                .fixedSize()
            }
            Text(model.strada.host)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .padding(.leading, 20)
            // Solo casa: da fuori il telefono non arriva, e va detto qui,
            // non scoperto sul treno.
            if case .casa = model.strada {
                Text(L.t("qr_home_hint"))
                    .font(.system(size: 11))
                    .foregroundStyle(.yellow)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 20)
            }
        }
    }

    /// **Abbinati** e **collegati ora** sono due cose diverse, e il pannello le
    /// confondeva: diceva «4 dispositivi collegati» con zero telefoni accesi e
    /// un solo iPhone al mondo. Abbinato vuol dire che ha la chiave e puo'
    /// entrare; collegato vuol dire che e' aperto adesso.
    private var devicesLine: String {
        let abbinati = model.deviceCount == 1
            ? L.t("devices_one")
            : L.t("devices_many", ["n": "\(model.deviceCount)"])
        guard model.liveClients > 0 else { return abbinati }
        let ora = model.liveClients == 1
            ? L.t("devices_live_one")
            : L.t("devices_live_many", ["n": "\(model.liveClients)"])
        return abbinati + " · " + ora
    }

    /// Fuori dalla scheda, e fuori da qualunque riquadro: non è uno stato del
    /// telefono, è la conseguenza di quello che c'è scritto sopra.
    private var rigaDispositivi: some View {
        HStack {
            Text(devicesLine)
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            // **Due tocchi, e solo se c'e' qualcosa da scollegare.**
            //
            // Questo tasto butta via tutti gli abbinamenti: chi lo preme per
            // sbaglio deve rifare il QR da ogni telefono. Stava a due
            // centimetri dall'interruttore del servizio, partiva al primo
            // clic e non lasciava nemmeno una riga nel registro — e infatti e'
            // successo davvero, il 31/08/2026: un dito di troppo mentre si
            // spegneva e riaccendeva il servizio, e il telefono si e' trovato
            // fuori senza che nessuno capisse perche'.
            //
            // Niente finestrella di conferma: il primo tocco **arma** il tasto
            // per quattro secondi e scrive «Sicuro?», il secondo esegue. Se non
            // arriva, si disarma da solo. E quando i dispositivi sono zero il
            // tasto non c'e' proprio: non c'e' niente da scollegare.
            if model.deviceCount > 0 {
                Button(scollegaArmato ? L.t("sign_out_sure") : L.t("sign_out_all")) {
                    guard scollegaArmato else {
                        scollegaArmato = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            scollegaArmato = false
                        }
                        return
                    }
                    scollegaArmato = false
                    AuthStore.shared.revokeAll()
                    AppHub.shared.server.disconnectAll()
                    Log.warn("scollegati tutti i dispositivi dal pannello")
                    model.lastAction = L.t("signed_out_all")
                    model.refresh()
                }
                .buttonStyle(.borderless)
                .font(.system(size: 11.5).weight(scollegaArmato ? .semibold : .regular))
                .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 2)
    }

    // MARK: la scheda di stato — tace quando va tutto bene

    /// **Il pannello cresce dove c'è il problema.** L'idea è nata prima: a
    /// servizio spento il pannello dimezza e dice cosa non succede più. Qui è
    /// generalizzata — tutto a posto vuol dire tre righe basse; manca un
    /// permesso e *quella* riga, e nessun'altra, cresce e prende il pulsante.
    ///
    /// Il risultato è che **l'altezza del pannello diventa un indicatore di
    /// salute**: corto = a posto, cresciuto = guarda dove è cresciuto. Funziona
    /// perché la finestra insegue l'altezza del contenuto
    /// (`sizingOptions = [.preferredContentSize]`), che è lo stesso meccanismo
    /// su cui poggia già lo stato spento.
    private var schedaStato: some View {
        Riquadro(imbottitura: 0) {
            rigaPermessi
        }
    }

    // MARK: le due strade

    /// **Come arriva il telefono.** Due righe, una per strada, ognuna col suo
    /// stato: la rete di casa (c'e' sempre) e il ponte (in ascolto, o
    /// l'indirizzo da scrivere). Il QR usa il ponte se c'e', e sotto il QR c'e'
    /// scritto quale. Come il resto del pannello, **cresce dove c'e' il
    /// problema**: la riga del ponte si apre da sola quando l'indirizzo e'
    /// sbagliato o il ponte non risponde. Il 01/09 l'app ripiegava in silenzio
    /// e ci si e' persa una serata: mai piu'.
    private var schedaStrade: some View {
        Riquadro(imbottitura: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text(L.t("roads"))
                    .font(.system(size: 10.5, weight: .semibold))
                    .textCase(.uppercase)
                    .kerning(0.7)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 6)
                rigaCasa
                Filo()
                rigaPonte
            }
        }
    }

    /// La testa di una riga-strada: icona, nome, stato in breve, freccia.
    private func testaStrada(icona: String, colore: Color, titolo: String, stato: String,
                             mono: Bool = false, aperta: Bool,
                             tocca: @escaping () -> Void) -> some View {
        Button(action: tocca) {
            HStack(spacing: 8) {
                Image(systemName: icona)
                    .font(.system(size: 10))
                    .foregroundStyle(colore)
                    .frame(width: 12)
                Text(titolo).font(.system(size: 12.5))
                Text(stato)
                    .font(mono ? .system(size: 11, design: .monospaced) : .system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.secondary.opacity(0.75))
                    .rotationEffect(.degrees(aperta ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func senzaSchema(_ u: String) -> String {
        if let r = u.range(of: "://") { return String(u[r.upperBound...]) }
        return u
    }

    /// La rete di casa: c'e' sempre, non serve Internet, e vale solo li'.
    private var rigaCasa: some View {
        VStack(alignment: .leading, spacing: 6) {
            testaStrada(icona: "wifi", colore: .green, titolo: L.t("road_home"),
                        stato: senzaSchema(model.url), mono: true, aperta: aperta == .casa) {
                aperta = (aperta == .casa) ? nil : .casa
            }
            if aperta == .casa {
                Text(L.t("road_home_note"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.url)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                ForEach(model.lanURLs, id: \.self) { u in
                    Text(u)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(1)
                }
                Text(L.t("server", ["status": model.serverStatus]))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .animation(.easeOut(duration: 0.18), value: aperta)
    }

    /// Il ponte: lo stato in breve sulla riga, e dietro il dettaglio il campo
    /// per l'indirizzo. Non sta in prima pagina: si scrive una volta. Un
    /// indirizzo sbagliato o un ponte che non risponde aprono la riga da soli.
    private var rigaPonte: some View {
        let apertaQui = aperta == .ponte || model.remoteError
        let colore: Color = model.remoteError ? .yellow : (model.remoteConfigured ? .green : .secondary)
        let stato = model.remoteConfigured
            ? senzaSchema(model.remoteBase) + " · " + model.remoteState
            : model.remoteState
        return VStack(alignment: .leading, spacing: 6) {
            testaStrada(icona: model.remoteError ? "exclamationmark.triangle.fill" : "globe",
                        colore: colore, titolo: L.t("road_bridge"),
                        stato: stato, aperta: apertaQui) {
                aperta = (aperta == .ponte) ? nil : .ponte
            }
            if apertaQui {
                Text(L.t("rendezvous_note"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    TextField("https://", text: Binding(
                        get: { model.remoteBase },
                        set: { model.remoteBase = $0; model.editingRemoteBase = true }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))
                    .onSubmit { model.salvaPonte() }
                    Button(L.t("save")) { model.salvaPonte() }
                        .controlSize(.small)
                        .disabled(!model.editingRemoteBase)
                }
                if model.remoteError {
                    Text(model.remoteState)
                        .font(.system(size: 11))
                        .foregroundStyle(.yellow)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !model.remoteNote.isEmpty {
                    Text(model.remoteNote)
                        .font(.system(size: 11))
                        .foregroundStyle(.yellow)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .animation(.easeOut(duration: 0.18), value: aperta)
    }

    /// I permessi non si aprono a mano: **si aprono da soli quando manca
    /// qualcosa**. Concessi, sono una riga sola con una spunta.
    private var rigaPermessi: some View {
        let tuttiConcessi = model.accessibilityGranted
        return VStack(alignment: .leading, spacing: 8) {
            if tuttiConcessi {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.green)
                    Text(L.t("permissions_ok"))
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            } else {
                Text(L.t("permissions"))
                    .font(.system(size: 12.5))
                permissionRow(title: L.t("accessibility"),
                              granted: model.accessibilityGranted,
                              action: {
                                  InputInjector.shared.requestAccessibility()
                                  openSettings("Privacy_Accessibility")
                              })
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func permissionRow(title: String, granted: Bool, action: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(granted ? Color.green : Color.yellow)
            Text(title).font(.system(size: 11.5)).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            if !granted {
                Button(L.t("grant"), action: action)
                    .controlSize(.small)
            }
        }
    }

    // MARK: servizio spento

    /// Quello che si legge quando il servizio è spento. Deve dire **cosa non
    /// succede più**, non «disattivato». A renderlo inequivocabile adesso sono
    /// la **forma** — il pannello dimezza e resta un riquadro solo — e il
    /// **vetro**, che cambia grana. Non un colore d'allarme: non si è rotto
    /// niente, l'hai spento tu, apposta.
    private var spentoSection: some View {
        Riquadro {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 7) {
                    Image(systemName: "moon.zzz.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.brace)
                    Text(L.t("service_off_title"))
                        .font(.system(size: 12.5, weight: .semibold))
                }
                Text(L.t("service_off_body"))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L.t("service_off_kept"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .opacity(0.7)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: il segreto della stanza rinato

    /// Un avviso, non un allarme: giallo, con la forma di «Servizio spento».
    /// Dice cosa e' successo e cosa fare (rifare il QR dai telefoni collegati
    /// dal ponte), e si chiude a mano — o da solo, quando tutti i telefoni si
    /// sono riaccoppiati.
    private var meetRebornSection: some View {
        Riquadro {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 7) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.yellow)
                    Text(L.t("meet_reborn_title"))
                        .font(.system(size: 12.5, weight: .semibold))
                    Spacer(minLength: 4)
                    Button(L.t("meet_reborn_ok")) {
                        AuthStore.shared.dismissMeetSecretReborn()
                        model.refresh()
                    }
                    .controlSize(.small)
                }
                Text(L.t("meet_reborn_body"))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: lingua e fondo

    /// L'unica preferenza rimasta sulla prima pagina, e sta in una scheda come
    /// tutte le altre righe: righe dentro schede, mai righe sciolte. È la stessa
    /// grammatica dei pannelli del telefono.
    private var schedaLingua: some View {
        Riquadro(imbottitura: 0) {
            HStack {
                Text(L.t("language")).font(.system(size: 12.5))
                Spacer()
                Picker("", selection: Binding(
                    get: { model.lang },
                    set: { model.lang = $0; L.lang = $0; model.refresh() }
                )) {
                    Text("English").tag("en")
                    Text("Italiano").tag("it")
                }
                .pickerStyle(.segmented)
                .frame(width: 160)
                .controlSize(.small)
                // Se macOS lo ascolta, la lingua scelta è terracotta come gli
                // interruttori; se non lo ascolta resta il blu di sistema, che
                // è comunque il posto giusto per l'accento della piattaforma.
                .tint(.brace)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private var fondo: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                // Dopo aver concesso la Registrazione schermo macOS vuole che
                // l'app riparta: meglio un pulsante che una spiegazione.
                Button(L.t("restart")) { relaunch() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Spacer()
                // Rosso il testo, non il pulsante: un bottone rosso pieno in
                // fondo a un pannello dove non c'è nient'altro di rosso è la
                // cosa più appariscente della schermata, e uscire non è
                // l'azione principale di niente.
                Button(L.t("quit")) { NSApp.terminate(nil) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
            }
            .font(.system(size: 11.5))

            if !model.lastAction.isEmpty {
                Text(model.lastAction)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private func relaunch() {
        let url = Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        AppHub.shared.stop()
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func openSettings(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}
