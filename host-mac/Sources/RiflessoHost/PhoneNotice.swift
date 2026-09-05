import Foundation

/// Avviso per il telefono: un **codice** e i dati, non una frase.
/// La frase la compone la webapp nella lingua scelta, così un cambio
/// lingua vale subito e il Mac non decide la lingua di chi legge.
struct PhoneNotice {
    let code: String
    var data: [String: Any]

    init(_ code: String, _ data: [String: Any] = [:]) {
        self.code = code
        self.data = data
    }

    func asDict(t: String, chat: String? = nil, extra: [String: Any] = [:]) -> [String: Any] {
        var d: [String: Any] = ["t": t, "code": code]
        if let chat { d["chat"] = chat }
        for (k, v) in data { d[k] = v }
        for (k, v) in extra { d[k] = v }
        return d
    }
}
