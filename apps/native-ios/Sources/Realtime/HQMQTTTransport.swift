import Foundation

enum HQWebSocketMessage: Equatable, Sendable {
    case data(Data)
    case text(String)
}

protocol HQWebSocketTransport: Sendable {
    func resume() async
    func send(_ data: Data) async throws
    func receive() async throws -> HQWebSocketMessage
    func negotiatedSubprotocol() async -> String?
    func cancel() async
}

protocol HQWebSocketCreating: Sendable {
    func makeWebSocket(url: URL, subprotocols: [String]) -> any HQWebSocketTransport
}

struct HQMQTTProtocolLimits: Equatable, Sendable {
    let maximumPacketBytes: Int
    let maximumPayloadBytes: Int
    let maximumTopicBytes: Int
    let maximumSubscriptions: Int
    let maximumRememberedEvents: Int

    static let production = HQMQTTProtocolLimits(
        maximumPacketBytes: 2_048,
        maximumPayloadBytes: 1_024,
        maximumTopicBytes: 256,
        maximumSubscriptions: 4,
        maximumRememberedEvents: 256
    )
}

struct HQRealtimeWakeEnvelope: Equatable, Sendable {
    let contractVersion: Int
    let eventID: UUID
    let eventType: String
    let scope: String
    let resourceID: String
    let recipientUID: String
    let createdAt: Date
}

enum HQRealtimeWakeEnvelopeDecoder {
    private static let keys: Set<String> = [
        "contractVersion", "eventId", "eventType", "scope", "resourceId", "recipientUid", "createdAt"
    ]
    private static let principalPattern = "^(?:prs|agt)_[0-9A-HJKMNP-TV-Z]{26}$"
    private static let identifierPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    private static let eventTypePattern = "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"
    private static let timestampPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$"#
    private struct WireEnvelope: Decodable {
        let contractVersion: Int
        let eventId: String
        let eventType: String
        let scope: String
        let resourceId: String
        let recipientUid: String
        let createdAt: String
    }

    static func decode(_ data: Data, expectedRecipient: String) throws -> HQRealtimeWakeEnvelope {
        guard !data.isEmpty, data.count <= HQMQTTProtocolLimits.production.maximumPayloadBytes,
              String(data: data, encoding: .utf8) != nil,
              !hasDuplicateTopLevelKeys(data),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == keys,
              let wire = try? JSONDecoder().decode(WireEnvelope.self, from: data),
              wire.contractVersion == 2,
              isWholeMatch(wire.eventId, pattern: identifierPattern), wire.eventId.utf8.count <= 64,
              let eventID = UUID(uuidString: wire.eventId),
              eventID.uuidString.lowercased() == wire.eventId.lowercased(),
              isWholeMatch(wire.eventType, pattern: eventTypePattern), wire.eventType.utf8.count <= 64,
              ["dm", "channel", "work"].contains(wire.scope),
              isWholeMatch(wire.resourceId, pattern: identifierPattern),
              isWholeMatch(wire.recipientUid, pattern: principalPattern),
              isWholeMatch(expectedRecipient, pattern: principalPattern),
              wire.createdAt.utf8.count <= 35,
              isWholeMatch(wire.createdAt, pattern: timestampPattern),
              let createdAt = parseTimestamp(wire.createdAt)
        else { throw HQRealtimeClientError.invalidWakeEnvelope }

        guard wire.recipientUid == expectedRecipient else {
            throw HQRealtimeClientError.foreignWakeRecipient
        }
        return HQRealtimeWakeEnvelope(
            contractVersion: wire.contractVersion,
            eventID: eventID,
            eventType: wire.eventType,
            scope: wire.scope,
            resourceID: wire.resourceId,
            recipientUID: wire.recipientUid,
            createdAt: createdAt
        )
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let wholeSeconds = ISO8601DateFormatter()
        wholeSeconds.formatOptions = [.withInternetDateTime]
        return wholeSeconds.date(from: value)
    }

    private static func isWholeMatch(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == value.startIndex ..< value.endIndex
    }

    /// Foundation accepts duplicate JSON keys and keeps the last occurrence.
    /// The contract rejects them so independent parsers cannot disagree.
    private static func hasDuplicateTopLevelKeys(_ data: Data) -> Bool {
        let bytes = Array(data)
        var index = 0
        var depth = 0
        var expectingKey = false
        var keys = Set<String>()

        while index < bytes.count {
            let byte = bytes[index]
            if byte == 0x22 {
                let start = index
                index += 1
                var escaped = false
                while index < bytes.count {
                    let current = bytes[index]
                    if escaped {
                        escaped = false
                    } else if current == 0x5C {
                        escaped = true
                    } else if current == 0x22 {
                        break
                    }
                    index += 1
                }
                guard index < bytes.count else { return true }
                if depth == 1, expectingKey {
                    let quoted = Data(bytes[start ... index])
                    guard let key = try? JSONDecoder().decode(String.self, from: quoted),
                          keys.insert(key).inserted
                    else { return true }
                    expectingKey = false
                }
            } else if byte == 0x7B {
                depth += 1
                if depth == 1 { expectingKey = true }
            } else if byte == 0x7D {
                depth -= 1
                if depth < 0 { return true }
            } else if byte == 0x2C, depth == 1 {
                expectingKey = true
            }
            index += 1
        }
        return false
    }
}

enum HQMQTTInboundPacket: Equatable, Sendable {
    case connAck(sessionPresent: Bool, returnCode: UInt8)
    case subAck(packetID: UInt16, returnCodes: [UInt8])
    case pingResponse
    case publish(topic: String, packetID: UInt16, payload: Data)
}

enum HQMQTTWireCodec {
    static func connect(clientID: String, keepAliveSeconds: UInt16) throws -> Data {
        guard keepAliveSeconds > 0,
              validUTF8Field(clientID, maximumBytes: 128, allowTopicSeparators: true)
        else { throw HQRealtimeClientError.invalidMQTTPacket }
        var body = Data([0x00, 0x04])
        body.append(contentsOf: "MQTT".utf8)
        body.append(0x04)
        body.append(0x02)
        body.append(UInt8(keepAliveSeconds >> 8))
        body.append(UInt8(keepAliveSeconds & 0xFF))
        body += try encodedUTF8(clientID, maximumBytes: 128, allowTopicSeparators: true)
        return Data([0x10]) + encodedRemainingLength(body.count) + body
    }

    static func subscribe(packetID: UInt16, topics: [String], qos: UInt8,
                          limits: HQMQTTProtocolLimits = .production) throws -> Data {
        guard packetID != 0, qos == 1, !topics.isEmpty,
              topics.count <= limits.maximumSubscriptions,
              Set(topics).count == topics.count
        else { throw HQRealtimeClientError.invalidMQTTPacket }

        var body = Data([UInt8(packetID >> 8), UInt8(packetID & 0xFF)])
        for topic in topics {
            guard validTopic(topic, maximumBytes: limits.maximumTopicBytes, allowWildcards: false) else {
                throw HQRealtimeClientError.invalidMQTTPacket
            }
            body += try encodedUTF8(topic, maximumBytes: limits.maximumTopicBytes, allowTopicSeparators: true)
            body.append(qos)
        }
        guard body.count <= limits.maximumPacketBytes else {
            throw HQRealtimeClientError.packetTooLarge
        }
        return Data([0x82]) + encodedRemainingLength(body.count) + body
    }

    static var pingRequest: Data { Data([0xC0, 0x00]) }

    static func pubAck(packetID: UInt16) -> Data {
        Data([0x40, 0x02, UInt8(packetID >> 8), UInt8(packetID & 0xFF)])
    }

    static func decodeNext(from buffer: inout Data,
                           limits: HQMQTTProtocolLimits = .production) throws -> HQMQTTInboundPacket? {
        guard !buffer.isEmpty else { return nil }
        let bytes = Array(buffer)
        guard let length = try decodedRemainingLength(bytes, limits: limits) else { return nil }
        let totalLength = 1 + length.byteCount + length.value
        guard totalLength <= limits.maximumPacketBytes + 5 else {
            throw HQRealtimeClientError.packetTooLarge
        }
        guard bytes.count >= totalLength else { return nil }

        let header = bytes[0]
        let bodyStart = 1 + length.byteCount
        let body = Array(bytes[bodyStart ..< totalLength])
        let packet = try decode(header: header, body: body, limits: limits)
        buffer.removeFirst(totalLength)
        return packet
    }

    private static func decode(header: UInt8, body: [UInt8],
                               limits: HQMQTTProtocolLimits) throws -> HQMQTTInboundPacket {
        switch header >> 4 {
        case 2:
            guard header == 0x20, body.count == 2, body[0] & 0xFE == 0,
                  body[1] <= 5, !(body[1] != 0 && body[0] != 0)
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            return .connAck(sessionPresent: body[0] == 1, returnCode: body[1])
        case 3:
            guard header & 0x0F == 0x02 || header & 0x0F == 0x0A else {
                throw HQRealtimeClientError.unsupportedMQTTPacket
            }
            guard body.count >= 5 else { throw HQRealtimeClientError.invalidMQTTPacket }
            let topicLength = Int(body[0]) << 8 | Int(body[1])
            guard topicLength > 0, topicLength <= limits.maximumTopicBytes,
                  body.count >= 2 + topicLength + 2
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            let topicBytes = Data(body[2 ..< 2 + topicLength])
            guard let topic = String(data: topicBytes, encoding: .utf8),
                  Data(topic.utf8) == topicBytes,
                  validTopic(topic, maximumBytes: limits.maximumTopicBytes, allowWildcards: false)
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            let packetOffset = 2 + topicLength
            let packetID = UInt16(body[packetOffset]) << 8 | UInt16(body[packetOffset + 1])
            guard packetID != 0 else { throw HQRealtimeClientError.invalidMQTTPacket }
            let payload = Data(body[(packetOffset + 2)...])
            guard payload.count <= limits.maximumPayloadBytes else {
                throw HQRealtimeClientError.packetTooLarge
            }
            return .publish(topic: topic, packetID: packetID, payload: payload)
        case 9:
            guard header == 0x90, body.count >= 3 else {
                throw HQRealtimeClientError.invalidMQTTPacket
            }
            let packetID = UInt16(body[0]) << 8 | UInt16(body[1])
            let returnCodes = Array(body.dropFirst(2))
            guard packetID != 0, !returnCodes.isEmpty,
                  returnCodes.allSatisfy({ $0 == 0 || $0 == 1 || $0 == 2 || $0 == 0x80 })
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            return .subAck(packetID: packetID, returnCodes: returnCodes)
        case 13:
            guard header == 0xD0, body.isEmpty else {
                throw HQRealtimeClientError.invalidMQTTPacket
            }
            return .pingResponse
        default:
            throw HQRealtimeClientError.unsupportedMQTTPacket
        }
    }

    private static func decodedRemainingLength(_ bytes: [UInt8],
                                               limits: HQMQTTProtocolLimits) throws
        -> (value: Int, byteCount: Int)? {
        guard bytes.count > 1 else { return nil }
        var value = 0
        var multiplier = 1
        for offset in 1 ... 4 {
            guard bytes.count > offset else { return nil }
            let byte = bytes[offset]
            value += Int(byte & 0x7F) * multiplier
            if byte & 0x80 == 0 {
                let byteCount = offset
                guard encodedRemainingLength(value).count == byteCount else {
                    throw HQRealtimeClientError.invalidMQTTPacket
                }
                guard value <= limits.maximumPacketBytes else {
                    throw HQRealtimeClientError.packetTooLarge
                }
                return (value, byteCount)
            }
            guard offset < 4 else { throw HQRealtimeClientError.invalidMQTTPacket }
            multiplier *= 128
        }
        throw HQRealtimeClientError.invalidMQTTPacket
    }

    private static func encodedRemainingLength(_ value: Int) -> Data {
        precondition(value >= 0 && value <= 268_435_455)
        var quotient = value
        var result = Data()
        repeat {
            var byte = UInt8(quotient % 128)
            quotient /= 128
            if quotient > 0 { byte |= 0x80 }
            result.append(byte)
        } while quotient > 0
        return result
    }

    private static func encodedUTF8(_ value: String, maximumBytes: Int,
                                    allowTopicSeparators: Bool) throws -> Data {
        guard validUTF8Field(value, maximumBytes: maximumBytes,
                             allowTopicSeparators: allowTopicSeparators)
        else { throw HQRealtimeClientError.invalidMQTTPacket }
        let bytes = Data(value.utf8)
        return Data([UInt8(bytes.count >> 8), UInt8(bytes.count & 0xFF)]) + bytes
    }

    private static func validTopic(_ value: String, maximumBytes: Int,
                                   allowWildcards: Bool) -> Bool {
        guard validUTF8Field(value, maximumBytes: maximumBytes, allowTopicSeparators: true),
              !value.hasPrefix("/"), !value.hasSuffix("/")
        else { return false }
        return allowWildcards || (!value.contains("#") && !value.contains("+"))
    }

    private static func validUTF8Field(_ value: String, maximumBytes: Int,
                                       allowTopicSeparators: Bool) -> Bool {
        let count = value.utf8.count
        guard count > 0, count <= maximumBytes, count <= Int(UInt16.max),
              !value.unicodeScalars.contains(where: {
                  $0.value == 0 || (0x01 ... 0x1F).contains($0.value) ||
                      (0x7F ... 0x9F).contains($0.value)
              })
        else { return false }
        return allowTopicSeparators || !value.contains("/")
    }
}

final class HQURLSessionWebSocketFactory: HQWebSocketCreating, Sendable {
    func makeWebSocket(url: URL, subprotocols: [String]) -> any HQWebSocketTransport {
        let session = URLSession(configuration: .ephemeral)
        return HQURLSessionWebSocketTransport(
            session: session,
            task: session.webSocketTask(with: url, protocols: subprotocols)
        )
    }
}

private final class HQURLSessionWebSocketTransport: HQWebSocketTransport, @unchecked Sendable {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(session: URLSession, task: URLSessionWebSocketTask) {
        self.session = session
        self.task = task
    }

    func resume() async { task.resume() }

    func send(_ data: Data) async throws { try await task.send(.data(data)) }

    func receive() async throws -> HQWebSocketMessage {
        switch try await task.receive() {
        case let .data(data): .data(data)
        case let .string(text): .text(text)
        @unknown default: throw HQRealtimeClientError.invalidMQTTPacket
        }
    }

    func negotiatedSubprotocol() async -> String? {
        (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Sec-WebSocket-Protocol")
    }

    func cancel() async {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}

private final class HQMQTTTimeoutRace<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private var continuation: CheckedContinuation<Value, Error>?
    private var operationTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if completed {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func installTasks(operation: Task<Void, Never>, timer: Task<Void, Never>) {
        lock.lock()
        if completed {
            lock.unlock()
            operation.cancel()
            timer.cancel()
            return
        }
        operationTask = operation
        timerTask = timer
        lock.unlock()
    }

    func resolve(_ result: Result<Value, Error>, cancelOperation: Bool) {
        let continuation: CheckedContinuation<Value, Error>?
        let tasks: (Task<Void, Never>?, Task<Void, Never>?)
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        continuation = self.continuation
        self.continuation = nil
        tasks = (operationTask, timerTask)
        operationTask = nil
        timerTask = nil
        lock.unlock()

        if cancelOperation { tasks.0?.cancel() }
        tasks.1?.cancel()
        continuation?.resume(with: result)
    }

    func cancel() { resolve(.failure(CancellationError()), cancelOperation: true) }
}

private func hqMQTTWithTimeout<Value: Sendable>(
    nanoseconds: UInt64,
    sleep: @escaping @Sendable (UInt64) async throws -> Void,
    operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
    let race = HQMQTTTimeoutRace<Value>()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            race.install(continuation)
            let operationTask = Task {
                do { race.resolve(.success(try await operation()), cancelOperation: false) }
                catch { race.resolve(.failure(error), cancelOperation: false) }
            }
            let timerTask = Task {
                do {
                    try await sleep(nanoseconds)
                    race.resolve(
                        .failure(HQRealtimeClientError.operationTimedOut),
                        cancelOperation: true
                    )
                } catch {
                    if !Task.isCancelled {
                        race.resolve(.failure(error), cancelOperation: true)
                    }
                }
            }
            race.installTasks(operation: operationTask, timer: timerTask)
        }
    } onCancel: {
        race.cancel()
    }
}

final class HQURLSessionMQTTConnector: HQMQTTConnecting, Sendable {
    typealias Sleep = @Sendable (UInt64) async throws -> Void

    private let factory: any HQWebSocketCreating
    private let limits: HQMQTTProtocolLimits
    private let operationTimeoutNanoseconds: UInt64
    private let sleep: Sleep

    init(factory: any HQWebSocketCreating = HQURLSessionWebSocketFactory(),
         limits: HQMQTTProtocolLimits = .production,
         operationTimeoutNanoseconds: UInt64 = 10_000_000_000,
         sleep: @escaping Sleep = { try await Task.sleep(nanoseconds: $0) }) {
        self.factory = factory
        self.limits = limits
        self.operationTimeoutNanoseconds = operationTimeoutNanoseconds
        self.sleep = sleep
    }

    func connect(url: URL, clientID: String, keepAliveSeconds: UInt16) async throws -> any HQMQTTSession {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "wss", components.host != nil,
              components.user == nil, components.password == nil, components.port == nil,
              components.path == "/mqtt", components.query != nil, components.fragment == nil
        else { throw HQRealtimeClientError.invalidEndpoint }

        let socket = factory.makeWebSocket(url: url, subprotocols: ["mqtt"])
        await socket.resume()
        let session = HQURLSessionMQTTSession(
            socket: socket,
            keepAliveSeconds: keepAliveSeconds,
            limits: limits,
            operationTimeoutNanoseconds: operationTimeoutNanoseconds,
            sleep: sleep
        )
        do {
            try await hqMQTTWithTimeout(
                nanoseconds: operationTimeoutNanoseconds,
                sleep: sleep
            ) {
                try await session.establish(clientID: clientID)
            }
            return session
        } catch {
            await session.disconnect()
            throw error
        }
    }
}

actor HQURLSessionMQTTSession: HQMQTTSession {
    typealias Sleep = @Sendable (UInt64) async throws -> Void

    private struct SeenWake: Equatable, Sendable {
        let topic: String
        let envelope: HQRealtimeWakeEnvelope
    }

    private let socket: any HQWebSocketTransport
    private let keepAliveSeconds: UInt16
    private let limits: HQMQTTProtocolLimits
    private let operationTimeoutNanoseconds: UInt64
    private let sleep: Sleep
    private var inputBuffer = Data()
    private var subscribedTopics = Set<String>()
    private var expectedRecipient: String?
    private var keepAliveTask: Task<Void, Never>?
    private var awaitingPingResponse = false
    private var terminalError: HQRealtimeClientError?
    private var disconnected = false
    private var seenByEventID: [UUID: SeenWake] = [:]
    private var seenOrder: [UUID] = []

    init(socket: any HQWebSocketTransport, keepAliveSeconds: UInt16,
         limits: HQMQTTProtocolLimits = .production,
         operationTimeoutNanoseconds: UInt64 = 10_000_000_000,
         sleep: @escaping Sleep = { try await Task.sleep(nanoseconds: $0) }) {
        self.socket = socket
        self.keepAliveSeconds = keepAliveSeconds
        self.limits = limits
        self.operationTimeoutNanoseconds = operationTimeoutNanoseconds
        self.sleep = sleep
    }

    func establish(clientID: String) async throws {
        do {
            let connect = try HQMQTTWireCodec.connect(
                clientID: clientID,
                keepAliveSeconds: keepAliveSeconds
            )
            try await socket.send(connect)
            guard case let .connAck(sessionPresent, returnCode) = try await readPacket(),
                  !sessionPresent, returnCode == 0
            else { throw HQRealtimeClientError.brokerRejected }
            guard await socket.negotiatedSubprotocol() == "mqtt" else {
                throw HQRealtimeClientError.invalidWebSocketSubprotocol
            }
            startKeepAlive()
        } catch {
            await terminate()
            throw error
        }
    }

    func subscribe(topics: [String], qos: UInt8) async throws {
        do {
            try await hqMQTTWithTimeout(
                nanoseconds: operationTimeoutNanoseconds,
                sleep: sleep
            ) { [weak self] in
                guard let self else { throw CancellationError() }
                try await self.performSubscribe(topics: topics, qos: qos)
            }
        } catch {
            await terminate()
            throw error
        }
    }

    func nextWake() async throws -> HQRealtimeWake? {
        do {
            if let terminalError { throw terminalError }
            guard !disconnected, let expectedRecipient else {
                throw HQRealtimeClientError.invalidMQTTPacket
            }
            while !Task.isCancelled {
                switch try await readPacket() {
                case .pingResponse:
                    awaitingPingResponse = false
                case let .publish(topic, packetID, payload):
                    guard subscribedTopics.contains(topic) else {
                        throw HQRealtimeClientError.invalidMQTTPacket
                    }
                    let envelope = try HQRealtimeWakeEnvelopeDecoder.decode(
                        payload,
                        expectedRecipient: expectedRecipient
                    )
                    // The deployed v2 boundary intentionally leaves eventType
                    // forward-compatible. Recipient and subscribed-topic checks
                    // provide the trust boundary; the payload only triggers REST.
                    try await boundedSend(HQMQTTWireCodec.pubAck(packetID: packetID))
                    let seen = SeenWake(topic: topic, envelope: envelope)
                    if let previous = seenByEventID[envelope.eventID] {
                        guard previous == seen else {
                            throw HQRealtimeClientError.duplicateWakeConflict
                        }
                        continue
                    }
                    remember(seen, eventID: envelope.eventID)
                    return HQRealtimeWake(topic: topic, envelope: envelope)
                default:
                    throw HQRealtimeClientError.unsupportedMQTTPacket
                }
            }
            throw CancellationError()
        } catch is CancellationError {
            if let terminalError { throw terminalError }
            throw CancellationError()
        } catch {
            await terminate(error: error as? HQRealtimeClientError)
            throw error
        }
    }

    func disconnect() async { await terminate() }

    private func performSubscribe(topics: [String], qos: UInt8) async throws {
        let recipient = try Self.sharedRecipient(
            in: topics,
            maximumTopicBytes: limits.maximumTopicBytes
        )
        let packetID: UInt16 = 1
        try await socket.send(try HQMQTTWireCodec.subscribe(
            packetID: packetID,
            topics: topics,
            qos: qos,
            limits: limits
        ))
        guard case let .subAck(receivedID, returnCodes) = try await readPacket(),
              receivedID == packetID,
              returnCodes.count == topics.count,
              returnCodes.allSatisfy({ $0 == qos })
        else { throw HQRealtimeClientError.brokerRejected }
        subscribedTopics = Set(topics)
        expectedRecipient = recipient
    }

    private func boundedSend(_ data: Data) async throws {
        let socket = self.socket
        try await hqMQTTWithTimeout(nanoseconds: operationTimeoutNanoseconds, sleep: sleep) {
            try await socket.send(data)
        }
    }

    private func readPacket() async throws -> HQMQTTInboundPacket {
        while true {
            if let packet = try HQMQTTWireCodec.decodeNext(from: &inputBuffer, limits: limits) {
                return packet
            }
            switch try await socket.receive() {
            case let .data(data):
                guard !data.isEmpty else { throw HQRealtimeClientError.invalidMQTTPacket }
                inputBuffer += data
                guard inputBuffer.count <= (limits.maximumPacketBytes + 5) * 2 else {
                    throw HQRealtimeClientError.packetTooLarge
                }
            case .text:
                throw HQRealtimeClientError.unsupportedMQTTPacket
            }
        }
    }

    private func startKeepAlive() {
        keepAliveTask?.cancel()
        keepAliveTask = Task { [weak self] in await self?.keepAliveLoop() }
    }

    private func keepAliveLoop() async {
        let interval = UInt64(keepAliveSeconds) * 1_000_000_000
        while !Task.isCancelled, !disconnected {
            do { try await sleep(interval) } catch { return }
            guard !Task.isCancelled, !disconnected else { return }
            if awaitingPingResponse {
                await terminate(error: .pingTimedOut)
                return
            }
            awaitingPingResponse = true
            do {
                try await boundedSend(HQMQTTWireCodec.pingRequest)
            } catch {
                awaitingPingResponse = false
                await terminate(error: error as? HQRealtimeClientError ?? .pingTimedOut)
                return
            }
        }
    }

    private func remember(_ wake: SeenWake, eventID: UUID) {
        seenByEventID[eventID] = wake
        seenOrder.append(eventID)
        while seenOrder.count > limits.maximumRememberedEvents, let oldest = seenOrder.first {
            seenOrder.removeFirst()
            seenByEventID.removeValue(forKey: oldest)
        }
    }

    private func terminate(error: HQRealtimeClientError? = nil) async {
        if terminalError == nil { terminalError = error }
        guard !disconnected else { return }
        disconnected = true
        let keepAlive = keepAliveTask
        keepAliveTask = nil
        keepAlive?.cancel()
        await socket.cancel()
    }

    private static func sharedRecipient(in topics: [String],
                                        maximumTopicBytes: Int) throws -> String {
        guard !topics.isEmpty else { throw HQRealtimeClientError.invalidMQTTPacket }
        let requiredLeaves: Set<String> = ["dm", "sessions", "work", "notifications"]
        guard topics.count == requiredLeaves.count else {
            throw HQRealtimeClientError.invalidMQTTPacket
        }
        var recipient: String?
        var leaves = Set<String>()
        for topic in topics {
            guard topic.utf8.count <= maximumTopicBytes,
                  !topic.contains("#"), !topic.contains("+")
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            let components = topic.split(separator: "/", omittingEmptySubsequences: false)
            guard components.count == 3, components[0] == "hq",
                  requiredLeaves.contains(String(components[2]))
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            let candidate = String(components[1])
            guard candidate.range(
                of: "^(?:prs|agt)_[0-9A-HJKMNP-TV-Z]{26}$",
                options: .regularExpression
            ) == candidate.startIndex ..< candidate.endIndex,
                recipient == nil || recipient == candidate
            else { throw HQRealtimeClientError.invalidMQTTPacket }
            recipient = candidate
            leaves.insert(String(components[2]))
        }
        guard leaves == requiredLeaves, let recipient else {
            throw HQRealtimeClientError.invalidMQTTPacket
        }
        return recipient
    }

}
