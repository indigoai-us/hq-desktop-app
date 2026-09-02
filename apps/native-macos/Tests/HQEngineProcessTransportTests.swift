import Darwin
import XCTest
@testable import HQNative

final class HQEngineProcessTransportTests: XCTestCase {
    func testLineFramerHandlesChunkBoundariesWithoutMergingFrames() throws {
        var framer = HQNDJSONLineFramer()

        XCTAssertEqual(
            try framer.append(Data(#"{"id":"one"}"#.utf8)),
            []
        )
        XCTAssertEqual(
            try framer.append(Data("\n{\"id\":\"two\"}\n{\"id\":".utf8)),
            [
                Data(#"{"id":"one"}"#.utf8),
                Data(#"{"id":"two"}"#.utf8),
            ]
        )
        XCTAssertEqual(
            try framer.append(Data("\"three\"}\n".utf8)),
            [Data(#"{"id":"three"}"#.utf8)]
        )
        XCTAssertNoThrow(try framer.finish())
    }

    func testLineFramerRejectsBlankAndIncompleteFrames() throws {
        var blank = HQNDJSONLineFramer()
        XCTAssertThrowsError(try blank.append(Data("\n".utf8))) { error in
            XCTAssertEqual(error as? HQNDJSONFramingError, .blankFrame)
        }

        var incomplete = HQNDJSONLineFramer()
        _ = try incomplete.append(Data(#"{"id":"partial"}"#.utf8))
        XCTAssertThrowsError(try incomplete.finish()) { error in
            XCTAssertEqual(error as? HQNDJSONFramingError, .incompleteFrame)
        }
    }

    func testProcessTransportWritesStdinAndStreamsStdoutFrames() async throws {
        let transport = HQProcessEngineTransport(
            executableURL: URL(fileURLWithPath: "/bin/cat")
        )
        let stream = try await transport.start()
        var iterator = stream.makeAsyncIterator()

        let request = Data(
            #"{"id":"req-1","method":"health","params":{},"protocolVersion":1}"#
                .appending("\n")
                .utf8
        )
        try await transport.send(request)
        let response = try await iterator.next()

        XCTAssertEqual(
            response,
            Data(
                #"{"id":"req-1","method":"health","params":{},"protocolVersion":1}"#
                    .utf8
            )
        )
        await transport.stop()
    }

    func testProcessTransportRejectsMissingExecutable() async {
        let transport = HQProcessEngineTransport(
            executableURL: URL(
                fileURLWithPath: "/definitely-missing/hq-engine-sidecar"
            )
        )

        do {
            _ = try await transport.start()
            XCTFail("Expected launch to fail")
        } catch {
            XCTAssertEqual(
                error as? HQProcessEngineTransportError,
                .executableMissing(
                    "/definitely-missing/hq-engine-sidecar"
                )
            )
        }
    }

    func testStopEscalatesFromEOFToTermAndKillThenReapsProcess() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "hq-native-transport-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let executable = directory.appendingPathComponent("ignore-term.sh")
        let pidFile = directory.appendingPathComponent("sidecar.pid")
        try """
        #!/bin/sh
        trap '' TERM
        echo $$ > "$1"
        while :; do :; done
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )

        let transport = HQProcessEngineTransport(
            executableURL: executable,
            arguments: [pidFile.path],
            stopPolicy: HQProcessStopPolicy(
                standardInputEOFGraceNanoseconds: 20_000_000,
                terminationGraceNanoseconds: 20_000_000,
                killGraceNanoseconds: 200_000_000,
                pollIntervalNanoseconds: 2_000_000
            )
        )
        _ = try await transport.start()
        let pid = try await waitForProcessIdentifier(at: pidFile)
        defer {
            if unixProcessIsAlive(pid) {
                _ = Darwin.kill(pid, SIGKILL)
            }
        }

        let stopStartedAt = ContinuousClock.now
        await transport.stop()
        let stopDuration = stopStartedAt.duration(
            to: ContinuousClock.now
        )

        XCTAssertFalse(
            unixProcessIsAlive(pid),
            "stop() must wait until its force-killed child is reaped"
        )
        XCTAssertLessThan(
            stopDuration,
            .seconds(1),
            "stop() must not block after Foundation reports the child exited"
        )
    }

    func testStopHandlesExitBeforeFirstWaitAndIsIdempotent() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "hq-native-transport-early-exit-\(UUID().uuidString)",
                isDirectory: true
            )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let executable = directory.appendingPathComponent("exit-now.sh")
        let pidFile = directory.appendingPathComponent("sidecar.pid")
        try """
        #!/bin/sh
        echo $$ > "$1"
        exit 0
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )

        let transport = HQProcessEngineTransport(
            executableURL: executable,
            arguments: [pidFile.path],
            stopPolicy: HQProcessStopPolicy(
                standardInputEOFGraceNanoseconds: 20_000_000,
                terminationGraceNanoseconds: 20_000_000,
                killGraceNanoseconds: 20_000_000,
                pollIntervalNanoseconds: 1_000_000
            )
        )
        _ = try await transport.start()
        let pid = try await waitForProcessIdentifier(at: pidFile)
        try await waitForUnixProcessExit(pid)

        let firstStopStartedAt = ContinuousClock.now
        await transport.stop()
        XCTAssertLessThan(
            firstStopStartedAt.duration(to: ContinuousClock.now),
            .seconds(1),
            "stop() must observe a termination delivered before its first wait"
        )
        XCTAssertFalse(unixProcessIsAlive(pid))

        let secondStopStartedAt = ContinuousClock.now
        await transport.stop()
        XCTAssertLessThan(
            secondStopStartedAt.duration(to: ContinuousClock.now),
            .seconds(1),
            "stop() must remain idempotent after complete cleanup"
        )
    }

    func testCancelledStopStillForceKillsAndReapsProcess() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "hq-native-transport-cancelled-\(UUID().uuidString)",
                isDirectory: true
            )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let executable = directory.appendingPathComponent("ignore-term.sh")
        let pidFile = directory.appendingPathComponent("sidecar.pid")
        try """
        #!/bin/sh
        trap '' TERM
        echo $$ > "$1"
        while :; do :; done
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )

        let transport = HQProcessEngineTransport(
            executableURL: executable,
            arguments: [pidFile.path],
            stopPolicy: HQProcessStopPolicy(
                standardInputEOFGraceNanoseconds: 20_000_000,
                terminationGraceNanoseconds: 20_000_000,
                killGraceNanoseconds: 200_000_000,
                pollIntervalNanoseconds: 2_000_000
            )
        )
        _ = try await transport.start()
        let pid = try await waitForProcessIdentifier(at: pidFile)
        defer {
            if unixProcessIsAlive(pid) {
                _ = Darwin.kill(pid, SIGKILL)
            }
        }

        let stopStartedAt = ContinuousClock.now
        let stopTask = Task {
            await transport.stop()
        }
        stopTask.cancel()
        await stopTask.value

        XCTAssertLessThan(
            stopStartedAt.duration(to: ContinuousClock.now),
            .seconds(1),
            "cancellation must accelerate escalation without skipping bounded SIGKILL cleanup"
        )
        XCTAssertFalse(
            unixProcessIsAlive(pid),
            "a canceled stop task must still reap its force-killed child"
        )
    }

    func testRepeatedEOFExitBoundariesAlwaysFinishAndReap() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "hq-native-transport-repeat-\(UUID().uuidString)",
                isDirectory: true
            )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let executable = directory.appendingPathComponent("exit-on-eof.sh")
        try """
        #!/bin/sh
        echo $$ > "$1"
        exec /bin/cat >/dev/null
        """.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )

        for iteration in 0..<25 {
            let pidFile = directory.appendingPathComponent(
                "sidecar-\(iteration).pid"
            )
            let transport = HQProcessEngineTransport(
                executableURL: executable,
                arguments: [pidFile.path],
                stopPolicy: HQProcessStopPolicy(
                    standardInputEOFGraceNanoseconds: 100_000_000,
                    terminationGraceNanoseconds: 20_000_000,
                    killGraceNanoseconds: 100_000_000,
                    pollIntervalNanoseconds: 1_000_000
                )
            )
            _ = try await transport.start()
            let pid = try await waitForProcessIdentifier(at: pidFile)
            defer {
                if unixProcessIsAlive(pid) {
                    _ = Darwin.kill(pid, SIGKILL)
                }
            }

            await transport.stop()

            XCTAssertFalse(
                unixProcessIsAlive(pid),
                "EOF iteration \(iteration) left its child alive"
            )
        }
    }

    func testClosingTransportInputLetsSidecarReapOwnedLongChild() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "hq-native-sidecar-eof-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let pidFile = directory.appendingPathComponent("managed.pid")
        let transport = try HQProcessEngineTransport.bundled()
        let client = HQEngineClient(transport: transport)
        _ = try await client.start()
        _ = try await client.request(
            "spawn_process",
            params: .object([
                "args": .object([
                    "cmd": .string("/bin/sh"),
                    "args": .array([
                        .string("-c"),
                        .string(
                            "echo $$ > \"$1\"; exec /bin/sleep 30"
                        ),
                        .string("hq-native-sidecar-test"),
                        .string(pidFile.path),
                    ]),
                    "cwd": .string(directory.path),
                ]),
            ])
        )
        let pid = try await waitForProcessIdentifier(at: pidFile)
        defer {
            if unixProcessIsAlive(pid) {
                _ = Darwin.kill(-pid, SIGKILL)
            }
        }

        await client.stop()

        XCTAssertFalse(
            unixProcessIsAlive(pid),
            "sidecar EOF shutdown must reap every process owned by its engine"
        )
    }

    func testBundledSidecarCompletesHandshakeHealthAndShutdown() async throws {
        let transport = try HQProcessEngineTransport.bundled()
        let client = HQEngineClient(
            transport: transport,
            makeRequestID: {
                UUID().uuidString.lowercased()
            }
        )

        let handshake = try await client.start()
        guard case let .object(handshakeFields) = handshake else {
            return XCTFail("Expected an object handshake")
        }
        XCTAssertEqual(
            handshakeFields["engineVersion"],
            .string("0.1.0")
        )

        let health = try await client.request("health")
        guard case let .object(healthFields) = health else {
            return XCTFail("Expected an object health response")
        }
        XCTAssertEqual(healthFields["healthy"], .bool(true))
        XCTAssertEqual(healthFields["protocolVersion"], .number(1))

        let shutdown = try await client.request("shutdown")
        XCTAssertEqual(
            shutdown,
            .object(["accepted": .bool(true)])
        )
        await client.stop()
    }
}

private enum HQProcessTransportTestError: Error {
    case processDidNotPublishPID(String)
    case processDidNotExit(pid_t)
}

private func waitForProcessIdentifier(at url: URL) async throws -> pid_t {
    let deadline = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < deadline {
        if let value = try? String(contentsOf: url, encoding: .utf8),
           let pid = pid_t(value.trimmingCharacters(in: .whitespacesAndNewlines))
        {
            return pid
        }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw HQProcessTransportTestError.processDidNotPublishPID(url.path)
}

private func waitForUnixProcessExit(_ pid: pid_t) async throws {
    let deadline = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < deadline {
        if !unixProcessIsAlive(pid) {
            return
        }
        try await Task.sleep(for: .milliseconds(5))
    }
    throw HQProcessTransportTestError.processDidNotExit(pid)
}

private func unixProcessIsAlive(_ pid: pid_t) -> Bool {
    Darwin.kill(pid, 0) == 0
}
