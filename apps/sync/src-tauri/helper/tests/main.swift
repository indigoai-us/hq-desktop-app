import Cocoa
import Foundation

private struct VisualState {
    let name: String
    let appearance: NSAppearance.Name
    let highlighted: Bool
}

private final class BadgeHarnessHost: NSView {
    let highlighted: Bool

    init(frame frameRect: NSRect, highlighted: Bool) {
        self.highlighted = highlighted
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark =
            effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let white: CGFloat
        if highlighted {
            white = isDark ? 0.34 : 0.68
        } else {
            white = isDark ? 0.12 : 0.92
        }
        NSColor(calibratedWhite: white, alpha: 1).setFill()
        dirtyRect.fill()
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}

private func expectedLabel(for count: Int) -> String {
    if count <= 0 { return "" }
    return count > 9 ? "9+" : String(count)
}

private func expectedAccessibilityLabel(for count: Int) -> String {
    if count == 1 { return "HQ, 1 item needs attention" }
    if count > 1 { return "HQ, \(count) items need attention" }
    return "HQ"
}

private func redPixelCount(in image: NSBitmapImageRep) -> Int {
    var count = 0
    for y in 0..<image.pixelsHigh {
        for x in 0..<image.pixelsWide {
            guard
                let color = image.colorAt(x: x, y: y)?
                    .usingColorSpace(.deviceRGB)
            else { continue }
            if color.redComponent > 0.75
                && color.greenComponent < 0.45
                && color.blueComponent < 0.45
                && color.alphaComponent > 0.5
            {
                count += 1
            }
        }
    }
    return count
}

private let states = [
    VisualState(name: "light", appearance: .aqua, highlighted: false),
    VisualState(name: "light-highlight", appearance: .aqua, highlighted: true),
    VisualState(name: "dark", appearance: .darkAqua, highlighted: false),
    VisualState(name: "dark-highlight", appearance: .darkAqua, highlighted: true),
]
private let unreadCounts = [0, 1, 10]
private let hostBounds = NSRect(x: 0, y: 0, width: 32, height: 22)
private var scenariosRun = 0

_ = NSApplication.shared

for state in states {
    guard let appearance = NSAppearance(named: state.appearance) else {
        FileHandle.standardError.write(
            Data("FAIL: missing \(state.name) appearance\n".utf8)
        )
        exit(1)
    }

    for count in unreadCounts {
        let host = BadgeHarnessHost(
            frame: hostBounds,
            highlighted: state.highlighted
        )
        host.appearance = appearance

        let expectedFrame = TrayBadgePresentation.frame(
            for: count,
            in: host.bounds
        )
        let badge = TrayBadgeView(frame: expectedFrame)
        badge.appearance = appearance
        badge.count = count
        host.addSubview(badge)

        require(
            TrayBadgePresentation.label(for: count) == expectedLabel(for: count),
            "\(state.name), count \(count): incorrect capped label"
        )
        require(
            TrayBadgePresentation.accessibilityLabel(for: count)
                == expectedAccessibilityLabel(for: count),
            "\(state.name), count \(count): incorrect full accessibility label"
        )
        require(
            badge.isHidden == (count == 0),
            "\(state.name), count \(count): visibility mismatch"
        )
        require(
            badge.frame == expectedFrame,
            "\(state.name), count \(count): badge geometry changed"
        )
        require(
            badge.hitTest(
                NSPoint(x: badge.bounds.midX, y: badge.bounds.midY)
            ) == nil,
            "\(state.name), count \(count): badge intercepted a click"
        )
        require(
            badge.isAccessibilityElement() == false,
            "\(state.name), count \(count): badge entered accessibility tree"
        )

        guard
            let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)
        else {
            FileHandle.standardError.write(
                Data("FAIL: \(state.name), count \(count): no bitmap\n".utf8)
            )
            exit(1)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let redPixels = redPixelCount(in: bitmap)
        require(
            count == 0 ? redPixels == 0 : redPixels > 20,
            "\(state.name), count \(count): rendered badge pixels mismatch"
        )

        scenariosRun += 1
    }
}

print("tray badge native verification passed (\(scenariosRun) scenarios)")

// ── hard-stop-readiness US-019: paused-uploads menu section ────────────────

private final class UpgradeTarget: NSObject {
    var commands: [String] = []
    @objc func upgrade(_ sender: NSMenuItem) {
        guard let company = sender.representedObject as? String else { return }
        commands.append(
            TrayUploadsPausedPresentation.upgradeCommand(
                for: .init(company: company, canUpgrade: true)))
    }
}

var pausedScenarios = 0
let snapshot = Data(
    #"{"uploadsPaused":[{"company":"Acme","canUpgrade":true},{"company":"Beta","canUpgrade":false},{"company":"Acme","canUpgrade":true},{"company":"  "},{"nope":1}]}"#
        .utf8)
let rows = TrayUploadsPausedPresentation.rows(from: snapshot)
require(
    rows == [.init(company: "Acme", canUpgrade: true), .init(company: "Beta", canUpgrade: false)],
    "paused rows: parse, dedupe, and drop blank companies"
)
pausedScenarios += 1
require(TrayUploadsPausedPresentation.rows(from: nil).isEmpty, "paused rows: missing file")
require(TrayUploadsPausedPresentation.rows(from: Data("{".utf8)).isEmpty, "paused rows: malformed")
require(TrayUploadsPausedPresentation.rows(from: Data(#"{"uploadsPaused":[]}"#.utf8)).isEmpty, "paused rows: empty")
pausedScenarios += 1

let menu = NSMenu()
menu.addItem(NSMenuItem(title: "Sync Now", action: nil, keyEquivalent: ""))
private let target = UpgradeTarget()
TrayUploadsPausedPresentation.apply(
    rows: rows, to: menu, target: target, action: #selector(UpgradeTarget.upgrade(_:)))
require(
    menu.items.map(\.title) == [
        "Uploads paused for Acme", "Upgrade plan for Acme…", "Uploads paused for Beta", "", "Sync Now",
    ],
    "paused menu: status + upgrade rows at the top, then a separator: \(menu.items.map(\.title))"
)
require(menu.items[0].isEnabled == false, "paused menu: status row is informational")
require(menu.items[3].isSeparatorItem, "paused menu: separator before the standard items")
pausedScenarios += 1

let upgradeItem = menu.items[1]
_ = (upgradeItem.target as? UpgradeTarget)?.perform(upgradeItem.action, with: upgradeItem)
require(target.commands == ["upgrade Acme"], "paused menu: upgrade asks the app by company name")
pausedScenarios += 1

TrayUploadsPausedPresentation.apply(
    rows: [], to: menu, target: target, action: #selector(UpgradeTarget.upgrade(_:)))
require(menu.items.map(\.title) == ["Sync Now"], "paused menu: cleared when uploads resume")
pausedScenarios += 1

require(
    TrayUploadsPausedPresentation.label(base: "HQ", rows: [rows[0]]) == "HQ · Uploads paused for Acme",
    "paused label: one company"
)
require(
    TrayUploadsPausedPresentation.label(base: "HQ, 1 item needs attention", rows: rows)
        == "HQ, 1 item needs attention · Uploads paused for 2 companies",
    "paused label: several companies"
)
require(TrayUploadsPausedPresentation.label(base: "HQ", rows: []) == "HQ", "paused label: none")
pausedScenarios += 1

print("tray uploads-paused native verification passed (\(pausedScenarios) scenarios)")
