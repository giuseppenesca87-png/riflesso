// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RiflessoHost",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "RiflessoHost",
            path: "Sources/RiflessoHost",
            // Language mode v5: le callback di ScreenCaptureKit e Network.framework
            // attraversano piu' code seriali; la concorrenza e' gestita a mano con
            // code dedicate, non con l'isolamento statico di Swift 6.
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreImage"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Network"),
                .linkedFramework("CryptoKit"),
                // La pagina ponte (WebRTC) gira in una WKWebView: `RemoteLink.swift`.
                .linkedFramework("WebKit"),
                // gzip per la webapp e le risposte JSON: `HTTP.swift`. E' una
                // libreria (`libcompression`), non un framework.
                .linkedLibrary("compression"),
                // La dettatura si trascrive sul Mac: `Trascrizione.swift`.
                .linkedFramework("Speech"),
                .linkedFramework("AVFoundation"),
            ]
        )
    ]
)
