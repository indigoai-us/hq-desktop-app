import SwiftUI

extension HQBannerFixture {
    static func preview(for kind: HQBannerKind) -> HQBannerFixture {
        all.first(where: { $0.kind == kind }) ?? all[0]
    }
}

struct HQBannerWindowView: View {
    let fixture: HQBannerFixture
    let onAction: (String) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: fixture.symbolName)
                .font(.system(size: 22, weight: .medium))
                .frame(width: 32, height: 32)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(fixture.title)
                    .font(.headline)
                Text(fixture.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 8)

            Button(fixture.actionTitle) {
                onAction("banner.\(fixture.kind.rawValue).open")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("banner.\(fixture.kind.rawValue).action")

            Button {
                onAction("banner.\(fixture.kind.rawValue).dismiss")
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss notification")
            .accessibilityIdentifier("banner.\(fixture.kind.rawValue).dismiss")
        }
        .padding(14)
        .frame(width: 366)
        .frame(minHeight: 104)
        .hqAdaptiveGlassSurface(cornerRadius: 14, fallback: .regular)
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(.quaternary, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.banner.\(fixture.kind.rawValue)")
    }
}

struct HQBannerGalleryView: View {
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 12) {
            ForEach(HQBannerFixture.all) { fixture in
                HQBannerWindowView(fixture: fixture, onAction: onAction)
            }
        }
        .padding()
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.banner.gallery")
    }
}

struct HQWidgetWindowView: View {
    let sourceFixture: HQWidgetFixture
    let onModeChange: (HQWidgetMode) -> Void
    let onAction: (String) -> Void

    init(
        fixture: HQWidgetFixture,
        onModeChange: @escaping (HQWidgetMode) -> Void = { _ in },
        onAction: @escaping (String) -> Void
    ) {
        sourceFixture = fixture
        self.onModeChange = onModeChange
        self.onAction = onAction
    }

    private var mode: HQWidgetMode {
        sourceFixture.mode
    }

    private var fixture: HQWidgetFixture {
        HQWidgetFixture(
            mode: mode,
            headline: sourceFixture.headline,
            status: sourceFixture.status,
            recentItems: mode == .compact
                ? Array(sourceFixture.recentItems.prefix(2))
                : sourceFixture.recentItems,
            activity: mode == .compact ? [] : sourceFixture.activity
        )
    }

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(fixture.headline)
                        .font(mode == .compact ? .headline : .title3.weight(.semibold))
                    Text(fixture.status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "checkmark.circle")
                    .font(.title2)
                    .accessibilityLabel("HQ is current")
            }

            Picker(
                "Widget size",
                selection: Binding(
                    get: { sourceFixture.mode },
                    set: { newMode in
                        onModeChange(newMode)
                    }
                )
            ) {
                Text("Compact").tag(HQWidgetMode.compact)
                Text("Expanded").tag(HQWidgetMode.expanded)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("widget.mode")

            VStack(spacing: 4) {
                ForEach(fixture.recentItems) { row in
                    HStack(spacing: 10) {
                        Image(systemName: row.symbolName)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.title)
                                .font(.caption.weight(.medium))
                            Text(row.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let value = row.value {
                            Text(value)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(8)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("widget.\(mode.rawValue).row.\(row.id)")
                }
            }
            .padding(5)
            .hqAdaptiveGlassSurface(cornerRadius: 10, fallback: .thin)

            if mode == .expanded {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("RECENT ACTIVITY")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)

                    ForEach(fixture.activity) { activity in
                        HStack(alignment: .firstTextBaseline) {
                            Circle()
                                .fill(.secondary)
                                .frame(width: 5, height: 5)
                            Text(activity.title)
                                .font(.caption)
                                .lineLimit(1)
                            Spacer()
                            Text(activity.timestamp)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("widget.activity.\(activity.id)")
                    }
                }
            }

            HStack {
                Button {
                    onAction("customize")
                } label: {
                    Label("Customize", systemImage: "slider.horizontal.3")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier("widget.action.customize")

                Spacer()

                Button {
                    onAction("open")
                } label: {
                    Label("Open HQ", systemImage: "macwindow")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("widget.action.open")
            }
        }
        .padding(16)
        .frame(width: 340)
        .frame(minHeight: mode == .compact ? 250 : 480)
        .hqAdaptiveGlassSurface(cornerRadius: 18, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.widget.\(mode.rawValue)")
    }
}
