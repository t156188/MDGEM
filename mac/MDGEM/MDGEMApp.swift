import SwiftUI
import UniformTypeIdentifiers

@main
struct MDGEMApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @AppStorage("themeOverride") private var themeOverride: String = "dark"
    @AppStorage("pageZoom") private var pageZoom: Double = 1.0

    var body: some Scene {
        // A real window scene shown at launch — gives the app a window so the
        // DocumentGroup doesn't pop the system Open panel on cold launch, and
        // serves as the home/welcome screen. Closed automatically once a
        // document window opens (see WelcomeView / AppDelegate).
        Window("MDGEM", id: AppDelegate.welcomeWindowID) {
            WelcomeView()
                .frame(minWidth: 460, minHeight: 420)
                .preferredColorScheme(colorScheme(for: themeOverride))
        }
        .defaultSize(width: 520, height: 460)
        .windowResizability(.contentMinSize)

        DocumentGroup(viewing: MarkdownDocument.self) { file in
            ContentView(document: file.document, fileURL: file.fileURL)
                .frame(minWidth: 520, idealWidth: 900, minHeight: 360, idealHeight: 720)
                .preferredColorScheme(colorScheme(for: themeOverride))
        }
        .defaultSize(width: 900, height: 720)
        .commands {
            MDGEMCommands(themeOverride: $themeOverride, pageZoom: $pageZoom)
        }
    }

    private func colorScheme(for value: String) -> ColorScheme? {
        switch value {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}
