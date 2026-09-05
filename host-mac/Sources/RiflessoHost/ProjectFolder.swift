import Foundation

/// La cartella da cui far ripartire il CLI per riprendere una conversazione.
///
/// **La fonte di verita' e' la cartella-progetto in cui il CLI tiene il
/// transcript**, cioe' `~/.claude/projects/<slug>/<id>.jsonl`. Non la `cwd`
/// scritta dentro il transcript: durante una sessione un `cd` sposta la
/// cartella di lavoro, il CLI la scrive nei record successivi, e sbirciando in
/// fondo si finisce per leggere quella. Ripresa da li', `claude --resume`
/// risponde *«No conversation found»* — la ricerca e' limitata alla cartella
/// che corrisponde alla `cwd` con cui si lancia il comando.
///
/// Lo slug non si prova a indovinare: si **verifica**. Codificare un percorso
/// e' esatto e senza ambiguita', decodificarlo no (`Miei-Progetti` e `Miei/Progetti`
/// danno lo stesso slug), quindi si codificano i candidati e si tiene quello
/// che coincide con la cartella vera.
enum ProjectFolder {

    /// Come Claude Code trasforma un percorso nel nome della sua cartella:
    /// ogni carattere che non sia lettera o cifra diventa un trattino.
    /// Verificato su tutte le cartelle presenti in `~/.claude/projects`.
    static func slug(for path: String) -> String {
        String(path.map { c in
            (c.isASCII && (c.isLetter || c.isNumber)) ? c : "-"
        })
    }

    /// Il percorso che ha prodotto questo slug, cercato **sul disco**.
    ///
    /// Serve solo quando nessun candidato coincide: una conversazione nata dal
    /// Terminale non compare fra le sessioni del Desktop, e l'unica traccia
    /// della sua cartella e' il nome dello slug. Si scende un pezzo alla volta
    /// provando quante «parole» consumare, perche' un trattino nello slug puo'
    /// essere tanto un separatore quanto un trattino vero.
    static func decode(slug: String) -> String? {
        guard slug.hasPrefix("-") else { return nil }
        let tokens = slug.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        // Il primo elemento e' vuoto: e' la radice.
        guard tokens.count > 1 else { return nil }
        var budget = 4000
        return walk(tokens: Array(tokens.dropFirst()), base: "", budget: &budget)
    }

    private static func walk(tokens: [String], base: String, budget: inout Int) -> String? {
        guard budget > 0 else { return nil }
        if tokens.isEmpty { return base }
        let fm = FileManager.default
        // Prima il pezzo piu' corto: nella stragrande maggioranza dei casi il
        // trattino e' un separatore, e cosi' si scende dritti.
        for take in 1...tokens.count {
            budget -= 1
            guard budget > 0 else { return nil }
            let component = tokens[0..<take].joined(separator: "-")
            guard !component.isEmpty else { continue }
            let candidate = base + "/" + component
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: candidate, isDirectory: &isDir), isDir.boolValue else { continue }
            if take == tokens.count { return candidate }
            if let done = walk(tokens: Array(tokens[take...]), base: candidate, budget: &budget) {
                return done
            }
        }
        return nil
    }

    /// La cartella con cui riprendere `cliId`, scelta fra i candidati.
    ///
    /// - `folder`: la cartella-progetto del transcript (fonte di verita').
    /// - `candidates`: in ordine di fiducia — `cwd` e `originCwd` dell'indice
    ///   del Desktop, e solo in coda la `cwd` sbirciata dal transcript, che
    ///   **non deve vincere**.
    static func resolve(transcript: URL?, candidates: [String]) -> String? {
        let fm = FileManager.default
        let clean = candidates.filter { !$0.isEmpty }

        if let transcript {
            let folder = transcript.deletingLastPathComponent().lastPathComponent
            // 1. Il candidato che, codificato, da' esattamente questa cartella.
            for c in clean where slug(for: c) == folder {
                if fm.fileExists(atPath: c) { return c }
            }
            // 2. Nessuno coincide: si legge la cartella vera dal disco.
            if let decoded = decode(slug: folder) { return decoded }
        }

        // 3. Ultima spiaggia: il primo candidato che almeno esiste.
        return clean.first { fm.fileExists(atPath: $0) }
    }

    /// La cartella da cui riprendere questa conversazione, e da dove arriva la
    /// decisione. Un solo posto: la usano sia l'invio sia il collaudo.
    static func folder(cliId: String) -> (path: String, why: String)? {
        let entry = SessionsIndex.shared.entry(cliSessionId: cliId)
        let info = TranscriptIndex.shared.info(for: cliId)

        var candidates: [String] = []
        if let entry {
            candidates.append(entry.cwd)
            if entry.originCwd != entry.cwd { candidates.append(entry.originCwd) }
        }
        // La `cwd` sbirciata nel transcript resta l'ultima spiaggia: serve solo
        // alle conversazioni nate dal Terminale, che nell'indice non ci sono.
        // Costa una lettura, quindi si sbircia solo se l'indice non basta.
        let slugOfFile = info?.url.deletingLastPathComponent().lastPathComponent
        var peeked = false
        if let info, let slugOfFile,
           !candidates.contains(where: { slug(for: $0) == slugOfFile }) {
            let peek = TranscriptReader.window(url: info.url, wantItems: 1, maxScan: 256 * 1024)
            if let c = peek.cwd, !c.isEmpty { candidates.append(c); peeked = true }
        }

        guard let path = resolve(transcript: info?.url, candidates: candidates) else { return nil }
        let why: String
        if let slugOfFile, slug(for: path) == slugOfFile {
            why = peeked ? "cartella-progetto (dal transcript)" : "cartella-progetto"
        } else {
            why = "ripiego: nessun candidato combacia con la cartella-progetto"
        }
        return (path, why)
    }
}
