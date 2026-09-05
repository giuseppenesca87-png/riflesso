import Foundation

/// Testi del pannello Mac. Stessa regola della webapp: inglese di default,
/// italiano se il sistema è in italiano al primo avvio, scelta ricordata.
enum L {
    static let storeKey = "riflesso.lang"

    static var lang: String {
        get { resolved() }
        set {
            let v = newValue == "it" ? "it" : "en"
            UserDefaults.standard.set(v, forKey: storeKey)
        }
    }

    static func resolved() -> String {
        if let s = UserDefaults.standard.string(forKey: storeKey), s == "en" || s == "it" {
            return s
        }
        let code: String
        if #available(macOS 13, *) {
            code = Locale.current.language.languageCode?.identifier ?? "en"
        } else {
            code = Locale.current.languageCode ?? "en"
        }
        let v = code == "it" ? "it" : "en"
        UserDefaults.standard.set(v, forKey: storeKey)
        return v
    }

    static func t(_ key: String, _ vars: [String: String] = [:]) -> String {
        var s = table[lang]?[key] ?? table["en"]?[key] ?? key
        for (k, v) in vars {
            s = s.replacingOccurrences(of: "{\(k)}", with: v)
        }
        return s
    }

    static func remote(code: String, n: Int, detail: String) -> String {
        switch code {
        case "connected_n": return t("remote.connected_n", ["n": "\(n)"])
        case "listening_error": return t("remote.listening_error", ["detail": detail])
        default: return t("remote.\(code)")
        }
    }

    static func server(code: String, port: UInt16, detail: String) -> String {
        switch code {
        case "listening": return t("server.listening", ["port": "\(port)"])
        case "port_busy": return t("server.port_busy", ["port": "\(port)", "detail": detail])
        case "error": return t("server.error", ["detail": detail])
        default: return t("server.stopped")
        }
    }

    private static let table: [String: [String: String]] = [
        "en": [
            "open_on_phone": "Open on your phone",
            "scan_qr": "Scan it with the camera: it opens already filled in.",
            "copy_link": "Copy the link",
            "copied_link": "address copied",
            "copied_pair_link": "address with the code copied",
            "pin_stable": "stays valid until you change it",
            "new_code": "New code",
            "devices_one": "1 paired device",
            "devices_many": "{n} paired devices",
            "service_toggle": "Turn the service on or off",
            "service_on_head": "on — no phone connected",
            "service_off_head": "off — your phone cannot reach the Mac",
            "service_off_title": "Service off",
            "service_off_body": "Nothing is being served: the page does not open, the bridge is closed and no phone can connect, at home or away. Turn it back on with the switch above.",
            "service_off_kept": "It stays off until you turn it back on, even after restarting.",
            // What the QR points to. Two roads, and the line under the QR
            // says which one: never a silent fallback.
            "qr_via_bridge": "works from any network · bridge",
            "qr_via_home": "works only at home, on this network",
            "qr_home_hint": "Away from home the phone cannot reach the Mac: set a bridge below.",
            // The roads card.
            "roads": "How the phone gets here",
            "road_home": "Home network",
            "road_home_note": "Only on this network, and it needs no Internet: it is the page the Mac serves on port 7654.",
            "road_bridge": "Bridge",
            "rendezvous_note": "The address of your bridge (the bridge/ folder, on a server of yours). Empty: this Mac calls nobody outside, and away from home the phone cannot reach it.",
            "save": "Save",
            "bridge_saved": "bridge address saved",
            "bridge_cleared": "bridge removed: this Mac calls nobody outside",
            // The room secret was regenerated with phones already paired: the
            // ones connecting through the bridge knock on a room nobody hears.
            "meet_reborn_title": "Bridge room regenerated",
            "meet_reborn_body": "The Mac's room secret was missing and has been created anew, but some phones were paired before that. Phones connecting through the bridge cannot find the Mac until they scan the QR again. At home nothing changes.",
            "meet_reborn_ok": "Got it",
            "devices_live_one": "1 connected now",
            "devices_live_many": "{n} connected now",
            "sign_out_all": "Sign out all devices",
            "sign_out_sure": "Sure? Tap again",
            "signed_out_all": "all devices signed out",
            "server": "Server: {status}",
            "permissions": "System permissions",
            "permissions_ok": "Accessibility granted — the only permission needed",
            "accessibility": "Accessibility",
            "grant": "Grant",
            "restart": "Restart",
            "quit": "Quit",
            "language": "Language",
            "remote.off": "off",
            "remote.missing_url": "not set",
            "remote.bad_url": "the address must start with https://",
            "remote.connected": "connected",
            "remote.connected_n": "{n} phones connected",
            "remote.listening_error": "listening · {detail}",
            "remote.waiting_first": "waiting for the first phone",
            "remote.listening": "listening",
            "remote.no_shared_memory": "the bridge has no shared memory: meeting from different networks may fail",
            "server.listening": "listening on port {port}",
            "server.stopped": "stopped",
            "server.port_busy": "port {port} in use: {detail}",
            "server.error": "error: {detail}",
            "pin.burned_guesses": "code regenerated after too many wrong tries",
            "pin.burned_probes": "code regenerated: someone was knocking on the pairing room",
        ],
        "it": [
            "open_on_phone": "Apri sul telefono",
            "scan_qr": "Inquadralo con la fotocamera: si apre già compilato.",
            "copy_link": "Copia il link",
            "copied_link": "indirizzo copiato",
            "copied_pair_link": "indirizzo con il codice copiato",
            "pin_stable": "resta valido finché non lo cambi",
            "new_code": "Nuovo codice",
            "devices_one": "1 dispositivo abbinato",
            "devices_many": "{n} dispositivi abbinati",
            "service_toggle": "Accendi o spegni il servizio",
            "service_on_head": "acceso — nessun telefono collegato",
            "service_off_head": "spento — il telefono non raggiunge il Mac",
            "service_off_title": "Servizio spento",
            "service_off_body": "Il Mac non sta servendo niente: la pagina non si apre, il ponte è chiuso e nessun telefono può collegarsi, né in casa né da fuori. Riaccendilo con l'interruttore qui sopra.",
            "service_off_kept": "Resta spento finché non lo riaccendi, anche dopo un riavvio.",
            "qr_via_bridge": "vale da qualunque rete · ponte",
            "qr_via_home": "vale solo in casa, su questa rete",
            "qr_home_hint": "Fuori casa il telefono non arriva al Mac: scrivi qui sotto l'indirizzo di un ponte.",
            "roads": "Come arriva il telefono",
            "road_home": "Rete di casa",
            "road_home_note": "Solo su questa rete, e non serve Internet: è la pagina che il Mac serve sulla porta 7654.",
            "road_bridge": "Ponte",
            "rendezvous_note": "L'indirizzo del tuo ponte (la cartella bridge/, su una macchina tua). Vuoto: il Mac non chiama nessuno fuori, e da fuori casa il telefono non arriva.",
            "save": "Salva",
            "bridge_saved": "indirizzo del ponte salvato",
            "bridge_cleared": "ponte tolto: il Mac non chiama nessuno fuori",
            "meet_reborn_title": "Stanza del ponte rigenerata",
            "meet_reborn_body": "Il segreto della stanza del Mac mancava ed è stato creato di nuovo, ma alcuni telefoni erano stati accoppiati prima. I telefoni collegati dal ponte non trovano il Mac finché non inquadrano di nuovo il QR. In casa non cambia niente.",
            "meet_reborn_ok": "Ho capito",
            "devices_live_one": "1 collegato ora",
            "devices_live_many": "{n} collegati ora",
            "sign_out_all": "Scollega tutti",
            "sign_out_sure": "Sicuro? Ripremi",
            "signed_out_all": "tutti i dispositivi scollegati",
            "server": "Server: {status}",
            "permissions": "Permessi di sistema",
            "permissions_ok": "Accessibilità concessa — è l'unico permesso che serve",
            "accessibility": "Accessibilità",
            "grant": "Concedi",
            "restart": "Riavvia",
            "quit": "Esci",
            "language": "Lingua",
            "remote.off": "spento",
            "remote.missing_url": "non impostato",
            "remote.bad_url": "l'indirizzo deve iniziare per https://",
            "remote.connected": "collegato",
            "remote.connected_n": "collegati {n} telefoni",
            "remote.listening_error": "in ascolto · {detail}",
            "remote.waiting_first": "in attesa del primo telefono",
            "remote.listening": "in ascolto",
            "remote.no_shared_memory": "il ponte non ha memoria condivisa: da reti diverse l'incontro può non riuscire",
            "server.listening": "in ascolto sulla porta {port}",
            "server.stopped": "fermo",
            "server.port_busy": "porta {port} occupata: {detail}",
            "server.error": "errore: {detail}",
            "pin.burned_guesses": "codice rigenerato dopo troppi tentativi sbagliati",
            "pin.burned_probes": "codice rigenerato: qualcuno bussava alla stanza dell'appuntamento",
        ],
    ]
}
