import Foundation

/// Chi sta rispondendo, davvero.
///
/// Il giro scorso il codice era giusto ma `/Applications/Riflesso.app` era
/// rimasta la build vecchia, e la prova e' stata fatta su quella. Da qui in poi
/// `curl http://localhost:7654/health` dice **quale binario** e **quale webapp**
/// stanno servendo, con la data. Un controllo di dieci secondi che vale un giro
/// di lavoro.
enum Build {
    /// Si alza a mano a ogni giro di correzioni.
    static let version = "2.1"

    /// Il momento in cui e' stato costruito il binario in esecuzione.
    static let stamp: String = date(of: executablePath)

    static let executablePath: String =
        Bundle.main.executableURL?.path ?? CommandLine.arguments[0]

    /// La cartella della webapp servita adesso, con la data del suo `index.html`:
    /// serve a distinguere l'app installata da quella dello sviluppo.
    static var webapp: String {
        AppHub.webappDirectory.path
    }

    static var webappStamp: String {
        date(of: AppHub.webappDirectory.appendingPathComponent("index.html").path)
    }

    static var summary: String {
        "Riflesso \(version) · binario \(stamp) · webapp \(webappStamp)"
    }

    private static func date(of path: String) -> String {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let d = attrs[.modificationDate] as? Date else { return "?" }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.string(from: d)
    }
}
