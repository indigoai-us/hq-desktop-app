import AppKit
import XCTest
@testable import HQNative

@MainActor
final class HQNativePlatformWorkspaceTests: XCTestCase {
    func testOpenURLUsesNSWorkspaceDriver() throws {
        let url = URL(string: "https://example.com/hq")!
        let driver = WorkspaceDriverSpy()
        driver.openResult = true
        let service = HQNativeWorkspaceService(workspace: driver)

        try service.openURL(url)

        XCTAssertEqual(driver.openedURLs, [url])
    }

    func testOpenURLReportsRejectedRequest() {
        let url = URL(string: "hq://unavailable")!
        let driver = WorkspaceDriverSpy()
        driver.openResult = false
        let service = HQNativeWorkspaceService(workspace: driver)

        XCTAssertThrowsError(try service.openURL(url)) { error in
            XCTAssertEqual(error as? HQWorkspaceServiceError, .openRejected(url))
        }
    }

    func testRevealInFinderDelegatesSelection() throws {
        let file = URL(fileURLWithPath: "/tmp/project/README.md")
        let driver = WorkspaceDriverSpy()
        let service = HQNativeWorkspaceService(workspace: driver)

        try service.revealInFinder([file])

        XCTAssertEqual(driver.revealedURLs, [[file]])
    }

    func testRevealRejectsEmptySelection() {
        let service = HQNativeWorkspaceService(workspace: WorkspaceDriverSpy())

        XCTAssertThrowsError(try service.revealInFinder([])) { error in
            XCTAssertEqual(error as? HQWorkspaceServiceError, .emptySelection)
        }
    }

    func testOpenInEditorResolvesBundleIdentifierAndDelegates() async throws {
        let file = URL(fileURLWithPath: "/tmp/project/README.md")
        let editor = URL(fileURLWithPath: "/Applications/Example Editor.app")
        let driver = WorkspaceDriverSpy()
        driver.applicationURLs["com.example.editor"] = editor
        let service = HQNativeWorkspaceService(workspace: driver)

        try await service.openInEditor([file], bundleIdentifier: "com.example.editor")

        XCTAssertEqual(driver.requestedBundleIdentifiers, ["com.example.editor"])
        XCTAssertEqual(driver.editorOpenCalls, [EditorOpenCall(urls: [file], applicationURL: editor)])
    }

    func testOpenInEditorReportsMissingApplication() async {
        let driver = WorkspaceDriverSpy()
        let service = HQNativeWorkspaceService(workspace: driver)

        do {
            try await service.openInEditor(
                [URL(fileURLWithPath: "/tmp/project")],
                bundleIdentifier: "com.example.missing"
            )
            XCTFail("Expected applicationNotFound")
        } catch {
            XCTAssertEqual(
                error as? HQWorkspaceServiceError,
                .applicationNotFound(bundleIdentifier: "com.example.missing")
            )
        }
    }

    func testOpenInEditorRejectsEmptySelectionBeforeResolvingApplication() async {
        let driver = WorkspaceDriverSpy()
        let service = HQNativeWorkspaceService(workspace: driver)

        do {
            try await service.openInEditor([], bundleIdentifier: "com.example.editor")
            XCTFail("Expected emptySelection")
        } catch {
            XCTAssertEqual(error as? HQWorkspaceServiceError, .emptySelection)
            XCTAssertEqual(driver.requestedBundleIdentifiers, [])
        }
    }
}

private struct EditorOpenCall: Equatable {
    let urls: [URL]
    let applicationURL: URL
}

private enum WorkspaceDriverTestError: Error {
    case rejected
}

@MainActor
private final class WorkspaceDriverSpy: HQWorkspaceDriving {
    var openResult = false
    var applicationURLs: [String: URL] = [:]
    var editorOpenError: Error?
    private(set) var openedURLs: [URL] = []
    private(set) var revealedURLs: [[URL]] = []
    private(set) var requestedBundleIdentifiers: [String] = []
    private(set) var editorOpenCalls: [EditorOpenCall] = []

    func open(_ url: URL) -> Bool {
        openedURLs.append(url)
        return openResult
    }

    func reveal(_ urls: [URL]) {
        revealedURLs.append(urls)
    }

    func applicationURL(forBundleIdentifier bundleIdentifier: String) -> URL? {
        requestedBundleIdentifiers.append(bundleIdentifier)
        return applicationURLs[bundleIdentifier]
    }

    func open(_ urls: [URL], withApplicationAt applicationURL: URL) async throws {
        editorOpenCalls.append(EditorOpenCall(urls: urls, applicationURL: applicationURL))
        if let editorOpenError {
            throw editorOpenError
        }
    }
}
