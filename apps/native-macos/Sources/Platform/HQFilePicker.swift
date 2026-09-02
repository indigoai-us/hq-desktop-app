import AppKit
import UniformTypeIdentifiers

@MainActor
protocol HQOpenPanelDriving: AnyObject {
    var canChooseFiles: Bool { get set }
    var canChooseDirectories: Bool { get set }
    var allowsMultipleSelection: Bool { get set }
    var resolvesAliases: Bool { get set }
    var allowedContentTypes: [UTType] { get set }
    var message: String? { get set }
    var prompt: String? { get set }
    var urls: [URL] { get }

    func runModal() -> NSApplication.ModalResponse
}

@MainActor
protocol HQOpenPanelMaking {
    func makeOpenPanel() -> any HQOpenPanelDriving
}

@MainActor
struct HQSystemOpenPanelFactory: HQOpenPanelMaking {
    func makeOpenPanel() -> any HQOpenPanelDriving {
        HQSystemOpenPanelDriver()
    }
}

@MainActor
private final class HQSystemOpenPanelDriver: HQOpenPanelDriving {
    private let panel = NSOpenPanel()

    var canChooseFiles: Bool {
        get { panel.canChooseFiles }
        set { panel.canChooseFiles = newValue }
    }

    var canChooseDirectories: Bool {
        get { panel.canChooseDirectories }
        set { panel.canChooseDirectories = newValue }
    }

    var allowsMultipleSelection: Bool {
        get { panel.allowsMultipleSelection }
        set { panel.allowsMultipleSelection = newValue }
    }

    var resolvesAliases: Bool {
        get { panel.resolvesAliases }
        set { panel.resolvesAliases = newValue }
    }

    var allowedContentTypes: [UTType] {
        get { panel.allowedContentTypes }
        set { panel.allowedContentTypes = newValue }
    }

    var message: String? {
        get { panel.message }
        set { panel.message = newValue ?? "" }
    }

    var prompt: String? {
        get { panel.prompt }
        set { panel.prompt = newValue ?? "" }
    }

    var urls: [URL] {
        panel.urls
    }

    func runModal() -> NSApplication.ModalResponse {
        panel.runModal()
    }
}

enum HQFilePickerMode: Equatable, Sendable {
    case folders
    case files(allowedContentTypes: [UTType])
}

struct HQFilePickerRequest: Equatable, Sendable {
    let mode: HQFilePickerMode
    let allowsMultipleSelection: Bool
    let message: String?
    let prompt: String?

    init(
        mode: HQFilePickerMode,
        allowsMultipleSelection: Bool = false,
        message: String? = nil,
        prompt: String? = nil
    ) {
        self.mode = mode
        self.allowsMultipleSelection = allowsMultipleSelection
        self.message = message
        self.prompt = prompt
    }
}

@MainActor
final class HQNativeFilePicker {
    private let panelFactory: any HQOpenPanelMaking

    init(panelFactory: any HQOpenPanelMaking = HQSystemOpenPanelFactory()) {
        self.panelFactory = panelFactory
    }

    func pick(_ request: HQFilePickerRequest) -> [URL] {
        let panel = panelFactory.makeOpenPanel()
        panel.allowsMultipleSelection = request.allowsMultipleSelection
        panel.resolvesAliases = true
        panel.message = request.message
        panel.prompt = request.prompt

        switch request.mode {
        case .folders:
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowedContentTypes = []
        case let .files(allowedContentTypes):
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowedContentTypes = allowedContentTypes
        }

        guard panel.runModal() == .OK else {
            return []
        }

        return panel.urls
    }
}
