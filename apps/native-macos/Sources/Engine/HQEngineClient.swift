import Foundation

protocol HQEngineTransport: Sendable {
    func start() async throws -> AsyncThrowingStream<Data, Error>
    func send(_ data: Data) async throws
    func stop() async
}

enum HQEngineClientError: LocalizedError, Equatable, Sendable {
    case notStarted
    case duplicateRequestID(String)
    case requestTimedOut(String)
    case transportEnded
    case unknownResponse(String)

    var errorDescription: String? {
        switch self {
        case .notStarted:
            "The HQ engine has not completed its startup handshake."
        case let .duplicateRequestID(id):
            "The HQ engine request identifier was reused: \(id)."
        case let .requestTimedOut(method):
            "The HQ engine did not complete \(method) before its deadline."
        case .transportEnded:
            "The HQ engine stopped before completing its pending requests."
        case let .unknownResponse(id):
            "The HQ engine returned a response for unknown request \(id)."
        }
    }
}

enum HQAppEngineLifecycleEvent: Equatable, Sendable {
    case failed(String)
    case stopped
}

actor HQEngineClient {
    nonisolated let events: AsyncStream<HQEngineEvent>
    nonisolated let lifecycleEvents: AsyncStream<HQAppEngineLifecycleEvent>

    private let transport: any HQEngineTransport
    private let makeRequestID: @Sendable () -> String
    private let eventContinuation: AsyncStream<HQEngineEvent>.Continuation
    private let lifecycleContinuation:
        AsyncStream<HQAppEngineLifecycleEvent>.Continuation

    private var router = HQEngineMessageRouter()
    private var consumerTask: Task<Void, Never>?
    private var handshake: HQJSONValue?
    private var startWaiters: [CheckedContinuation<HQJSONValue, Error>] = []
    private var pending: [
        String: CheckedContinuation<HQJSONValue, Error>
    ] = [:]
    private var requestTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var abandonedRequestIDs: Set<String> = []
    private var didStartTransport = false
    private var terminalError: HQEngineClientError?
    private var isStopping = false

    init(
        transport: any HQEngineTransport,
        makeRequestID: @escaping @Sendable () -> String = {
            UUID().uuidString.lowercased()
        }
    ) {
        self.transport = transport
        self.makeRequestID = makeRequestID

        var captured: AsyncStream<HQEngineEvent>.Continuation?
        events = AsyncStream { captured = $0 }
        eventContinuation = captured!

        var capturedLifecycle:
            AsyncStream<HQAppEngineLifecycleEvent>.Continuation?
        lifecycleEvents = AsyncStream { capturedLifecycle = $0 }
        lifecycleContinuation = capturedLifecycle!
    }

    func start() async throws -> HQJSONValue {
        if let terminalError {
            throw terminalError
        }
        if let handshake {
            return handshake
        }

        if !didStartTransport {
            let lines = try await transport.start()
            didStartTransport = true
            consumerTask = Task { [weak self] in
                do {
                    for try await line in lines {
                        guard let self else { return }
                        await self.consume(line)
                    }
                    guard let self else { return }
                    await self.finish(with: HQEngineClientError.transportEnded)
                } catch {
                    guard let self else { return }
                    await self.finish(with: error)
                }
            }
        }

        if let handshake {
            return handshake
        }

        return try await withCheckedThrowingContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func request(
        _ method: String,
        params: HQJSONValue = .object([:])
    ) async throws -> HQJSONValue {
        try await request(
            method,
            params: params,
            timeoutNanoseconds: nil
        )
    }

    func request(
        _ method: String,
        params: HQJSONValue = .object([:]),
        timeoutNanoseconds: UInt64?
    ) async throws -> HQJSONValue {
        guard handshake != nil else {
            throw HQEngineClientError.notStarted
        }

        let id = makeRequestID()
        guard pending[id] == nil, !abandonedRequestIDs.contains(id) else {
            throw HQEngineClientError.duplicateRequestID(id)
        }

        let data = try HQEngineCodec.encode(
            HQEngineRequest(id: id, method: method, params: params)
        )
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                if let timeoutNanoseconds {
                    requestTimeoutTasks[id] = Task { [weak self] in
                        do {
                            try await Task.sleep(
                                nanoseconds: timeoutNanoseconds
                            )
                        } catch {
                            return
                        }
                        guard let self else { return }
                        await self.timeoutRequest(id: id, method: method)
                    }
                }
                Task { [weak self, transport] in
                    do {
                        try await transport.send(data)
                    } catch {
                        guard let self else { return }
                        await self.failRequest(id: id, with: error)
                    }
                }
            }
        } onCancel: { [weak self] in
            Task {
                await self?.abandonRequest(
                    id: id,
                    error: CancellationError()
                )
            }
        }
    }

    func stop() async {
        isStopping = true
        consumerTask?.cancel()
        consumerTask = nil
        await transport.stop()
        finish(with: HQEngineClientError.transportEnded)
    }

    private func consume(_ line: Data) {
        do {
            let routed = try router.route(HQEngineCodec.decode(line))
            switch routed {
            case let .handshake(value):
                handshake = value
                let waiters = startWaiters
                startWaiters.removeAll()
                waiters.forEach { $0.resume(returning: value) }

            case let .response(id, value),
                 let .pong(id, value),
                 let .end(id, value):
                if abandonedRequestIDs.remove(id) != nil {
                    return
                }
                guard let continuation = takePendingRequest(id: id) else {
                    finish(with: HQEngineClientError.unknownResponse(id))
                    return
                }
                continuation.resume(returning: value)

            case let .failure(id, error):
                guard let id else {
                    finish(with: error)
                    return
                }
                if abandonedRequestIDs.remove(id) != nil {
                    return
                }
                guard let continuation = takePendingRequest(id: id) else {
                    finish(with: HQEngineClientError.unknownResponse(id))
                    return
                }
                continuation.resume(throwing: error)

            case let .event(event):
                eventContinuation.yield(event)
            }
        } catch {
            finish(with: error)
        }
    }

    private func failRequest(id: String, with error: Error) {
        takePendingRequest(id: id)?.resume(throwing: error)
    }

    private func timeoutRequest(id: String, method: String) {
        abandonRequest(
            id: id,
            error: HQEngineClientError.requestTimedOut(method)
        )
    }

    private func abandonRequest(id: String, error: Error) {
        guard let continuation = takePendingRequest(id: id) else { return }
        abandonedRequestIDs.insert(id)
        continuation.resume(throwing: error)
    }

    private func takePendingRequest(
        id: String
    ) -> CheckedContinuation<HQJSONValue, Error>? {
        requestTimeoutTasks.removeValue(forKey: id)?.cancel()
        return pending.removeValue(forKey: id)
    }

    private func finish(with error: Error) {
        guard terminalError == nil else { return }
        terminalError = .transportEnded
        handshake = nil

        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume(throwing: error) }

        requestTimeoutTasks.values.forEach { $0.cancel() }
        requestTimeoutTasks.removeAll()
        abandonedRequestIDs.removeAll()
        let requests = pending.values
        pending.removeAll()
        requests.forEach { $0.resume(throwing: error) }

        eventContinuation.finish()
        if isStopping {
            lifecycleContinuation.yield(.stopped)
        } else {
            lifecycleContinuation.yield(
                .failed(error.localizedDescription)
            )
        }
        lifecycleContinuation.finish()
    }
}
