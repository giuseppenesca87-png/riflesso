import Foundation
import Compression

struct HTTPRequest {
    var method: String
    var path: String
    var query: [String: String]
    var headers: [String: String]   // chiavi minuscole
    var body: Data

    func header(_ name: String) -> String? { headers[name.lowercased()] }

    /// Token accettato sia in query (`?token=`) sia in header Authorization.
    var bearerToken: String? {
        if let q = query["token"], !q.isEmpty { return q }
        if let a = header("authorization"), a.lowercased().hasPrefix("bearer ") {
            return String(a.dropFirst(7))
        }
        return nil
    }

    /// Il browser accetta una risposta compressa in gzip?
    var acceptsGzip: Bool {
        guard let a = header("accept-encoding")?.lowercased() else { return false }
        return a.split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces).hasPrefix("gzip") }
    }

    /// Le impronte che il browser ha gia': `If-None-Match: W/"a", "b"`.
    var ifNoneMatch: [String] {
        guard let v = header("if-none-match") else { return [] }
        return v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

enum HTTPParser {
    /// Estrae una richiesta completa dal buffer. nil = servono altri byte.
    static func parse(_ buffer: inout Data) throws -> HTTPRequest? {
        guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            if buffer.count > 64 * 1024 { throw ParseError.headerTooLarge }
            return nil
        }
        let headData = buffer[buffer.startIndex..<headEnd.lowerBound]
        guard let head = String(data: headData, encoding: .utf8) else { throw ParseError.badEncoding }

        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { throw ParseError.malformed }
        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count >= 2 else { throw ParseError.malformed }

        let method = String(requestLine[0])
        let rawTarget = String(requestLine[1])
        var path = rawTarget
        var query: [String: String] = [:]
        if let qIdx = rawTarget.firstIndex(of: "?") {
            path = String(rawTarget[rawTarget.startIndex..<qIdx])
            let qs = String(rawTarget[rawTarget.index(after: qIdx)...])
            for pair in qs.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                let k = String(kv[0]).removingPercentEncoding ?? String(kv[0])
                let v = kv.count > 1 ? (String(kv[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "") : ""
                query[k] = v
            }
        }
        path = path.removingPercentEncoding ?? path

        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let k = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[k] = v
        }

        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        guard contentLength <= 1024 * 1024 else { throw ParseError.bodyTooLarge }

        let bodyStart = headEnd.upperBound
        let available = buffer.distance(from: bodyStart, to: buffer.endIndex)
        guard available >= contentLength else { return nil }

        let body = Data(buffer[bodyStart..<buffer.index(bodyStart, offsetBy: contentLength)])
        buffer.removeSubrange(buffer.startIndex..<buffer.index(bodyStart, offsetBy: contentLength))

        return HTTPRequest(method: method, path: path, query: query, headers: headers, body: body)
    }

    enum ParseError: Error {
        case malformed, badEncoding, headerTooLarge, bodyTooLarge
    }
}

struct HTTPResponse {
    var status: Int = 200
    var reason: String = "OK"
    var headers: [String: String] = [:]
    var body: Data = Data()

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return HTTPResponse(status: status,
                            reason: status == 200 ? "OK" : "Error",
                            headers: ["Content-Type": "application/json; charset=utf-8"],
                            body: data)
    }

    static func text(_ s: String, status: Int = 200, contentType: String = "text/plain; charset=utf-8") -> HTTPResponse {
        HTTPResponse(status: status,
                     reason: status == 200 ? "OK" : "Error",
                     headers: ["Content-Type": contentType],
                     body: Data(s.utf8))
    }

    /// Un file della webapp. `no-cache` non vuol dire «non tenere»: vuol dire
    /// «chiedi prima di riusare». Perche' la domanda abbia una risposta serve
    /// un'impronta (`ETag`): senza, il browser riscaricava tutto a ogni
    /// apertura — 208 KB, undici richieste, zero 304 (misurato il 04/09/2026).
    /// Con l'impronta la riapertura si chiude in una manciata di 304.
    static func file(_ data: Data, contentType: String, etag: String? = nil) -> HTTPResponse {
        var h = ["Content-Type": contentType, "Cache-Control": "no-cache"]
        if let etag { h["ETag"] = etag }
        return HTTPResponse(status: 200, reason: "OK", headers: h, body: data)
    }

    /// «Ce l'hai gia' buono»: la risposta a un `If-None-Match` che combacia.
    static func notModified(etag: String) -> HTTPResponse {
        HTTPResponse(status: 304, reason: "Not Modified",
                     headers: ["ETag": etag, "Cache-Control": "no-cache"], body: Data())
    }

    /// L'impronta di un file da misura e data di modifica. **Debole** (`W/`),
    /// perche' la stessa risorsa viaggia compressa o no a seconda di chi la
    /// chiede: un'impronta forte dovrebbe cambiare con la codifica.
    static func etag(size: UInt64, modified: Date) -> String {
        "W/\"\(size)-\(Int(modified.timeIntervalSince1970))\""
    }

    /// Cosa vale la pena comprimere: testo, JSON, script, fogli di stile, SVG.
    /// Le PNG sono gia' compresse e crescerebbero.
    static func isCompressible(contentType: String) -> Bool {
        let t = contentType.lowercased()
        return t.hasPrefix("text/") || t.hasPrefix("application/json")
            || t.hasPrefix("application/javascript") || t.hasPrefix("text/javascript")
            || t.hasPrefix("application/manifest+json") || t.hasPrefix("image/svg+xml")
    }

    /// La risposta come va sul filo **per questa richiesta**: compressa in gzip
    /// se il browser lo accetta, se il tipo lo merita e se c'e' abbastanza da
    /// comprimere. Sotto il chilobyte l'intestazione di gzip costa quanto il
    /// guadagno. Se e' gia' compressa (i file statici, che si comprimono una
    /// volta e si tengono) non si tocca.
    func encoded(for request: HTTPRequest) -> HTTPResponse {
        guard status == 200, headers["Content-Encoding"] == nil, body.count >= 1024,
              request.acceptsGzip,
              HTTPResponse.isCompressible(contentType: headers["Content-Type"] ?? ""),
              let gz = Gzip.compress(body) else { return self }
        var r = self
        r.body = gz
        r.headers["Content-Encoding"] = "gzip"
        r.headers["Vary"] = "Accept-Encoding"
        return r
    }

    func serialized() -> Data {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        var h = headers
        h["Content-Length"] = String(body.count)
        h["Connection"] = h["Connection"] ?? "keep-alive"
        // La webapp gira solo in LAN e non deve finire in una iframe altrui.
        h["X-Content-Type-Options"] = "nosniff"
        h["Referrer-Policy"] = "no-referrer"
        for (k, v) in h { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(body)
        return out
    }
}

/// gzip, col framework Compression di Apple. Nessuna libreria in piu'.
///
/// `COMPRESSION_ZLIB` produce il flusso DEFLATE nudo (RFC 1951): per farne un
/// gzip (RFC 1952) che il browser accetti come `Content-Encoding: gzip` si
/// aggiungono i dieci byte di testa e gli otto di coda — il CRC-32 del testo in
/// chiaro e la sua lunghezza. Il CRC e' quello standard, a tabella.
enum Gzip {
    static func compress(_ src: Data) -> Data? {
        guard !src.isEmpty else { return nil }
        // Un testo che non si comprime puo' crescere di qualche byte: si
        // lascia margine, e se non basta si manda in chiaro.
        let capacity = src.count + src.count / 8 + 256
        var dst = [UInt8](repeating: 0, count: capacity)
        let n = src.withUnsafeBytes { raw -> Int in
            guard let p = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return compression_encode_buffer(&dst, capacity, p, src.count, nil, COMPRESSION_ZLIB)
        }
        guard n > 0, n < src.count else { return nil }

        var out = Data(capacity: n + 18)
        out.append(contentsOf: [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03])
        out.append(contentsOf: dst[0..<n])
        var crc = crc32(src).littleEndian
        withUnsafeBytes(of: &crc) { out.append(contentsOf: $0) }
        var size = UInt32(truncatingIfNeeded: src.count).littleEndian
        withUnsafeBytes(of: &size) { out.append(contentsOf: $0) }
        return out
    }

    private static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { raw in
            for b in raw { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        }
        return c ^ 0xFFFF_FFFF
    }
}

enum MIME {
    static func forPath(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}
