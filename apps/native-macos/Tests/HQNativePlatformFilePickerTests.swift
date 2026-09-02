import AppKit
import UniformTypeIdentifiers
import XCTest
@testable import HQNative

@MainActor
final class HQNativePlatformFilePickerTests: XCTestCase {
    func testFolderPickerConfiguresNativePanelAndReturnsSelection() {
        let folder = URL(fileURLWithPath: "/tmp/HQ Workspace")
        let panel = OpenPanelSpy(response: .OK, urls: [folder])
        let picker = HQNativeFilePicker(panelFactory: OpenPanelFactorySpy(panel: panel))

        let result = picker.pick(
            HQFilePickerRequest(
                mode: .folders,
                allowsMultipleSelection: true,
                message: "Choose an HQ workspace",
                prompt: "Choose"
            )
        )

        XCTAssertEqual(result, [folder])
        XCTAssertFalse(panel.canChooseFiles)
        XCTAssertTrue(panel.canChooseDirectories)
        XCTAssertTrue(panel.allowsMultipleSelection)
        XCTAssertTrue(panel.resolvesAliases)
        XCTAssertEqual(panel.allowedContentTypes, [])
        XCTAssertEqual(panel.message, "Choose an HQ workspace")
        XCTAssertEqual(panel.prompt, "Choose")
        XCTAssertEqual(panel.runModalCallCount, 1)
    }

    func testFilePickerPassesAllowedTypesAndUsesSingleSelectionByDefault() {
        let file = URL(fileURLWithPath: "/tmp/notes.md")
        let panel = OpenPanelSpy(response: .OK, urls: [file])
        let picker = HQNativeFilePicker(panelFactory: OpenPanelFactorySpy(panel: panel))

        let result = picker.pick(
            HQFilePickerRequest(mode: .files(allowedContentTypes: [.plainText, .json]))
        )

        XCTAssertEqual(result, [file])
        XCTAssertTrue(panel.canChooseFiles)
        XCTAssertFalse(panel.canChooseDirectories)
        XCTAssertFalse(panel.allowsMultipleSelection)
        XCTAssertEqual(panel.allowedContentTypes, [.plainText, .json])
    }

    func testCancellationNeverLeaksPanelURLs() {
        let panel = OpenPanelSpy(
            response: .cancel,
            urls: [URL(fileURLWithPath: "/tmp/should-not-return")]
        )
        let picker = HQNativeFilePicker(panelFactory: OpenPanelFactorySpy(panel: panel))

        let result = picker.pick(HQFilePickerRequest(mode: .folders))

        XCTAssertEqual(result, [])
        XCTAssertEqual(panel.runModalCallCount, 1)
    }

    func testSystemFactoryBridgesNativePanelPropertiesWithoutPresentingIt() {
        let panel = HQSystemOpenPanelFactory().makeOpenPanel()

        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = true
        panel.allowedContentTypes = [.json]
        panel.message = "Choose a file"
        panel.prompt = "Open"

        XCTAssertTrue(panel.canChooseFiles)
        XCTAssertFalse(panel.canChooseDirectories)
        XCTAssertTrue(panel.allowsMultipleSelection)
        XCTAssertTrue(panel.resolvesAliases)
        XCTAssertEqual(panel.allowedContentTypes, [.json])
        XCTAssertEqual(panel.message, "Choose a file")
        XCTAssertEqual(panel.prompt, "Open")
        XCTAssertEqual(panel.urls, [])
    }
}

@MainActor
private final class OpenPanelFactorySpy: HQOpenPanelMaking {
    private let panel: any HQOpenPanelDriving

    init(panel: any HQOpenPanelDriving) {
        self.panel = panel
    }

    func makeOpenPanel() -> any HQOpenPanelDriving {
        panel
    }
}

@MainActor
private final class OpenPanelSpy: HQOpenPanelDriving {
    var canChooseFiles = false
    var canChooseDirectories = false
    var allowsMultipleSelection = false
    var resolvesAliases = false
    var allowedContentTypes: [UTType] = []
    var message: String?
    var prompt: String?
    let urls: [URL]
    private let response: NSApplication.ModalResponse
    private(set) var runModalCallCount = 0

    init(response: NSApplication.ModalResponse, urls: [URL]) {
        self.response = response
        self.urls = urls
    }

    func runModal() -> NSApplication.ModalResponse {
        runModalCallCount += 1
        return response
    }
}
