import AppKit
import XCTest

@MainActor
final class HQNativeVisualTourUITests: XCTestCase {
    private struct Surface {
        enum Kind: String {
            case route
            case window
        }

        let kind: Kind
        let parityID: String
        let launchValue: String
        let readinessIdentifier: String
        let windowTitle: String
        let minimumWidth: Double
        let minimumHeight: Double

        func artifactName(variant: String) -> String {
            let stem = parityID
                .replacingOccurrences(of: "{slug}", with: "indigo")
                .replacingOccurrences(of: "{company}", with: "indigo")
                .replacingOccurrences(of: "{project}", with: "native-macos")
                .replacingOccurrences(of: "{task}", with: "NATIVE-004")
                .replacingOccurrences(of: ":", with: "--")
                .replacingOccurrences(of: "/", with: "-")
            return "\(variant)/\(kind.rawValue)--\(stem).png"
        }
    }

    private struct ImageMetrics: Codable {
        let pixelWidth: Int
        let pixelHeight: Int
        let byteCount: Int
        let luminanceRange: Double
        let luminanceStandardDeviation: Double
        let opaqueSampleRatio: Double
    }

    private struct CaptureRecord: Codable {
        let variant: String
        let kind: String
        let parityID: String
        let launchValue: String
        let readinessIdentifier: String
        let artifact: String
        let windowWidth: Double
        let windowHeight: Double
        let metrics: ImageMetrics?
        let passed: Bool
        let failures: [String]
    }

    private struct Manifest: Codable {
        let schemaVersion: Int
        let generatedAt: String
        let expectedRouteCount: Int
        let expectedWindowCount: Int
        let expectedVariantCount: Int
        let expectedCaptureCount: Int
        let actualCaptureCount: Int
        let complete: Bool
        let captures: [CaptureRecord]
    }

    private let variants = [
        "light",
        "dark",
        "light-reduced",
        "dark-reduced",
    ]

    private let routeSurfaces: [Surface] = [
        route("home", "home", "screen.home"),
        route("mission-control", "mission-control", "screen.mission-control"),
        route("inbox", "inbox", "screen.inbox"),
        route("meetings", "meetings", "screen.meetings"),
        route("marketplace", "marketplace", "screen.marketplace"),
        route("moderation", "moderation", "screen.moderation"),
        route("library:skills", "library:skills", "screen.library.skills"),
        route("library:workers", "library:workers", "screen.library.workers"),
        route("library:installed", "library:installed", "screen.library.installed"),
        route("library:profile", "library:profile", "screen.library.profile"),
        route(
            "files",
            "files:indigo:knowledge/briefs/positioning.md",
            "screen.files"
        ),
        route("settings:sync", "settings:sync", "screen.settings.sync"),
        route(
            "settings:notifications",
            "settings:notifications",
            "screen.settings.notifications"
        ),
        route("settings:widget", "settings:widget", "screen.settings.widget"),
        route("settings:updates", "settings:updates", "screen.settings.updates"),
        route("settings:general", "settings:general", "screen.settings.general"),
        route(
            "settings:meetings",
            "settings:meetings",
            "screen.settings.meetings"
        ),
        route(
            "company:{slug}:overview",
            "company:indigo:overview",
            "screen.company.overview"
        ),
        route(
            "company:{slug}:goals",
            "company:indigo:goals",
            "screen.company.goals"
        ),
        route(
            "company:{slug}:projects",
            "company:indigo:projects",
            "screen.company.projects"
        ),
        route(
            "company:{slug}:skills",
            "company:indigo:skills",
            "screen.company.skills"
        ),
        route(
            "company:{slug}:workers",
            "company:indigo:workers",
            "screen.company.workers"
        ),
        route(
            "company:{slug}:knowledge",
            "company:indigo:knowledge",
            "screen.company.knowledge"
        ),
        route(
            "company:{slug}:team",
            "company:indigo:team",
            "screen.company.team"
        ),
        route(
            "company:{slug}:activity",
            "company:indigo:activity",
            "screen.company.activity"
        ),
        route(
            "company:{slug}:deployments",
            "company:indigo:deployments",
            "screen.company.deployments"
        ),
        route(
            "company:{slug}:secrets",
            "company:indigo:secrets",
            "screen.company.secrets"
        ),
        route(
            "company:{slug}:settings",
            "company:indigo:settings",
            "screen.company.settings"
        ),
        route(
            "project:{company}:{project}",
            "project:indigo:native-macos",
            "screen.project"
        ),
        route(
            "task:{company}:{project}:{task}",
            "task:indigo:native-macos:NATIVE-004",
            "screen.task"
        ),
    ]

    private let windowSurfaces: [Surface] = [
        window("main", "HQ", "shell.root", 1_180, 760),
        window("menubar", "HQ", "window.menubar", 296, 360),
        window("onboarding", "Set up HQ", "window.onboarding", 780, 620),
        window("sign-in", "Sign in to HQ", "window.sign-in", 520, 440),
        window("recovery", "HQ Recovery", "window.recovery", 620, 460),
        window("meetings", "HQ Meetings", "window.meetings", 460, 600),
        window(
            "meeting-permissions",
            "Meeting Permissions",
            "window.meeting-permissions",
            640,
            700
        ),
        window("dm-detail", "Conversation", "window.dm-detail", 820, 640),
        window(
            "share-detail",
            "Shared with you",
            "window.share-detail",
            640,
            560
        ),
        window("messages", "Messages", "window.messages", 720, 560),
        window(
            "banner",
            "HQ Notification",
            "window.banner.direct-message",
            366,
            104
        ),
        window(
            "widget",
            "HQ Widget",
            "window.widget.expanded",
            340,
            480
        ),
        window("activity", "Recent Changes", "window.activity", 560, 460),
        window("drift", "HQ Core Changes", "window.drift", 560, 480),
        window("new-files", "New Files", "window.new-files", 500, 400),
        window(
            "notification-history",
            "Notifications",
            "window.notification-history",
            680,
            620
        ),
        window("settings", "HQ Settings", "window.settings", 760, 620),
    ]

    func testCaptureExhaustiveVisualTour() throws {
        guard let outputPath = ProcessInfo.processInfo.environment[
            "HQ_VISUAL_TOUR_OUTPUT_DIR"
        ], !outputPath.isEmpty else {
            throw XCTSkip(
                "Run scripts/native-visual-tour.mjs to provide an artifact directory."
            )
        }

        let outputURL = URL(fileURLWithPath: outputPath, isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputURL,
            withIntermediateDirectories: true
        )

        let variantFilter = ProcessInfo.processInfo.environment[
            "HQ_VISUAL_TOUR_VARIANT"
        ]
        let surfaceFilter = ProcessInfo.processInfo.environment[
            "HQ_VISUAL_TOUR_SURFACE"
        ]
        let selectedVariants = variants.filter {
            variantFilter == nil || variantFilter == $0
        }
        let selectedSurfaces = (routeSurfaces + windowSurfaces).filter {
            surfaceFilter == nil || surfaceFilter == $0.parityID
        }
        var records: [CaptureRecord] = []

        for variant in selectedVariants {
            let variantURL = outputURL.appendingPathComponent(
                variant,
                isDirectory: true
            )
            try FileManager.default.createDirectory(
                at: variantURL,
                withIntermediateDirectories: true
            )

            for surface in selectedSurfaces {
                XCTContext.runActivity(
                    named: "\(variant) \(surface.kind.rawValue) \(surface.parityID)"
                ) { _ in
                    records.append(
                        capture(
                            surface: surface,
                            variant: variant,
                            outputURL: outputURL
                        )
                    )
                }
            }
        }

        let isFullRun = variantFilter == nil && surfaceFilter == nil
        let expectedFullCount =
            variants.count * (routeSurfaces.count + windowSurfaces.count)
        let allPassed = records.allSatisfy(\.passed)
        let manifest = Manifest(
            schemaVersion: 1,
            generatedAt: ISO8601DateFormatter().string(from: Date()),
            expectedRouteCount: routeSurfaces.count,
            expectedWindowCount: windowSurfaces.count,
            expectedVariantCount: variants.count,
            expectedCaptureCount: isFullRun
                ? expectedFullCount
                : selectedVariants.count * selectedSurfaces.count,
            actualCaptureCount: records.count,
            complete: allPassed
                && records.count
                    == selectedVariants.count * selectedSurfaces.count,
            captures: records
        )
        let manifestName = isFullRun
            ? "manifest.json"
            : "manifest-filtered.json"
        let manifestURL = outputURL.appendingPathComponent(manifestName)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(manifest).write(to: manifestURL, options: .atomic)

        XCTAssertEqual(routeSurfaces.count, 30)
        XCTAssertEqual(windowSurfaces.count, 17)
        if isFullRun {
            XCTAssertEqual(records.count, 188)
        }
        XCTAssertTrue(
            allPassed,
            records
                .filter { !$0.passed }
                .map {
                    "\($0.variant) \($0.kind) \($0.parityID): "
                        + $0.failures.joined(separator: "; ")
                }
                .joined(separator: "\n")
        )
    }

    private func capture(
        surface: Surface,
        variant: String,
        outputURL: URL
    ) -> CaptureRecord {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-NSTreatUnknownArgumentsAsOpen",
            "NO",
            "--visual-tour",
            "--visual-variant",
            variant,
        ]
        switch surface.kind {
        case .route:
            app.launchArguments += ["--route", surface.launchValue]
        case .window where surface.launchValue != "main":
            app.launchArguments += ["--hq-scene", surface.launchValue]
        case .window:
            break
        }
        app.launch()
        app.activate()
        if !app.wait(for: .runningForeground, timeout: 5) {
            let relativePath = surface.artifactName(variant: variant)
            return CaptureRecord(
                variant: variant,
                kind: surface.kind.rawValue,
                parityID: surface.parityID,
                launchValue: surface.launchValue,
                readinessIdentifier: surface.readinessIdentifier,
                artifact: relativePath,
                windowWidth: 0,
                windowHeight: 0,
                metrics: nil,
                passed: false,
                failures: ["HQ did not become the foreground app after launch."]
            )
        }
        defer { app.terminate() }

        var failures: [String] = []
        let readiness = element(
            app,
            identifiedBy: surface.readinessIdentifier
        )
        if !readiness.waitForExistence(timeout: 10) {
            failures.append(
                "missing readiness identifier \(surface.readinessIdentifier)"
            )
        }

        let capturesBorderlessSurface =
            surface.kind == .window
                && ["banner", "widget"].contains(surface.parityID)
        let titledWindow = app.windows[surface.windowTitle].firstMatch
        let containingWindow = app.windows.allElementsBoundByIndex.first {
            element(
                $0,
                identifiedBy: surface.readinessIdentifier
            ).exists
        }
        let target = capturesBorderlessSurface
            ? readiness
            : (containingWindow ?? titledWindow)
        if !capturesBorderlessSurface,
           !target.waitForExistence(timeout: 10)
        {
            failures.append("missing full window titled \(surface.windowTitle)")
        }

        let relativePath = surface.artifactName(variant: variant)
        let artifactURL = outputURL.appendingPathComponent(relativePath)
        let frame = target.exists ? target.frame : .zero
        guard target.exists else {
            return CaptureRecord(
                variant: variant,
                kind: surface.kind.rawValue,
                parityID: surface.parityID,
                launchValue: surface.launchValue,
                readinessIdentifier: surface.readinessIdentifier,
                artifact: relativePath,
                windowWidth: frame.width,
                windowHeight: frame.height,
                metrics: nil,
                passed: false,
                failures: failures
            )
        }

        let screenshot = target.screenshot()
        let png = screenshot.pngRepresentation
        do {
            try png.write(to: artifactURL, options: .atomic)
        } catch {
            failures.append("could not write PNG: \(error.localizedDescription)")
        }

        let metrics = imageMetrics(for: png)
        if frame.width < surface.minimumWidth * 0.80 {
            failures.append(
                "window width \(Int(frame.width)) is below expected "
                    + "\(Int(surface.minimumWidth))pt surface"
            )
        }
        if frame.height < surface.minimumHeight * 0.80 {
            failures.append(
                "window height \(Int(frame.height)) is below expected "
                    + "\(Int(surface.minimumHeight))pt surface"
            )
        }
        if frame.width > surface.minimumWidth * 1.35 {
            failures.append(
                "window width \(Int(frame.width)) exceeds expected "
                    + "\(Int(surface.minimumWidth))pt surface"
            )
        }
        if frame.height > surface.minimumHeight * 1.35 {
            failures.append(
                "window height \(Int(frame.height)) exceeds expected "
                    + "\(Int(surface.minimumHeight))pt surface"
            )
        }
        if let metrics {
            if Double(metrics.pixelWidth) < frame.width * 0.95
                || Double(metrics.pixelHeight) < frame.height * 0.95
            {
                failures.append(
                    "PNG \(metrics.pixelWidth)x\(metrics.pixelHeight) is a crop "
                        + "of the \(Int(frame.width))x\(Int(frame.height))pt window"
                )
            }
            if metrics.byteCount < 8_000 {
                failures.append("PNG is suspiciously small at \(metrics.byteCount) bytes")
            }
            if metrics.luminanceRange < 24 {
                failures.append(
                    "luminance range \(metrics.luminanceRange) indicates a blank image"
                )
            }
            if metrics.luminanceStandardDeviation < 2 {
                failures.append(
                    "luminance deviation \(metrics.luminanceStandardDeviation) "
                        + "indicates a low-information image"
                )
            }
            if metrics.opaqueSampleRatio < 0.80 {
                failures.append(
                    "only \(metrics.opaqueSampleRatio) of samples are opaque"
                )
            }
        } else {
            failures.append("PNG could not be decoded")
        }

        return CaptureRecord(
            variant: variant,
            kind: surface.kind.rawValue,
            parityID: surface.parityID,
            launchValue: surface.launchValue,
            readinessIdentifier: surface.readinessIdentifier,
            artifact: relativePath,
            windowWidth: frame.width,
            windowHeight: frame.height,
            metrics: metrics,
            passed: failures.isEmpty,
            failures: failures
        )
    }

    private func imageMetrics(for data: Data) -> ImageMetrics? {
        guard let bitmap = NSBitmapImageRep(data: data),
              bitmap.pixelsWide > 0,
              bitmap.pixelsHigh > 0
        else {
            return nil
        }

        let xStep = max(1, bitmap.pixelsWide / 160)
        let yStep = max(1, bitmap.pixelsHigh / 120)
        var sampleCount = 0
        var opaqueCount = 0
        var minimumLuminance = Double.greatestFiniteMagnitude
        var maximumLuminance = -Double.greatestFiniteMagnitude
        var luminanceSum = 0.0
        var luminanceSquaredSum = 0.0

        for y in stride(from: 0, to: bitmap.pixelsHigh, by: yStep) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: xStep) {
                guard let color = bitmap.colorAt(x: x, y: y)?
                    .usingColorSpace(.deviceRGB)
                else {
                    continue
                }
                let luminance = 255 * (
                    0.2126 * color.redComponent
                        + 0.7152 * color.greenComponent
                        + 0.0722 * color.blueComponent
                )
                sampleCount += 1
                if color.alphaComponent >= 0.80 {
                    opaqueCount += 1
                }
                minimumLuminance = min(minimumLuminance, luminance)
                maximumLuminance = max(maximumLuminance, luminance)
                luminanceSum += luminance
                luminanceSquaredSum += luminance * luminance
            }
        }

        guard sampleCount > 0 else { return nil }
        let count = Double(sampleCount)
        let mean = luminanceSum / count
        let variance = max(0, luminanceSquaredSum / count - mean * mean)
        return ImageMetrics(
            pixelWidth: bitmap.pixelsWide,
            pixelHeight: bitmap.pixelsHigh,
            byteCount: data.count,
            luminanceRange: maximumLuminance - minimumLuminance,
            luminanceStandardDeviation: sqrt(variance),
            opaqueSampleRatio: Double(opaqueCount) / count
        )
    }

    private func element(
        _ root: XCUIElement,
        identifiedBy identifier: String
    ) -> XCUIElement {
        root.descendants(matching: .any)[identifier].firstMatch
    }

    private static func route(
        _ parityID: String,
        _ launchValue: String,
        _ readinessIdentifier: String
    ) -> Surface {
        Surface(
            kind: .route,
            parityID: parityID,
            launchValue: launchValue,
            readinessIdentifier: readinessIdentifier,
            windowTitle: "HQ",
            minimumWidth: 1_180,
            minimumHeight: 760
        )
    }

    private static func window(
        _ id: String,
        _ title: String,
        _ readinessIdentifier: String,
        _ width: Double,
        _ height: Double
    ) -> Surface {
        Surface(
            kind: .window,
            parityID: id,
            launchValue: id,
            readinessIdentifier: readinessIdentifier,
            windowTitle: title,
            minimumWidth: width,
            minimumHeight: height
        )
    }
}
