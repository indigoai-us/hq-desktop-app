import SwiftUI

struct HQSecondaryWindowView: View {
    let kind: HQSecondaryWindowKind
    let state: HQWindowContentState
    var messagesFixture: HQMessagesFixture?
    var bannerFixture: HQBannerFixture?
    var widgetFixture: HQWidgetFixture?
    let onDirectMessageReply: (String) -> Void
    let onMessageSelect: (HQMessagesSelectionRequest) -> Void
    let onMessageSend: (HQMessagesSendRequest) -> Void
    let onWidgetModeChange: (HQWidgetMode) -> Void
    let onAction: (String) -> Void

    init(
        kind: HQSecondaryWindowKind,
        state: HQWindowContentState,
        messagesFixture: HQMessagesFixture? = nil,
        bannerFixture: HQBannerFixture? = nil,
        widgetFixture: HQWidgetFixture? = nil,
        onDirectMessageReply: @escaping (String) -> Void = { _ in },
        onMessageSelect: @escaping (HQMessagesSelectionRequest) -> Void = {
            _ in
        },
        onMessageSend: @escaping (HQMessagesSendRequest) -> Void = { _ in },
        onWidgetModeChange: @escaping (HQWidgetMode) -> Void = { _ in },
        onAction: @escaping (String) -> Void
    ) {
        self.kind = kind
        self.state = state
        self.messagesFixture = messagesFixture
        self.bannerFixture = bannerFixture
        self.widgetFixture = widgetFixture
        self.onDirectMessageReply = onDirectMessageReply
        self.onMessageSelect = onMessageSelect
        self.onMessageSend = onMessageSend
        self.onWidgetModeChange = onWidgetModeChange
        self.onAction = onAction
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                HQWindowLoadingView(kind: kind)
            case let .empty(emptyState):
                HQWindowEmptyView(state: emptyState, kind: kind)
            case let .failure(failureState):
                HQWindowFailureView(
                    state: failureState,
                    kind: kind,
                    onRetry: { onAction("retry") }
                )
            case let .content(fixture):
                content(for: fixture)
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func content(for fixture: HQWindowFixture) -> some View {
        switch fixture.kind {
        case .menuBar:
            HQMenuBarPopoverView(fixture: fixture, onAction: onAction)
        case .onboarding:
            HQOnboardingWindowView(fixture: fixture, onAction: onAction)
        case .signIn:
            HQSignInWindowView(fixture: fixture, onAction: onAction)
        case .recovery:
            HQRecoveryWindowView(fixture: fixture, onAction: onAction)
        case .meetings:
            HQMeetingsWindowView(fixture: fixture, onAction: onAction)
        case .meetingPermissions:
            HQMeetingPermissionsWindowView(fixture: fixture, onAction: onAction)
        case .directMessageDetail:
            HQDirectMessageDetailWindowView(
                fixture: fixture,
                onAction: onAction,
                onReply: onDirectMessageReply
            )
        case .shareDetail:
            HQShareDetailWindowView(fixture: fixture, onAction: onAction)
        case .messages:
            if let messagesFixture {
                HQMessagesWindowView(
                    fixture: messagesFixture,
                    onAction: onAction,
                    onSelect: onMessageSelect,
                    onSend: onMessageSend
                )
            } else {
                HQCollectionWindowView(fixture: fixture, onAction: onAction)
            }
        case .banner:
            if let bannerFixture {
                HQBannerWindowView(
                    fixture: bannerFixture,
                    onAction: onAction
                )
            } else {
                HQCollectionWindowView(fixture: fixture, onAction: onAction)
            }
        case .widget:
            if let widgetFixture {
                HQWidgetWindowView(
                    fixture: widgetFixture,
                    onModeChange: onWidgetModeChange,
                    onAction: onAction
                )
            } else {
                HQCollectionWindowView(fixture: fixture, onAction: onAction)
            }
        case .settings:
            HQSettingsWindowView(fixture: fixture, onAction: onAction)
        case .activity,
             .drift,
             .newFiles,
             .notificationHistory:
            HQCollectionWindowView(fixture: fixture, onAction: onAction)
        }
    }
}

struct HQSecondaryWindowHost: View {
    @StateObject private var model: HQSecondaryWindowViewModel
    let bannerKind: HQBannerKind
    let widgetMode: HQWidgetMode
    let onAction: (String) -> Void

    init(
        kind: HQSecondaryWindowKind,
        initialState: HQWindowContentState? = nil,
        bannerKind: HQBannerKind = .directMessage,
        widgetMode: HQWidgetMode = .expanded,
        onAction: @escaping (String) -> Void
    ) {
        let state = initialState ?? .content(HQSecondaryWindowFixtures.fixture(for: kind))
        _model = StateObject(
            wrappedValue: HQSecondaryWindowViewModel(kind: kind, state: state)
        )
        self.bannerKind = bannerKind
        self.widgetMode = widgetMode
        self.onAction = onAction
    }

    var body: some View {
        HQSecondaryWindowView(
            kind: model.kind,
            state: model.state,
            messagesFixture: .preview,
            bannerFixture: .preview(for: bannerKind),
            widgetFixture: .preview(for: widgetMode)
        ) { actionID in
            if actionID == "retry" {
                model.presentFixture()
            }
            onAction(actionID)
        }
    }
}

private struct HQWindowLoadingView: View {
    let kind: HQSecondaryWindowKind

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Loading…")
                .font(.headline)
            Text("Preparing \(kind.rawValue.replacingOccurrences(of: "-", with: " ")).")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.\(kind.rawValue).state.loading")
    }
}

private struct HQWindowEmptyView: View {
    let state: HQWindowEmptyState
    let kind: HQSecondaryWindowKind

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.secondary)
            Text(state.title)
                .font(.title3.weight(.semibold))
            Text(state.message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.\(kind.rawValue).state.empty")
    }
}

private struct HQWindowFailureView: View {
    let state: HQWindowFailureState
    let kind: HQSecondaryWindowKind
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.secondary)
            Text("Something went wrong")
                .font(.title3.weight(.semibold))
            Text(state.message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)
            Button(state.retryTitle, action: onRetry)
                .buttonStyle(.bordered)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("window.\(kind.rawValue).action.retry")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.\(kind.rawValue).state.error")
    }
}

private struct HQWindowHeader: View {
    let fixture: HQWindowFixture
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: compact ? 10 : 14) {
            Image(systemName: fixture.symbolName)
                .font(.system(size: compact ? 20 : 28, weight: .medium))
                .frame(width: compact ? 26 : 38, height: compact ? 26 : 38)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(fixture.title)
                    .font(compact ? .headline : .title2.weight(.semibold))
                Text(fixture.subtitle)
                    .font(compact ? .caption : .subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("\(fixture.accessibilityIdentifier).header")
    }
}

private struct HQWindowRow: View {
    let row: HQWindowRowFixture
    let accessibilityPrefix: String
    var onSelect: (String) -> Void

    var body: some View {
        Button {
            onSelect(row.id)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: row.symbolName)
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 22)
                    .foregroundStyle(.primary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(row.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 8)

                if let value = row.value {
                    Text(value)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .padding(10)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(accessibilityPrefix).row.\(row.id)")
    }
}

private struct HQStaticWindowRow: View {
    let row: HQWindowRowFixture
    let accessibilityPrefix: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: row.symbolName)
                .font(.system(size: 15, weight: .medium))
                .frame(width: 22)
                .foregroundStyle(.primary)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                Text(row.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 8)

            if let value = row.value {
                Text(value)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
        }
        .padding(10)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("\(accessibilityPrefix).row.\(row.id)")
    }
}

private struct HQWindowActions: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        HStack {
            if let secondary = fixture.secondaryAction {
                Button {
                    onAction(secondary.id)
                } label: {
                    Label(secondary.title, systemImage: secondary.symbolName)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("\(fixture.accessibilityIdentifier).action.\(secondary.id)")
            }

            Spacer()

            if let primary = fixture.primaryAction {
                Button {
                    onAction(primary.id)
                } label: {
                    Label(primary.title, systemImage: primary.symbolName)
                }
                .buttonStyle(.bordered)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("\(fixture.accessibilityIdentifier).action.\(primary.id)")
            }
        }
    }
}

private struct HQMenuBarPopoverView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 10) {
            HQWindowHeader(fixture: fixture, compact: true)

            Divider()

            ScrollView {
                VStack(spacing: 2) {
                    ForEach(fixture.rows) { row in
                        if [
                            "settings",
                            "check-updates",
                            "sign-out",
                        ].contains(row.id) {
                            HQWindowRow(
                                row: row,
                                accessibilityPrefix:
                                    fixture.accessibilityIdentifier,
                                onSelect: onAction
                            )
                        } else {
                            HQStaticWindowRow(
                                row: row,
                                accessibilityPrefix:
                                    fixture.accessibilityIdentifier
                            )
                        }
                    }
                }
            }
            .frame(maxHeight: 235)
            .accessibilityIdentifier(
                "\(fixture.accessibilityIdentifier).actions"
            )

            Divider()

            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(14)
        .frame(width: 296)
        .frame(minHeight: 360)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQOnboardingWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 24) {
            HQWindowHeader(fixture: fixture)

            VStack(spacing: 0) {
                ForEach(Array(fixture.rows.enumerated()), id: \.element.id) { index, row in
                    let isComplete = row.value == "Done"
                    let isRunning = row.value == "Running"
                    HStack(alignment: .top, spacing: 14) {
                        VStack(spacing: 0) {
                            ZStack {
                                Circle()
                                    .fill(
                                        isComplete
                                            ? AnyShapeStyle(.primary)
                                            : AnyShapeStyle(.quaternary)
                                    )
                                    .frame(width: 28, height: 28)
                                if isComplete {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(.background)
                                } else if isRunning {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Text("\(index + 1)")
                                        .font(.caption.weight(.semibold))
                                }
                            }
                            if index < fixture.rows.count - 1 {
                                Rectangle()
                                    .fill(.quaternary)
                                    .frame(width: 1, height: 45)
                            }
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(row.title)
                                    .font(.headline)
                                Spacer()
                                if let value = row.value {
                                    Text(value)
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text(row.detail)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 3)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("\(fixture.accessibilityIdentifier).step.\(row.id)")
                }
            }
            .padding(18)
            .hqAdaptiveGlassSurface(cornerRadius: 12, fallback: .thin)

            Spacer()
            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(28)
        .frame(minWidth: 640, minHeight: 520)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQSignInWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: fixture.symbolName)
                .font(.system(size: 48, weight: .light))
            Text(fixture.title)
                .font(.title.weight(.semibold))
            Text(fixture.subtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            VStack(spacing: 4) {
                ForEach(fixture.rows) { row in
                    HQStaticWindowRow(
                        row: row,
                        accessibilityPrefix: fixture.accessibilityIdentifier
                    )
                }
            }
            .padding(6)
            .hqAdaptiveGlassSurface(cornerRadius: 12, fallback: .thin)
            .frame(maxWidth: 390)

            HQWindowActions(fixture: fixture, onAction: onAction)
                .frame(maxWidth: 390)
            Spacer()
        }
        .padding(28)
        .frame(minWidth: 480, minHeight: 400)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQRecoveryWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 20) {
            HQWindowHeader(fixture: fixture)

            ScrollView {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 12),
                        GridItem(.flexible(), spacing: 12),
                    ],
                    spacing: 12
                ) {
                    ForEach(fixture.rows) { row in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Image(systemName: row.symbolName)
                                    .font(.title3)
                                    .accessibilityHidden(true)
                                Spacer()
                                if let value = row.value {
                                    Text(value)
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text(row.title)
                                .font(.headline)
                            Text(row.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.leading)
                                .lineLimit(3)
                            Spacer(minLength: 0)
                        }
                        .frame(
                            maxWidth: .infinity,
                            minHeight: 105,
                            alignment: .topLeading
                        )
                        .padding(14)
                        .hqAdaptiveGlassSurface(
                            cornerRadius: 12,
                            fallback: .thin
                        )
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier(
                            "\(fixture.accessibilityIdentifier).stage.\(row.id)"
                        )
                    }
                }
            }
            .accessibilityIdentifier(
                "\(fixture.accessibilityIdentifier).stages"
            )

            Spacer()
            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(24)
        .frame(minWidth: 580, minHeight: 420)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQMeetingsWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    private var focusedRowID: String? {
        fixture.rows.first {
            $0.metadata["focused"]?.boolValue == true
        }?.id
    }

    var body: some View {
        VStack(spacing: 16) {
            HQWindowHeader(fixture: fixture)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(fixture.rows) { row in
                            if row.metadata["windowId"]?.stringValue != nil {
                                HQActiveMeetingRow(
                                    row: row,
                                    accessibilityPrefix:
                                        fixture.accessibilityIdentifier,
                                    onAction: onAction
                                )
                                .id(row.id)
                            } else {
                                HQStaticWindowRow(
                                    row: row,
                                    accessibilityPrefix:
                                        fixture.accessibilityIdentifier
                                )
                                .hqAdaptiveGlassSurface(
                                    cornerRadius: 10,
                                    fallback: .thin
                                )
                                .overlay {
                                    if row.metadata["focused"]?.boolValue
                                        == true
                                    {
                                        RoundedRectangle(cornerRadius: 10)
                                            .stroke(
                                                Color.accentColor,
                                                lineWidth: 2
                                            )
                                    }
                                }
                                .id(row.id)
                            }
                        }
                    }
                }
                .onAppear {
                    scrollToFocusedRow(using: proxy)
                }
                .onChange(of: focusedRowID) { _ in
                    scrollToFocusedRow(using: proxy)
                }
            }

            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(20)
        .frame(minWidth: 420, minHeight: 520)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }

    private func scrollToFocusedRow(using proxy: ScrollViewProxy) {
        guard let focusedRowID else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(focusedRowID, anchor: .center)
        }
    }
}

private struct HQMeetingCompanyOption: Identifiable {
    let id: String
    let name: String
}

private struct HQActiveMeetingRow: View {
    let row: HQWindowRowFixture
    let accessibilityPrefix: String
    let onAction: (String) -> Void
    @State private var selectedCompanyUID: String

    init(
        row: HQWindowRowFixture,
        accessibilityPrefix: String,
        onAction: @escaping (String) -> Void
    ) {
        self.row = row
        self.accessibilityPrefix = accessibilityPrefix
        self.onAction = onAction
        _selectedCompanyUID = State(
            initialValue: row.metadata["companyUid"]?.stringValue ?? ""
        )
    }

    private var windowID: String {
        row.metadata["windowId"]?.stringValue ?? ""
    }

    private var state: HQNativeMeetingState {
        row.metadata["state"]?.stringValue.flatMap(
            HQNativeMeetingState.init(rawValue:)
        ) ?? .detected
    }

    private var companies: [HQMeetingCompanyOption] {
        row.metadata["memberships"]?.arrayValue?.compactMap { value in
            guard let object = value.object,
                  let companyUID = object["companyUid"]?.stringValue,
                  object["status"]?.stringValue == "active"
            else {
                return nil
            }
            return HQMeetingCompanyOption(
                id: companyUID,
                name: object["companyName"]?.stringValue ?? companyUID
            )
        } ?? []
    }

    private var actionOperation: HQNativeMeetingWindowOperation {
        switch state {
        case .recording, .stopping:
            return .stop
        case .detected, .starting, .error:
            return .start
        }
    }

    private var actionTitle: String {
        switch state {
        case .starting:
            return "Starting…"
        case .stopping:
            return "Stopping…"
        case .recording:
            return "Stop"
        case .detected, .error:
            return "Record"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(
                    systemName: state == .recording
                        ? "record.circle.fill"
                        : "video"
                )
                .font(.title3)
                .foregroundStyle(state == .recording ? .red : .primary)
                .frame(width: 24)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(row.title)
                            .font(.headline)
                        if row.metadata["focused"]?.boolValue == true {
                            Text("Focused")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(
                                    Color.accentColor.opacity(0.12),
                                    in: Capsule()
                                )
                                .accessibilityIdentifier(
                                    "\(accessibilityPrefix).row.\(row.id).focused"
                                )
                        }
                    }
                    Text(row.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Text(row.value ?? state.rawValue.capitalized)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Picker("Recording company", selection: $selectedCompanyUID) {
                    Text("Personal").tag("")
                    ForEach(companies) { company in
                        Text(company.name).tag(company.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
                .onChange(of: selectedCompanyUID) { companyUID in
                    onAction(
                        "meeting-action|change-company|\(windowID)|\(companyUID)"
                    )
                }
                .accessibilityLabel("Recording company")
                .accessibilityIdentifier(
                    "\(accessibilityPrefix).row.\(row.id).company"
                )

                Spacer()

                Button(actionTitle) {
                    onAction(
                        "meeting-action|\(actionOperation.rawValue)|\(windowID)|\(selectedCompanyUID)"
                    )
                }
                .buttonStyle(.borderedProminent)
                .disabled(state == .starting || state == .stopping)
                .accessibilityHint(
                    state == .starting || state == .stopping
                        ? "Wait for the current meeting operation to finish."
                        : actionOperation == .stop
                            ? "Stops the active native meeting capture."
                            : "Starts native capture for this meeting."
                )
                .accessibilityIdentifier(
                    "\(accessibilityPrefix).row.\(row.id).action.\(actionOperation.rawValue)"
                )
            }
        }
        .padding(14)
        .hqAdaptiveGlassSurface(cornerRadius: 12, fallback: .thin)
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(
                    row.metadata["focused"]?.boolValue == true
                        ? Color.accentColor
                        : Color.clear,
                    lineWidth: 2
                )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(
            "\(accessibilityPrefix).row.\(row.id)"
        )
    }
}

private struct HQMeetingPermissionsWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 20) {
            HQWindowHeader(fixture: fixture)

            VStack(spacing: 0) {
                ForEach(fixture.rows) { row in
                    HStack(spacing: 12) {
                        HQStaticWindowRow(
                            row: row,
                            accessibilityPrefix:
                                fixture.accessibilityIdentifier
                        )

                        if let destination = row.metadata[
                            "settingsDestination"
                        ]?.stringValue {
                            Button("Open Settings") {
                                onAction(
                                    "open-settings.\(destination)"
                                )
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityIdentifier(
                                "\(fixture.accessibilityIdentifier).permission.\(row.id).open-settings"
                            )
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("\(fixture.accessibilityIdentifier).permission.\(row.id)")

                    if row.id != fixture.rows.last?.id {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 16)
            .hqAdaptiveGlassSurface(cornerRadius: 12, fallback: .thin)

            Spacer()
            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(24)
        .frame(minWidth: 560, minHeight: 600)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQDirectMessageDetailWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void
    let onReply: (String) -> Void
    @State private var reply = ""

    var body: some View {
        VStack(spacing: 0) {
            HQWindowHeader(fixture: fixture)
                .padding(20)
            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(fixture.rows) { row in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(row.title)
                                    .font(.headline)
                                Spacer()
                                Text(row.value ?? "")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(row.detail)
                                .font(.body)
                        }
                        .padding(12)
                        .hqAdaptiveGlassSurface(cornerRadius: 10, fallback: .thin)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("\(fixture.accessibilityIdentifier).message.\(row.id)")
                    }
                }
                .padding(20)
            }

            Divider()
            HStack(spacing: 10) {
                TextField("Message \(fixture.title)", text: $reply)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("\(fixture.accessibilityIdentifier).composer")
                Button {
                    guard !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        return
                    }
                    onReply(reply)
                    reply = ""
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("\(fixture.accessibilityIdentifier).action.send")
            }
            .padding(14)
        }
        .frame(minWidth: 700, minHeight: 520)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQShareDetailWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 22) {
            HQWindowHeader(fixture: fixture)

            Image(systemName: "doc.richtext")
                .font(.system(size: 58, weight: .light))
                .frame(width: 110, height: 110)
                .hqAdaptiveGlassSurface(cornerRadius: 18, fallback: .thin)
                .accessibilityHidden(true)

            VStack(spacing: 4) {
                ForEach(fixture.rows) { row in
                    HQStaticWindowRow(
                        row: row,
                        accessibilityPrefix: fixture.accessibilityIdentifier
                    )
                }
            }
            .padding(6)
            .hqAdaptiveGlassSurface(cornerRadius: 12, fallback: .thin)

            Spacer()
            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(24)
        .frame(minWidth: 560, minHeight: 500)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQCollectionWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void

    var body: some View {
        VStack(spacing: 18) {
            HQWindowHeader(fixture: fixture)

            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(fixture.rows) { row in
                        HQStaticWindowRow(
                            row: row,
                            accessibilityPrefix: fixture.accessibilityIdentifier
                        )
                        .hqAdaptiveGlassSurface(cornerRadius: 10, fallback: .thin)
                    }
                }
            }

            HQWindowActions(fixture: fixture, onAction: onAction)
        }
        .padding(22)
        .frame(minWidth: 480, minHeight: 400)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}

private struct HQSettingsWindowView: View {
    let fixture: HQWindowFixture
    let onAction: (String) -> Void
    @State private var selectedID: String

    init(fixture: HQWindowFixture, onAction: @escaping (String) -> Void) {
        self.fixture = fixture
        self.onAction = onAction
        _selectedID = State(initialValue: fixture.rows.first?.id ?? "general")
    }

    var body: some View {
        VStack(spacing: 0) {
            HQWindowHeader(fixture: fixture)
                .padding(22)
            Divider()

            HStack(spacing: 0) {
                VStack(spacing: 4) {
                    ForEach(fixture.rows) { row in
                        Button {
                            selectedID = row.id
                        } label: {
                            HStack {
                                Image(systemName: row.symbolName)
                                    .frame(width: 20)
                                Text(row.title)
                                Spacer()
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(
                            selectedID == row.id ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .accessibilityIdentifier("\(fixture.accessibilityIdentifier).section.\(row.id)")
                    }
                    Spacer()
                }
                .padding(12)
                .frame(width: 190)
                .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .thin)

                Divider()

                VStack(alignment: .leading, spacing: 18) {
                    if let selected = fixture.rows.first(where: { $0.id == selectedID }) {
                        Label(selected.title, systemImage: selected.symbolName)
                            .font(.title2.weight(.semibold))
                        Text(selected.detail)
                            .foregroundStyle(.secondary)
                        Text(
                            "These settings are managed in the corresponding full HQ screen. "
                                + "Use the action below to return to HQ."
                        )
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer()
                    HQWindowActions(fixture: fixture, onAction: onAction)
                }
                .padding(24)
            }
        }
        .frame(minWidth: 680, minHeight: 540)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(fixture.accessibilityIdentifier)
    }
}
