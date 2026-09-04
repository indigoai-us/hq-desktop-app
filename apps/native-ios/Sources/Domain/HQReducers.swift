import Foundation

enum HQDomainError: Equatable, Sendable {
    case message(String, retryable: Bool)
    case envelope(HQErrorEnvelope)
}

/// Every screen-facing state is explicit. This pure domain state can be used by
/// any renderer and has no dependency on an I/O implementation.
enum HQLoadState<Content: Equatable>: Equatable {
    case loading(previous: Content?)
    case content(Content)
    case empty
    case partial(Content, missingFields: Set<String>)
    case stale(Content)
    case offline(previous: Content?)
    case permissionDenied
    case error(HQDomainError, previous: Content?)
}

enum HQLoadAction<Content> {
    case loadStarted
    case received(Content)
    case receivedPartial(Content, missingFields: Set<String>)
    case cached(Content)
    case offline
    case permissionDenied
    case failed(HQDomainError)
    case cleared
}

enum HQLoadReducer {
    static func reduce<Content: Equatable>(
        state: HQLoadState<Content>,
        action: HQLoadAction<Content>,
        isEmpty: (Content) -> Bool
    ) -> HQLoadState<Content> {
        switch action {
        case .loadStarted:
            .loading(previous: retainedContent(from: state))
        case let .received(content):
            isEmpty(content) ? .empty : .content(content)
        case let .receivedPartial(content, missingFields):
            .partial(content, missingFields: missingFields)
        case let .cached(content):
            .stale(content)
        case .offline:
            .offline(previous: retainedContent(from: state))
        case .permissionDenied:
            .permissionDenied
        case let .failed(error):
            .error(error, previous: retainedContent(from: state))
        case .cleared:
            .empty
        }
    }

    private static func retainedContent<Content>(from state: HQLoadState<Content>) -> Content? {
        switch state {
        case let .loading(previous), let .offline(previous), let .error(_, previous): previous
        case let .content(content), let .partial(content, _), let .stale(content): content
        case .empty, .permissionDenied: nil
        }
    }
}
