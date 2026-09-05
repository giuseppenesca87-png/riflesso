import Foundation
import CryptoKit

/// Implementazione minima di RFC 6455 lato server: handshake + framing.
/// Scritta a mano per non introdurre dipendenze esterne nell'host.
enum WSOpcode: UInt8 {
    case continuation = 0x0
    case text = 0x1
    case binary = 0x2
    case close = 0x8
    case ping = 0x9
    case pong = 0xA
}

struct WSFrame {
    var opcode: WSOpcode
    var payload: Data
}

enum WebSocketCodec {
    static let magicGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    /// Valore dell'header Sec-WebSocket-Accept per la chiave del client.
    static func acceptKey(for clientKey: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data((clientKey + magicGUID).utf8))
        return Data(digest).base64EncodedString()
    }

    /// Serializza un frame non mascherato (server -> client).
    static func encode(opcode: WSOpcode, payload: Data) -> Data {
        var out = Data()
        out.append(0x80 | opcode.rawValue) // FIN + opcode
        let n = payload.count
        if n < 126 {
            out.append(UInt8(n))
        } else if n <= 0xFFFF {
            out.append(126)
            out.append(UInt8((n >> 8) & 0xFF))
            out.append(UInt8(n & 0xFF))
        } else {
            out.append(127)
            var len = UInt64(n).bigEndian
            withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        }
        out.append(payload)
        return out
    }

    /// Prova a estrarre un frame completo dall'inizio del buffer.
    /// Ritorna nil se servono altri byte. Consuma i byte usati.
    static func decode(from buffer: inout Data) throws -> WSFrame? {
        guard buffer.count >= 2 else { return nil }
        let bytes = [UInt8](buffer)
        let fin = (bytes[0] & 0x80) != 0
        let rawOp = bytes[0] & 0x0F
        let masked = (bytes[1] & 0x80) != 0
        var len = Int(bytes[1] & 0x7F)
        var idx = 2

        if len == 126 {
            guard bytes.count >= idx + 2 else { return nil }
            len = Int(bytes[idx]) << 8 | Int(bytes[idx + 1])
            idx += 2
        } else if len == 127 {
            guard bytes.count >= idx + 8 else { return nil }
            var v = 0
            for i in 0..<8 { v = (v << 8) | Int(bytes[idx + i]) }
            len = v
            idx += 8
        }

        // Un client puo' solo inviare frame mascherati; e limitiamo la dimensione
        // per non farci allocare memoria arbitraria da chi si collega.
        guard masked else { throw WSError.unmaskedClientFrame }
        guard len <= 4 * 1024 * 1024 else { throw WSError.frameTooLarge }

        guard bytes.count >= idx + 4 else { return nil }
        let mask = Array(bytes[idx..<(idx + 4)])
        idx += 4

        guard bytes.count >= idx + len else { return nil }
        var payload = Data(count: len)
        payload.withUnsafeMutableBytes { dst in
            let d = dst.bindMemory(to: UInt8.self)
            for i in 0..<len { d[i] = bytes[idx + i] ^ mask[i % 4] }
        }
        idx += len

        buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + idx))

        guard let op = WSOpcode(rawValue: rawOp) else { throw WSError.badOpcode }
        // I frammenti non servono a questo protocollo: il client manda solo JSON corti.
        guard fin else { throw WSError.fragmentationUnsupported }
        return WSFrame(opcode: op, payload: payload)
    }

    enum WSError: Error {
        case unmaskedClientFrame
        case frameTooLarge
        case badOpcode
        case fragmentationUnsupported
    }
}
