import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

/// Come vengono consegnati gli eventi a Claude Desktop.
///
/// Misurato su Claude Desktop 1.32885.1 (Electron 42) — vedi PROGRESS.md:
///
///   azione            CGEventPostToPid      CGEventPost(.cghidEventTap)
///   tasti + modificatori funziona            funziona
///   incolla ⌘V         funziona              funziona
///
/// La tastiera va al processo di default
/// (non ruba il primo piano né muove il cursore di chi sta al Mac).
/// Il puntatore (clic, trascinamenti, scorrimento) serviva allo specchio,
/// tolto il 30/08/2026: quel codice — 121 righe senza nessuna chiamata — se
/// n'e' andato il 04/09/2026. Restano le tre modalita', perche' `.hid` manda
/// anche i tasti al sistema e qualcuno potrebbe averla scelta.
enum InjectionMode: String, Codable, CaseIterable {
    /// Tastiera al processo. È quella che funziona.
    case hybrid
    /// Come `hybrid`, da quando il puntatore non c'e' piu'.
    case pid
    /// Tutto al sistema: serve Claude in primo piano.
    case hid

    var label: String {
        switch self {
        case .hybrid: return "ibrida (consigliata)"
        case .pid: return "solo al processo"
        case .hid: return "tutto in primo piano"
        }
    }
}

private enum Tap { case pid, hid }

enum SpecialKey: String {
    case escape, enter, tab, up, down, left, right
    case backspace, delete, home, end, pageUp, pageDown

    var code: CGKeyCode {
        switch self {
        case .escape: return 53
        case .enter: return 36
        case .tab: return 48
        case .up: return 126
        case .down: return 125
        case .left: return 123
        case .right: return 124
        case .backspace: return 51
        case .delete: return 117
        case .home: return 115
        case .end: return 119
        case .pageUp: return 116
        case .pageDown: return 121
        }
    }
}

final class InputInjector {
    static let shared = InputInjector()

    private let queue = DispatchQueue(label: "riflesso.input")
    private let source = CGEventSource(stateID: .hidSystemState)

    var mode: InjectionMode = {
        if let raw = UserDefaults.standard.string(forKey: "riflesso.injectionMode"),
           let m = InjectionMode(rawValue: raw) { return m }
        return .hybrid
    }() {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "riflesso.injectionMode") }
    }

    private let vKeyCode: CGKeyCode = 9      // V
    private let cmdKeyCode: CGKeyCode = 55   // Command sinistro

    private var keyboardTap: Tap { mode == .hid ? .hid : .pid }

    // MARK: - Permessi

    var accessibilityGranted: Bool { AXIsProcessTrusted() }

    func requestAccessibility() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }

    // MARK: - Consegna

    private func deliver(_ event: CGEvent?, to pid: pid_t, via tap: Tap) {
        guard let event else { return }
        switch tap {
        case .pid: event.postToPid(pid)
        case .hid: event.post(tap: .cghidEventTap)
        }
    }

    /// Porta Claude davanti. Lo usa `DesktopBridge` quando i tasti al
    /// processo non bastano.
    func activate(pid: pid_t) {
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    }

    // MARK: - Tastiera

    func sendKey(_ key: SpecialKey, flags: CGEventFlags = [], pid: pid_t) {
        sendKeyCode(key.code, flags: flags, pid: pid)
    }

    func sendKeyCode(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t) {
        queue.async { self.postKeySequence(code: code, flags: flags, pid: pid) }
    }

    /// Il tasto Command viene premuto e rilasciato davvero: con i soli `flags`
    /// sull'evento alcune scorciatoie di Electron non scattano.
    private func postKeySequence(code: CGKeyCode, flags: CGEventFlags, pid: pid_t) {
        let tap = keyboardTap
        let needsCmd = flags.contains(.maskCommand)
        if needsCmd {
            let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: cmdKeyCode, keyDown: true)
            cmdDown?.flags = .maskCommand
            deliver(cmdDown, to: pid, via: tap)
            usleep(15_000)
        }
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        down?.flags = flags
        deliver(down, to: pid, via: tap)
        usleep(20_000)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        up?.flags = flags
        deliver(up, to: pid, via: tap)
        if needsCmd {
            usleep(15_000)
            let cmdUp = CGEvent(keyboardEventSource: source, virtualKey: cmdKeyCode, keyDown: false)
            cmdUp?.flags = []
            deliver(cmdUp, to: pid, via: tap)
        }
    }

    // MARK: - Testo

    /// Consegna il testo in un colpo solo: appunti + ⌘V.
    /// Provato e funzionante su Claude Desktop anche senza portarla in primo piano.
    func pasteText(_ text: String, pid: pid_t, then: (() -> Void)? = nil) {
        queue.async {
            let pb = NSPasteboard.general
            let saved = pb.string(forType: .string)
            pb.clearContents()
            pb.setString(text, forType: .string)
            // 40 ms non bastavano: ogni tanto ⌘V arrivava prima che l'altro
            // processo vedesse il nuovo contenuto e incollava il testo vecchio.
            usleep(120_000)

            self.postKeySequence(code: self.vKeyCode, flags: .maskCommand, pid: pid)

            // Ripristino ritardato: subito incollerebbe il testo vecchio.
            self.queue.asyncAfter(deadline: .now() + 1.5) {
                if let saved {
                    pb.clearContents()
                    pb.setString(saved, forType: .string)
                }
            }
            then?()
        }
    }

    /// Come `pasteText`, ma con un **file**: negli appunti ci va l'indirizzo del
    /// file, e Claude Desktop lo trasforma in un allegato (provato, vedi
    /// `--attachprobe`). Gli appunti di prima si rimettono a posto dopo.
    ///
    /// Il testo di prima si salva e si rimette come fa `pasteText`; un file
    /// negli appunti invece non si ripristina, perche' non e' quel che c'era.
    func pasteFile(_ url: URL, pid: pid_t) {
        queue.sync {
            let pb = NSPasteboard.general
            let saved = pb.string(forType: .string)
            pb.clearContents()
            pb.writeObjects([url as NSURL])
            // Come per il testo: dare all'altro processo il tempo di vedere il
            // nuovo contenuto, altrimenti ⌘V incolla quello di prima.
            usleep(200_000)

            self.postKeySequence(code: self.vKeyCode, flags: .maskCommand, pid: pid)

            // Piu' lungo che per il testo: qui il Desktop deve **leggere** il
            // file, e rimettere gli appunti a meta' strada glielo toglierebbe
            // di sotto.
            self.queue.asyncAfter(deadline: .now() + 4) {
                pb.clearContents()
                if let saved { pb.setString(saved, forType: .string) }
            }
        }
    }

    /// Alternativa senza appunti: un solo evento con l'intera stringa Unicode.
    func typeUnicode(_ text: String, pid: pid_t) {
        queue.async {
            var utf16 = Array(text.utf16)
            guard !utf16.isEmpty else { return }
            guard let down = CGEvent(keyboardEventSource: self.source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: self.source, virtualKey: 0, keyDown: false)
            else { return }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            self.deliver(down, to: pid, via: self.keyboardTap)
            usleep(8_000)
            self.deliver(up, to: pid, via: self.keyboardTap)
        }
    }
}
