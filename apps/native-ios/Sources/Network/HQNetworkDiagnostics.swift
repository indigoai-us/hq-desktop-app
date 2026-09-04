import Foundation
import SwiftUI

/// Operational metadata only. It deliberately has no URL, header, request-body,
/// response-body, account, or subject fields so it can be shown in-app safely.
struct HQNetworkDiagnostic: Equatable, Identifiable, Sendable {
    enum RequestClass: String, Sendable { case bootstrap, membership, realtime, routeRead, idempotentMutation, unsafeMutation }
    enum Authentication: String, Sendable { case authenticated, unavailable, rejected }
    enum Outcome: String, Sendable {
        case success
        case serverFailure
        case retryScheduled
        case transportFailure
        case cancelled
        case invalidResponse
        case responseRejected
    }

    let id: UUID
    let requestID: UUID
    let requestClass: RequestClass
    let statusCode: Int?
    let latency: TimeInterval
    let retryCount: Int
    let authentication: Authentication
    let outcome: Outcome
    /// Bounded metadata only; no server-provided strings enter diagnostics.
    let retryDelayMilliseconds: Int?
    let occurredAt: Date
}

actor HQNetworkDiagnostics {
    static let shared = HQNetworkDiagnostics()

    private(set) var recent: [HQNetworkDiagnostic] = []
    private(set) var lastReconciliationAt: Date?

    func record(_ diagnostic: HQNetworkDiagnostic) {
        recent.append(diagnostic)
        if recent.count > 20 { recent.removeFirst(recent.count - 20) }
    }

    /// Called only by the owner of an authoritative REST reconcile after the
    /// decoded state has been applied. Ordinary 2xx responses are not a
    /// reconciliation signal.
    func recordReconciliationCompleted(at date: Date = .now) {
        lastReconciliationAt = date
    }

    func snapshot() -> (recent: [HQNetworkDiagnostic], lastReconciliationAt: Date?) {
        (recent, lastReconciliationAt)
    }
}

@MainActor
final class HQNetworkDiagnosticsModel: ObservableObject {
    @Published private(set) var recent: [HQNetworkDiagnostic] = []
    @Published private(set) var lastReconciliationAt: Date?

    func refresh(from diagnostics: HQNetworkDiagnostics = .shared) async {
        let snapshot = await diagnostics.snapshot()
        recent = snapshot.recent
        lastReconciliationAt = snapshot.lastReconciliationAt
    }
}

/// A deliberately metadata-only developer surface. It remains useful on a real
/// session without creating a second, unsafe log store for network payloads.
struct HQNetworkDiagnosticsView: View {
    @StateObject private var model = HQNetworkDiagnosticsModel()

    var body: some View {
        List {
            Section("Last reconciliation") {
                Text(model.lastReconciliationAt?.formatted() ?? "No successful reconciliation yet")
            }
            Section("Recent requests") {
                if model.recent.isEmpty {
                    Text("No network activity in this session.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.recent.reversed()) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.requestClass.rawValue)
                        Text("status \(entry.statusCode.map(String.init) ?? "network error") · \(Int(entry.latency * 1_000)) ms · retries \(entry.retryCount) · \(entry.authentication.rawValue) · \(entry.outcome.rawValue)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Network diagnostics")
        .task { await model.refresh() }
    }
}
