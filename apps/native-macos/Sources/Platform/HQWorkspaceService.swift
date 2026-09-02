import AppKit
import Foundation

enum HQWorkspaceServiceError: Error, Equatable {
    case applicationNotFound(bundleIdentifier: String)
    case emptySelection
    case openRejected(URL)
}

@MainActor
protocol HQWorkspaceDriving {
    func open(_ url: URL) -> Bool
    func reveal(_ urls: [URL])
    func applicationURL(forBundleIdentifier bundleIdentifier: String) -> URL?
    func open(_ urls: [URL], withApplicationAt applicationURL: URL) async throws
}

enum HQSystemWorkspaceError: Error, Equatable {
    case openFailed(String)
}

@MainActor
final class HQSystemWorkspaceDriver: HQWorkspaceDriving {
    private let workspace: NSWorkspace

    init(workspace: NSWorkspace = .shared) {
        self.workspace = workspace
    }

    func open(_ url: URL) -> Bool {
        workspace.open(url)
    }

    func reveal(_ urls: [URL]) {
        workspace.activateFileViewerSelecting(urls)
    }

    func applicationURL(forBundleIdentifier bundleIdentifier: String) -> URL? {
        workspace.urlForApplication(withBundleIdentifier: bundleIdentifier)
    }

    func open(_ urls: [URL], withApplicationAt applicationURL: URL) async throws {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            workspace.open(
                urls,
                withApplicationAt: applicationURL,
                configuration: configuration
            ) { _, error in
                if let error {
                    continuation.resume(
                        throwing: HQSystemWorkspaceError.openFailed(error.localizedDescription)
                    )
                } else {
                    continuation.resume()
                }
            }
        }
    }
}

@MainActor
final class HQNativeWorkspaceService {
    private let workspace: any HQWorkspaceDriving

    init(workspace: any HQWorkspaceDriving = HQSystemWorkspaceDriver()) {
        self.workspace = workspace
    }

    func openURL(_ url: URL) throws {
        guard workspace.open(url) else {
            throw HQWorkspaceServiceError.openRejected(url)
        }
    }

    func revealInFinder(_ urls: [URL]) throws {
        guard !urls.isEmpty else {
            throw HQWorkspaceServiceError.emptySelection
        }

        workspace.reveal(urls)
    }

    func openInEditor(_ urls: [URL], bundleIdentifier: String) async throws {
        guard !urls.isEmpty else {
            throw HQWorkspaceServiceError.emptySelection
        }
        guard let applicationURL = workspace.applicationURL(
            forBundleIdentifier: bundleIdentifier
        ) else {
            throw HQWorkspaceServiceError.applicationNotFound(
                bundleIdentifier: bundleIdentifier
            )
        }

        try await workspace.open(urls, withApplicationAt: applicationURL)
    }
}
