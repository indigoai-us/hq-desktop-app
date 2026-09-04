// HQ Sync menu-bar helper — a TINY standalone native AppKit process whose only
// job is to show the "HQ" menu-bar status item and relay clicks to the main app.
//
// WHY A SEPARATE PROCESS: on macOS Tahoe the main app's Tauri/tao runtime parks
// any NSStatusItem off-screen (verified on-device across every app version and
// both the tao tray and a native in-process item — while a clean AppKit process
// places its item correctly at a normal slot). This helper is that clean
// AppKit process.
//
// IPC is deliberately trivial + robust: the helper writes commands to
// ~/.hq/.tray-cmd; the main app atomically publishes the latest aggregate
// message count to ~/.hq/.tray-badge. No sockets, signals, or entitlements.
// The helper exits itself when the main app's PID (argv[1]) dies.
//
// Interaction matches a normal menu-bar app:
//   • LEFT-click  → open the popover (write "show" + activate the main app so
//                   the popover reliably comes to the front — without activation
//                   a background-launched app shows the window behind everything
//                   / lets the click-away handler swallow it).
//   • RIGHT-click → context menu (Sync Now / Quit).
//
// Build: swiftc -O hq-tray-helper.swift -o hq-tray-helper

import Cocoa
import Foundation

let hqPid: Int32 = CommandLine.arguments.count > 1 ? (Int32(CommandLine.arguments[1]) ?? 0) : 0
let cmdURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hq/.tray-cmd")
let badgeURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hq/.tray-badge")
private let hqTemplateImageBase64 = """
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
"""

func writeCommand(_ s: String) {
    try? FileManager.default.createDirectory(
        at: cmdURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? s.write(to: cmdURL, atomically: true, encoding: .utf8)
}

// Bring the main HQ app to the foreground so the popover it shows becomes the
// key window. The main app is a background "accessory" app; without this its
// freshly-shown popover renders behind other windows and the click-away handler
// hides it. Cross-process activation works because the helper is a normal app.
func activateHQ() {
    guard hqPid > 0, let app = NSRunningApplication(processIdentifier: hqPid) else { return }
    app.activate(options: [.activateIgnoringOtherApps])
}

func makeHQTemplateImage() -> NSImage? {
    let compactBase64 = hqTemplateImageBase64.filter { !$0.isWhitespace }
    guard let data = Data(base64Encoded: compactBase64), let image = NSImage(data: data) else {
        return nil
    }
    image.size = NSSize(width: 19, height: 11)
    image.isTemplate = true
    return image
}

/// Dropbox-style unread counter layered over the lower-right of the HQ mark.
/// Keeping this separate from the template image lets macOS recolor the mark
/// while the semantic notification badge retains its own color.
struct TrayBadgePresentation {
    static let compactWidth: CGFloat = 13
    static let expandedWidth: CGFloat = 17
    static let height: CGFloat = 13

    static func label(for count: Int) -> String {
        guard count > 0 else { return "" }
        return count > 9 ? "9+" : String(count)
    }

    static func frame(for count: Int, in buttonBounds: NSRect) -> NSRect {
        let width = count > 9 ? expandedWidth : compactWidth
        return NSRect(
            x: max(0, buttonBounds.maxX - width - 1),
            y: 0,
            width: width,
            height: height
        )
    }

    static func accessibilityLabel(for count: Int) -> String {
        if count == 1 {
            return "HQ, 1 item needs attention"
        }
        if count > 1 {
            return "HQ, \(count) items need attention"
        }
        return "HQ"
    }
}

final class TrayBadgeView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setAccessibilityElement(false)
    }

    var count = 0 {
        didSet {
            isHidden = count <= 0
            needsDisplay = true
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // The badge is visual only. The full status-item button remains the
        // target for both the popover click and the secondary menu.
        nil
    }

    override func draw(_ dirtyRect: NSRect) {
        guard count > 0 else { return }
        // Keep the overlay a corner badge instead of letting a three-character
        // label obscure the compact 19×11 HQ mark. VoiceOver and the tooltip
        // still expose the full uncapped count.
        let label = TrayBadgePresentation.label(for: count)
        let badgeRect = bounds.insetBy(dx: 0.5, dy: 0.5)

        NSColor.systemRed.setFill()
        NSBezierPath(
            roundedRect: badgeRect,
            xRadius: badgeRect.height / 2,
            yRadius: badgeRect.height / 2
        ).fill()

        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 8, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        let size = label.size(withAttributes: attributes)
        label.draw(
            at: NSPoint(
                x: floor((bounds.width - size.width) / 2),
                y: floor((bounds.height - size.height) / 2) - 0.5
            ),
            withAttributes: attributes
        )
    }
}

final class TrayController: NSObject {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    private let hasMark: Bool
    private let badgeView = TrayBadgeView(frame: .zero)
    private var lastBadgeSnapshot: String?

    override init() {
        let mark = makeHQTemplateImage()
        hasMark = mark != nil
        super.init()
        item.button?.title = "HQ"
        item.button?.toolTip = "HQ"
        item.button?.setAccessibilityLabel("HQ")
        if let mark {
            item.button?.image = mark
            item.button?.imagePosition = .imageOnly
        }
        badgeView.isHidden = true
        badgeView.setAccessibilityElement(false)
        item.button?.addSubview(badgeView, positioned: .above, relativeTo: nil)

        // Right-click context menu (NOT set as item.menu — that would make a
        // plain left-click open the menu instead of the popover). Items:
        // Sync Now / Open desktop view / Hide notifications / Check for
        // updates / Recovery / Sign Out / Quit HQ ⌘Q.
        let sync = NSMenuItem(title: "Sync Now", action: #selector(syncNow), keyEquivalent: "")
        sync.target = self
        menu.addItem(sync)
        let desktop = NSMenuItem(
            title: "Open desktop view", action: #selector(openDesktop), keyEquivalent: "")
        desktop.target = self
        menu.addItem(desktop)
        let hideNotes = NSMenuItem(
            title: "Hide notifications", action: #selector(hideNotifications), keyEquivalent: "")
        hideNotes.target = self
        menu.addItem(hideNotes)
        menu.addItem(.separator())
        let updates = NSMenuItem(
            title: "Check for updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        updates.target = self
        menu.addItem(updates)
        let recovery = NSMenuItem(
            title: "Recovery…", action: #selector(openRecovery), keyEquivalent: "")
        recovery.target = self
        menu.addItem(recovery)
        menu.addItem(.separator())
        let signOut = NSMenuItem(title: "Sign Out", action: #selector(signOutHQ), keyEquivalent: "")
        signOut.target = self
        menu.addItem(signOut)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit HQ", action: #selector(quitHQ), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        // Handle the click ourselves so left vs. right can diverge.
        item.button?.target = self
        item.button?.action = #selector(statusItemClicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        if let button = item.button {
            let area = NSTrackingArea(
                rect: button.bounds,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self,
                userInfo: nil)
            button.addTrackingArea(area)
        }
    }

    @objc func mouseEntered(_ event: NSEvent) {
        writeCommand("widget-peek")
    }

    func refreshBadge() {
        let snapshot =
            ((try? String(contentsOf: badgeURL, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)) ?? "0"
        guard snapshot != lastBadgeSnapshot else { return }
        lastBadgeSnapshot = snapshot
        applyUnreadCount(max(0, Int(snapshot) ?? 0))
    }

    private func applyUnreadCount(_ count: Int) {
        guard let button = item.button else { return }
        button.attributedTitle = NSAttributedString(string: "")
        button.title = hasMark ? "" : "HQ"
        button.imagePosition = hasMark ? .imageOnly : .noImage

        badgeView.frame = TrayBadgePresentation.frame(for: count, in: button.bounds)
        badgeView.count = count

        let attention = TrayBadgePresentation.accessibilityLabel(for: count)
        button.toolTip = attention
        button.setAccessibilityLabel(attention)
    }

    @objc func statusItemClicked() {
        let event = NSApp.currentEvent
        let isRight =
            event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true
        if isRight {
            // Show the context menu, then detach it so the next left-click again
            // triggers the action rather than re-opening the menu.
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else {
            // Report the icon's on-screen horizontal centre (Cocoa screen points)
            // so the main app can anchor the popover UNDER the icon instead of
            // guessing the top-right corner. -1 = unknown → main app falls back.
            let anchorX = item.button?.window?.frame.midX ?? -1
            writeCommand("show \(Int(anchorX.rounded()))")
            activateHQ()
        }
    }

    @objc func syncNow() { writeCommand("sync") }
    @objc func hideNotifications() { writeCommand("hide-notifications") }
    @objc func openDesktop() {
        writeCommand("desktop")
        activateHQ()
    }
    @objc func checkForUpdates() {
        writeCommand("updates")
        activateHQ()
    }
    @objc func openRecovery() {
        writeCommand("recovery")
        activateHQ()
    }
    @objc func signOutHQ() { writeCommand("signout") }
    @objc func quitHQ() {
        writeCommand("quit")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
    }
}

#if !HQ_TRAY_BADGE_HARNESS
    @main
    struct HQTrayHelperMain {
        static func main() {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let controller = TrayController()
            controller.refreshBadge()

            // Badge snapshots are tiny local state, not a second notification
            // poller. This timer only observes the app's latest atomic snapshot
            // and updates AppKit on the main run loop.
            Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { _ in
                controller.refreshBadge()
            }

            // Exit with the main HQ app so we never leave an orphan status item.
            if hqPid > 0 {
                Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
                    if kill(hqPid, 0) != 0 { NSApp.terminate(nil) }
                }
            }

            app.run()
        }
    }
#endif
