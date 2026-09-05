import Foundation
import AVFoundation
import Speech

/// **La dettatura si trascrive sul Mac.** Il telefono registra e manda
/// l'audio con lo stesso tubo a pezzi degli allegati (`/api/upload`); qui lo
/// si legge e lo si trasforma in testo con `SpeechAnalyzer`, il motore di
/// macOS 26: tutto sul dispositivo, nessuna rete, nessun account. Misurato il
/// 04/09/2026 su questo Mac: 20,5 s di italiano in 0,35 s, coi nomi propri,
/// «api» e «15 €» scritti giusti.
///
/// Il testo **torna al telefono**, dove chi ha parlato lo rilegge e lo corregge
/// prima di mandarlo: l'audio non si allega mai a Claude.
///
/// Tre cose imparate provandolo:
/// · `AVAudioFile` non legge WebM/Opus (errore `ExtAudioFileOpenURL`
///   1954115647): il telefono deve registrare in `audio/mp4`, e se il file
///   non si apre lo si dice con un codice, non con un silenzio;
/// · il modello di una lingua puo' non essere installato: si avvia lo
///   scaricamento e si risponde «riprova fra un minuto», invece di tenere la
///   richiesta appesa per tutto il tempo dello scaricamento;
/// · il motore c'e' solo da macOS 26: prima si dice, e resta la dettatura
///   della tastiera del telefono, che scrive nello stesso riquadro.
enum Trascrizione {
    enum Esito {
        case testo(String)
        /// Un codice per il telefono (`n.transcribe_*` in i18n.js) e un
        /// dettaglio per il registro.
        case rifiuto(code: String, detail: String)
    }

    struct Rifiuto: Error {
        let code: String
        let detail: String
    }

    /// Trascrive il file e risponde su una coda di sfondo. Non blocca mai il
    /// chiamante: la coda del server deve restare libera per gli altri.
    static func trascrivi(url: URL, lingua: String, completion: @escaping (Esito) -> Void) {
        guard #available(macOS 26.0, *) else {
            completion(.rifiuto(code: "transcribe_unsupported_os", detail: ProcessInfo.processInfo.operatingSystemVersionString))
            return
        }
        Task.detached(priority: .userInitiated) {
            do {
                completion(.testo(try await Motore.trascrivi(url: url, lingua: lingua)))
            } catch let r as Rifiuto {
                completion(.rifiuto(code: r.code, detail: r.detail))
            } catch {
                completion(.rifiuto(code: "transcribe_failed", detail: error.localizedDescription))
            }
        }
    }

    @available(macOS 26.0, *)
    private enum Motore {
        /// Le lingue di cui si e' gia' chiesto lo scaricamento del modello.
        private static var scaricamentiInCorso = Set<String>()
        private static let lock = NSLock()

        /// Segna (o toglie) uno scaricamento in corso. Torna vero se **questa**
        /// chiamata l'ha aggiunto, cioe' se tocca a lei farlo partire. Sta in
        /// una funzione sincrona apposta: un lock preso dentro un `Task` e'
        /// un errore in Swift 6.
        private static func segna(_ key: String, inCorso: Bool) -> Bool {
            lock.lock(); defer { lock.unlock() }
            if inCorso { return scaricamentiInCorso.insert(key).inserted }
            scaricamentiInCorso.remove(key)
            return false
        }

        static func trascrivi(url: URL, lingua: String) async throws -> String {
            let voluta = Locale(identifier: lingua.isEmpty ? "it-IT" : lingua)
            guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: voluta) else {
                throw Rifiuto(code: "transcribe_no_language", detail: voluta.identifier)
            }

            // Il file, prima di ogni altra cosa: se non si legge, e' inutile
            // preparare il motore.
            let file: AVAudioFile
            do { file = try AVAudioFile(forReading: url) } catch {
                throw Rifiuto(code: "transcribe_bad_audio", detail: error.localizedDescription)
            }
            let durata = Double(file.length) / max(file.processingFormat.sampleRate, 1)

            let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                                reportingOptions: [], attributeOptions: [])

            // Il modello della lingua: se manca si scarica **in sottofondo** e
            // si risponde subito, invece di far aspettare il telefono per uno
            // scaricamento di cui non si sa la durata.
            let installate = await SpeechTranscriber.installedLocales
            if !installate.contains(where: { $0.identifier == locale.identifier }) {
                if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    let key = locale.identifier
                    if segna(key, inCorso: true) {
                        Log.info("dettatura: scarico il modello per", key)
                        Task.detached {
                            do { try await req.downloadAndInstall(); Log.info("dettatura: modello installato per", key) }
                            catch { Log.warn("dettatura: modello non installato per", key, "·", error.localizedDescription) }
                            _ = segna(key, inCorso: false)
                        }
                    }
                    throw Rifiuto(code: "transcribe_installing", detail: key)
                }
            }

            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let raccolta = Task { () -> String in
                var pezzi: [String] = []
                for try await r in transcriber.results {
                    let s = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !s.isEmpty { pezzi.append(s) }
                }
                return pezzi.joined(separator: " ")
            }
            let t0 = Date()
            if let ultimo = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: ultimo)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            let testo = try await raccolta.value
            Log.info(String(format: "dettatura: %.1f s di audio (%@) in %d ms · %d caratteri",
                            durata, locale.identifier, Int(Date().timeIntervalSince(t0) * 1000), testo.count))
            return testo
        }
    }
}
