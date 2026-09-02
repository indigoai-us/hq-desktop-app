import Darwin
import Foundation

enum HQNDJSONFramingError: LocalizedError, Equatable, Sendable {
    case blankFrame
    case incompleteFrame

    var errorDescription: String? {
        switch self {
        case .blankFrame:
            "The HQ engine emitted an empty protocol frame."
        case .incompleteFrame:
            "The HQ engine stopped with an incomplete protocol frame."
        }
    }
}

struct HQNDJSONLineFramer: Sendable {
    private var buffer = Data()

    mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var frames: [Data] = []

        while let newline = buffer.firstIndex(of: 0x0A) {
            var frame = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)

            if frame.last == 0x0D {
                frame.removeLast()
            }
            guard !frame.isEmpty else {
                throw HQNDJSONFramingError.blankFrame
            }
            frames.append(frame)
        }

        return frames
    }

    mutating func finish() throws {
        guard buffer.isEmpty else {
            throw HQNDJSONFramingError.incompleteFrame
        }
    }
}

enum HQProcessEngineTransportError: LocalizedError, Equatable, Sendable {
    case executableMissing(String)
    case alreadyStarted
    case notStarted
    case outputReadFailed(String)

    var errorDescription: String? {
        switch self {
        case let .executableMissing(path):
            "The HQ engine executable is missing or not executable at \(path)."
        case .alreadyStarted:
            "The HQ engine process transport was started more than once."
        case .notStarted:
            "The HQ engine process transport has not been started."
        case let .outputReadFailed(message):
            "Reading HQ engine output failed: \(message)"
        }
    }
}

struct HQProcessStopPolicy: Equatable, Sendable {
    static let applicationDefault = HQProcessStopPolicy(
        standardInputEOFGraceNanoseconds: 4_000_000_000,
        terminationGraceNanoseconds: 1_000_000_000,
        killGraceNanoseconds: 500_000_000,
        pollIntervalNanoseconds: 10_000_000
    )

    let standardInputEOFGraceNanoseconds: UInt64
    let terminationGraceNanoseconds: UInt64
    let killGraceNanoseconds: UInt64
    let pollIntervalNanoseconds: UInt64
}

private final class HQProcessTerminationObserver: @unchecked Sendable {
    private let lock = NSLock()
    private var terminated = false

    var hasTerminated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return terminated
    }

    func markTerminated() {
        lock.lock()
        terminated = true
        lock.unlock()
    }
}

actor HQProcessEngineTransport: HQEngineTransport {
    private let executableURL: URL
    private let arguments: [String]
    private let environment: [String: String]?
    private let currentDirectoryURL: URL?
    private let stopPolicy: HQProcessStopPolicy
    private let stream: AsyncThrowingStream<Data, Error>
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation

    private var process: Process?
    private var processTerminationObserver: HQProcessTerminationObserver?
    private var inputHandle: FileHandle?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var outputTask: Task<Void, Never>?
    private var errorTask: Task<Void, Never>?
    private var framer = HQNDJSONLineFramer()
    private var isFinished = false

    init(
        executableURL: URL,
        arguments: [String] = [],
        environment: [String: String]? = nil,
        currentDirectoryURL: URL? = nil,
        stopPolicy: HQProcessStopPolicy = .applicationDefault
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.environment = environment
        self.currentDirectoryURL = currentDirectoryURL
        self.stopPolicy = stopPolicy

        var captured: AsyncThrowingStream<Data, Error>.Continuation?
        stream = AsyncThrowingStream { captured = $0 }
        continuation = captured!
    }

    static func bundled(bundle: Bundle = .main) throws -> HQProcessEngineTransport {
        guard let executableURL = bundle.url(
            forAuxiliaryExecutable: "hq-engine-sidecar"
        ) else {
            throw HQProcessEngineTransportError.executableMissing(
                "Contents/MacOS/hq-engine-sidecar"
            )
        }
        return HQProcessEngineTransport(executableURL: executableURL)
    }

    func start() async throws -> AsyncThrowingStream<Data, Error> {
        guard process == nil else {
            throw HQProcessEngineTransportError.alreadyStarted
        }
        guard FileManager.default.isExecutableFile(
            atPath: executableURL.path
        ) else {
            throw HQProcessEngineTransportError.executableMissing(
                executableURL.path
            )
        }

        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        let terminationObserver = HQProcessTerminationObserver()
        process.terminationHandler = { _ in
            terminationObserver.markTerminated()
        }
        if let environment {
            process.environment = environment
        }
        process.currentDirectoryURL = currentDirectoryURL

        try process.run()
        self.process = process
        processTerminationObserver = terminationObserver
        inputHandle = inputPipe.fileHandleForWriting
        outputHandle = outputPipe.fileHandleForReading
        errorHandle = errorPipe.fileHandleForReading

        let stdout = outputPipe.fileHandleForReading
        outputTask = Task.detached { [weak self, stdout] in
            while !Task.isCancelled {
                let data = stdout.availableData
                guard !data.isEmpty else { break }
                guard let self else { return }
                await self.receiveOutput(data)
            }
            guard let self else { return }
            await self.outputEnded()
        }

        let stderr = errorPipe.fileHandleForReading
        errorTask = Task.detached { [stderr] in
            while !Task.isCancelled {
                let data = stderr.availableData
                guard !data.isEmpty else { break }
            }
        }

        return stream
    }

    func send(_ data: Data) async throws {
        guard let inputHandle else {
            throw HQProcessEngineTransportError.notStarted
        }
        try inputHandle.write(contentsOf: data)
    }

    func stop() async {
        try? inputHandle?.close()
        inputHandle = nil
        var canReleaseProcess = process == nil

        if let process {
            let terminationObserver = processTerminationObserver
            var didExit = await waitForExit(
                process,
                terminationObserver: terminationObserver,
                timeoutNanoseconds:
                    stopPolicy.standardInputEOFGraceNanoseconds,
                honorCancellation: true
            )

            if !didExit,
               !processHasExited(
                    process,
                    terminationObserver: terminationObserver
               )
            {
                process.terminate()
                didExit = await waitForExit(
                    process,
                    terminationObserver: terminationObserver,
                    timeoutNanoseconds:
                        stopPolicy.terminationGraceNanoseconds,
                    honorCancellation: true
                )
            }

            if !didExit,
               !processHasExited(
                    process,
                    terminationObserver: terminationObserver
               )
            {
                let killResult = Darwin.kill(
                    process.processIdentifier,
                    SIGKILL
                )
                let killError = errno
                if killResult == -1, killError == ESRCH {
                    didExit = true
                } else {
                    didExit = await waitForExit(
                        process,
                        terminationObserver: terminationObserver,
                        timeoutNanoseconds:
                            stopPolicy.killGraceNanoseconds,
                        honorCancellation: false
                    )
                }
            }
            canReleaseProcess = didExit || processHasExited(
                process,
                terminationObserver: terminationObserver
            )
        }

        try? outputHandle?.close()
        try? errorHandle?.close()

        outputTask?.cancel()
        errorTask?.cancel()
        await outputTask?.value
        await errorTask?.value
        outputTask = nil
        errorTask = nil

        outputHandle = nil
        errorHandle = nil
        if canReleaseProcess {
            process = nil
            processTerminationObserver = nil
        }
        finish()
    }

    private func waitForExit(
        _ process: Process,
        terminationObserver: HQProcessTerminationObserver?,
        timeoutNanoseconds: UInt64,
        honorCancellation: Bool
    ) async -> Bool {
        guard !processHasExited(
            process,
            terminationObserver: terminationObserver
        ) else {
            return true
        }

        let now = DispatchTime.now().uptimeNanoseconds
        let (deadline, overflow) = now.addingReportingOverflow(
            timeoutNanoseconds
        )
        let resolvedDeadline = overflow ? UInt64.max : deadline

        while !processHasExited(
            process,
            terminationObserver: terminationObserver
        ) {
            if honorCancellation, Task.isCancelled {
                return false
            }

            let current = DispatchTime.now().uptimeNanoseconds
            guard current < resolvedDeadline else {
                return processHasExited(
                    process,
                    terminationObserver: terminationObserver
                )
            }
            let remaining = resolvedDeadline - current
            let interval = min(
                max(stopPolicy.pollIntervalNanoseconds, 1),
                remaining
            )

            if Task.isCancelled {
                await sleepIgnoringCancellation(nanoseconds: interval)
            } else {
                do {
                    try await Task.sleep(nanoseconds: interval)
                } catch {
                    if honorCancellation {
                        return false
                    }
                }
            }
        }
        return true
    }

    private func processHasExited(
        _ process: Process,
        terminationObserver: HQProcessTerminationObserver?
    ) -> Bool {
        terminationObserver?.hasTerminated == true || !process.isRunning
    }

    private func sleepIgnoringCancellation(nanoseconds: UInt64) async {
        await Task.detached {
            let microseconds = useconds_t(
                min(nanoseconds / 1_000, UInt64(useconds_t.max))
            )
            Darwin.usleep(max(microseconds, 1))
        }.value
    }

    private func receiveOutput(_ data: Data) {
        guard !isFinished else { return }
        do {
            for frame in try framer.append(data) {
                continuation.yield(frame)
            }
        } catch {
            finish(throwing: error)
        }
    }

    private func outputEnded() {
        guard !isFinished else { return }
        do {
            try framer.finish()
            finish()
        } catch {
            finish(throwing: error)
        }
    }

    private func outputFailed(_ error: Error) {
        finish(
            throwing: HQProcessEngineTransportError.outputReadFailed(
                error.localizedDescription
            )
        )
    }

    private func finish(throwing error: Error? = nil) {
        guard !isFinished else { return }
        isFinished = true
        if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
    }
}
