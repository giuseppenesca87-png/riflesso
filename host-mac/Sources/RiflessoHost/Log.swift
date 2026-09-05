import Foundation

/// Log su stderr + file, cosi' l'app impacchettata resta ispezionabile senza Console.app.
enum Log {
    static let fileURL: URL = {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Riflesso", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("riflesso.log")
    }()

    private static let queue = DispatchQueue(label: "riflesso.log")
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func info(_ items: Any...) { write("INFO", items) }
    static func warn(_ items: Any...) { write("WARN", items) }
    static func error(_ items: Any...) { write("ERR ", items) }

    private static func write(_ level: String, _ items: [Any]) {
        let msg = items.map { "\($0)" }.joined(separator: " ")
        let line = "\(formatter.string(from: Date())) \(level) \(msg)\n"
        queue.async {
            FileHandle.standardError.write(Data(line.utf8))
            if let h = try? FileHandle(forWritingTo: fileURL) {
                h.seekToEndOfFile()
                h.write(Data(line.utf8))
                try? h.close()
            } else {
                try? Data(line.utf8).write(to: fileURL)
            }
        }
    }
}
