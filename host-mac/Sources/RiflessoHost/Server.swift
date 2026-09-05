import Foundation
import Network

protocol ServerDelegate: AnyObject {
    /// `nil` vuol dire «rispondo io, piu' tardi»: il delegato ha preso in
    /// carico la richiesta e la chiudera' con `Server.reply`. Serve a chi ha
    /// un lavoro lungo davanti (la trascrizione) e non deve tenere ferma la
    /// coda del server, dove passano anche le diretta di tutti gli altri.
    func handleHTTP(_ request: HTTPRequest, from client: ClientConnection) -> HTTPResponse?
    func clientDidOpenWebSocket(_ client: ClientConnection)
    func clientDidCloseWebSocket(_ client: ClientConnection)
    func handleWebSocketText(_ text: String, from client: ClientConnection)
}

/// Una connessione TCP: prima HTTP, poi eventualmente WebSocket.
final class ClientConnection {
    let connection: NWConnection
    let queue: DispatchQueue
    let id = UUID()
    let remoteDescription: String

    var buffer = Data()
    var isWebSocket = false
    var token: String?
    var label: String = "Dispositivo"

    private var onClose: (() -> Void)?

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
        self.remoteDescription = Server.describe(endpoint: connection.endpoint)
    }

    func setCloseHandler(_ handler: @escaping () -> Void) { onClose = handler }

    func sendRaw(_ data: Data, completion: (() -> Void)? = nil) {
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if let error {
                Log.warn("invio fallito:", error.localizedDescription)
                self?.close()
            }
            completion?()
        })
    }

    func sendWSText(_ text: String) {
        guard isWebSocket else { return }
        sendRaw(WebSocketCodec.encode(opcode: .text, payload: Data(text.utf8)))
    }

    func sendWSJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let s = String(data: data, encoding: .utf8) else { return }
        sendWSText(s)
    }


    func close() {
        connection.cancel()
        onClose?()
        onClose = nil
    }
}

final class Server {
    let port: UInt16
    weak var delegate: ServerDelegate?

    private var listener: NWListener?
    let queue = DispatchQueue(label: "riflesso.server")

    // L'elenco dei client è protetto da un lock e non dalla coda del server:
    // ci si accede anche DA DENTRO la coda del server (mentre si gestisce una
    // richiesta) e un `queue.sync` su sé stessa manda il processo in trappola.
    private let clientsLock = NSLock()
    private var clients: [UUID: ClientConnection] = [:]

    private func withClients<T>(_ body: (inout [UUID: ClientConnection]) -> T) -> T {
        clientsLock.lock()
        defer { clientsLock.unlock() }
        return body(&clients)
    }

    private(set) var isListening = false
    var onStateChange: ((String, String) -> Void)?

    init(port: UInt16 = 7654) {
        self.port = port
    }

    var webSocketClients: [ClientConnection] {
        withClients { $0.values.filter { $0.isWebSocket } }
    }

    var connectedDeviceCount: Int {
        withClients { Set($0.values.filter { $0.isWebSocket }.compactMap { $0.token }).count }
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.includePeerToPeer = false
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true                   // i frame devono partire subito
            tcp.connectionTimeout = 10
            tcp.enableKeepalive = true
            tcp.keepaliveIdle = 20
        }

        let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.isListening = true
                self?.onStateChange?("listening", "")
                Log.info("server pronto sulla porta \(self?.port ?? 0)")
            case .failed(let e):
                self?.isListening = false
                self?.onStateChange?("error", e.localizedDescription)
                Log.error("listener fallito:", e.localizedDescription)
            case .cancelled:
                self?.isListening = false
                self?.onStateChange?("stopped", "")
            default: break
            }
        }
        l.start(queue: queue)
        listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
        let all = withClients { c -> [ClientConnection] in
            let list = Array(c.values)
            c.removeAll()
            return list
        }
        for c in all { c.connection.cancel() }
    }

    func disconnectAll() {
        let list = withClients { Array($0.values) }
        for c in list {
            if c.isWebSocket {
                c.sendRaw(WebSocketCodec.encode(opcode: .close, payload: Data([0x03, 0xE8])))
            }
            c.close()
        }
    }

    /// Chiude solo le sessioni di un token revocato.
    func disconnect(token: String) {
        let list = withClients { $0.values.filter { $0.token == token } }
        for c in list { c.close() }
    }

    // MARK: - Accettazione

    private func accept(_ conn: NWConnection) {
        guard Server.isLocalPeer(conn.endpoint) else {
            Log.warn("connessione rifiutata da fuori LAN:", Server.describe(endpoint: conn.endpoint))
            conn.cancel()
            return
        }
        let client = ClientConnection(connection: conn, queue: queue)
        withClients { $0[client.id] = client }
        client.setCloseHandler { [weak self, weak client] in
            guard let self, let client else { return }
            self.forget(client)
        }

        conn.stateUpdateHandler = { [weak self, weak client] state in
            guard let self, let client else { return }
            switch state {
            case .failed, .cancelled: self.forget(client)
            default: break
            }
        }
        conn.start(queue: queue)
        receive(on: client)
    }

    /// Rimuove il client una volta sola, da qualunque coda arrivi la chiusura.
    private func forget(_ client: ClientConnection) {
        let removed = withClients { $0.removeValue(forKey: client.id) }
        guard removed != nil else { return }
        if client.isWebSocket { delegate?.clientDidCloseWebSocket(client) }
    }

    private func receive(on client: ClientConnection) {
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 128 * 1024) { [weak self, weak client] data, _, isComplete, error in
            guard let self, let client else { return }
            if let data, !data.isEmpty {
                client.buffer.append(data)
                self.drain(client)
            }
            if isComplete || error != nil {
                client.close()
                return
            }
            self.receive(on: client)
        }
    }

    private func drain(_ client: ClientConnection) {
        do {
            if client.isWebSocket {
                while let frame = try WebSocketCodec.decode(from: &client.buffer) {
                    switch frame.opcode {
                    case .text:
                        if let s = String(data: frame.payload, encoding: .utf8) {
                            delegate?.handleWebSocketText(s, from: client)
                        }
                    case .ping:
                        client.sendRaw(WebSocketCodec.encode(opcode: .pong, payload: frame.payload))
                    case .close:
                        client.sendRaw(WebSocketCodec.encode(opcode: .close, payload: Data()))
                        client.close()
                        return
                    default:
                        break
                    }
                }
            } else {
                while let request = try HTTPParser.parse(&client.buffer) {
                    if isWebSocketUpgrade(request) {
                        handleUpgrade(request, client: client)
                        // Il resto del buffer, se c'e', e' gia' framing WebSocket.
                        if !client.buffer.isEmpty { drain(client) }
                        return
                    }
                    guard let delegate else {
                        client.sendRaw(HTTPResponse.text("Not found", status: 404).serialized())
                        continue
                    }
                    // `nil`: il delegato risponde da solo, piu' tardi, con `reply`.
                    if let response = delegate.handleHTTP(request, from: client) {
                        reply(response, to: client, for: request)
                    }
                }
            }
        } catch {
            Log.warn("protocollo non valido da", client.remoteDescription, "->", "\(error)")
            client.close()
        }
    }

    /// Una risposta sul filo, **nella forma giusta per quella richiesta**:
    /// compressa se il browser accetta gzip e il contenuto lo merita. Da qui
    /// passano tutte, quelle immediate e quelle rimandate (`handleHTTP` → nil).
    /// Si puo' chiamare da qualunque coda: `NWConnection.send` e' sicura.
    func reply(_ response: HTTPResponse, to client: ClientConnection, for request: HTTPRequest) {
        client.sendRaw(response.encoded(for: request).serialized())
    }

    private func isWebSocketUpgrade(_ r: HTTPRequest) -> Bool {
        (r.header("upgrade")?.lowercased() == "websocket") &&
        (r.header("connection")?.lowercased().contains("upgrade") ?? false) &&
        r.header("sec-websocket-key") != nil
    }

    private func handleUpgrade(_ request: HTTPRequest, client: ClientConnection) {
        guard request.path == "/ws" else {
            client.sendRaw(HTTPResponse.text("Not found", status: 404).serialized())
            client.close()
            return
        }
        guard let token = request.bearerToken, AuthStore.shared.isValid(token: token) else {
            Log.warn("WebSocket rifiutato: token assente o non valido da", client.remoteDescription)
            client.sendRaw(HTTPResponse.text("Unauthorized", status: 401).serialized())
            client.close()
            return
        }
        guard let key = request.header("sec-websocket-key") else {
            client.sendRaw(HTTPResponse.text("Bad request", status: 400).serialized())
            client.close()
            return
        }

        client.token = token
        client.label = AuthStore.shared.device(for: token)?.label ?? "Dispositivo"

        let accept = WebSocketCodec.acceptKey(for: key)
        let head = """
        HTTP/1.1 101 Switching Protocols\r
        Upgrade: websocket\r
        Connection: Upgrade\r
        Sec-WebSocket-Accept: \(accept)\r
        \r

        """
        client.sendRaw(Data(head.utf8))
        client.isWebSocket = true
        Log.info("WebSocket collegato:", client.label, client.remoteDescription)
        delegate?.clientDidOpenWebSocket(client)
    }

    // MARK: - Rete locale

    /// Solo indirizzi privati / link-local / loopback. Se l'host finisse esposto
    /// su una rete pubblica, le connessioni verrebbero comunque rifiutate.
    static func isLocalPeer(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let addr):
            let b = [UInt8](addr.rawValue)
            guard b.count == 4 else { return false }
            if b[0] == 127 { return true }                       // loopback
            if b[0] == 10 { return true }                        // 10/8
            if b[0] == 192 && b[1] == 168 { return true }         // 192.168/16
            if b[0] == 172 && (16...31).contains(b[1]) { return true } // 172.16/12
            if b[0] == 169 && b[1] == 254 { return true }         // link-local
            // 100.64/10: l'intervallo che usano le VPN personali (Tailscale).
            // Non e' Internet: e' una rete privata cifrata fra i **tuoi**
            // dispositivi, quindi vale quanto il Wi-Fi di casa.
            if b[0] == 100 && (64...127).contains(b[1]) { return true }
            return false
        case .ipv6(let addr):
            if addr.isLoopback { return true }
            if addr.isLinkLocal { return true }
            let b = [UInt8](addr.rawValue)
            guard b.count == 16 else { return false }
            if (b[0] & 0xFE) == 0xFC { return true }              // fc00::/7 unique local
            // fd7a:115c:a1e0::/48 — gli indirizzi IPv6 di Tailscale, che
            // ricadono comunque dentro fc00::/7 qui sopra.
            // IPv4 mappato (::ffff:a.b.c.d)
            if b[0...9].allSatisfy({ $0 == 0 }), b[10] == 0xFF, b[11] == 0xFF {
                if b[12] == 127 || b[12] == 10 { return true }
                if b[12] == 192 && b[13] == 168 { return true }
                if b[12] == 172 && (16...31).contains(b[13]) { return true }
                if b[12] == 169 && b[13] == 254 { return true }
                if b[12] == 100 && (64...127).contains(b[13]) { return true }
            }
            return false
        default:
            return false
        }
    }

    static func describe(endpoint: NWEndpoint) -> String {
        guard case let .hostPort(host, port) = endpoint else { return "\(endpoint)" }
        return "\(host):\(port.rawValue)"
    }
}
