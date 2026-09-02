import SwiftUI

struct HQMessagesSendRequest: Equatable, Sendable {
    let body: String
    let section: HQMessageSectionKind
    let rowID: String
}

struct HQMessagesSelectionRequest: Equatable, Sendable {
    let section: HQMessageSectionKind
    let rowID: String
}

struct HQMessagesWindowView: View {
    let fixture: HQMessagesFixture
    let onAction: (String) -> Void
    let onSelect: (HQMessagesSelectionRequest) -> Void
    let onSend: (HQMessagesSendRequest) -> Void

    @State private var selectedSection: HQMessageSectionKind
    @State private var selectedRowID: String
    @State private var draft = ""
    @State private var showsThread = true

    init(
        fixture: HQMessagesFixture,
        onAction: @escaping (String) -> Void,
        onSelect: @escaping (HQMessagesSelectionRequest) -> Void,
        onSend: @escaping (HQMessagesSendRequest) -> Void
    ) {
        self.fixture = fixture
        self.onAction = onAction
        self.onSelect = onSelect
        self.onSend = onSend
        _selectedSection = State(
            initialValue: fixture.selectedSection
        )
        _selectedRowID = State(
            initialValue: fixture.selectedRowID
        )
    }

    private var selectedRow: HQMessageListRowFixture? {
        fixture.sections.first {
            $0.kind == selectedSection
        }?.rows.first {
            $0.id == selectedRowID
        }
    }

    private var visibleConversation: HQConversationFixture {
        if fixture.selectedSection == selectedSection,
           fixture.selectedRowID == selectedRowID
        {
            return fixture.selectedConversation
        }
        guard let selectedRow else {
            return fixture.selectedConversation
        }
        return HQConversationFixture(
            title: selectedRow.title,
            subtitle: "\(selectedSection.title) · Loading conversation…",
            messages: [
                HQMessageBubbleFixture(
                    id: "selection-preview-\(selectedRow.id)",
                    author: selectedRow.title,
                    body: selectedRow.preview,
                    timestamp: selectedRow.timestamp,
                    isCurrentUser: false,
                    reactions: []
                ),
            ],
            thread: nil
        )
    }

    private var canSendToSelection: Bool {
        fixture.selectionIsReady
            && fixture.selectedSection == selectedSection
            && fixture.selectedRowID == selectedRowID
            && selectedRow != nil
            && (selectedSection == .directMessages
                || selectedSection == .channels)
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            conversation

            if showsThread, let thread = visibleConversation.thread {
                Divider()
                threadPane(thread)
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .regular)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("window.messages")
        .onChange(of: fixture.selectedRowID) { rowID in
            guard !rowID.isEmpty else { return }
            selectedSection = fixture.selectedSection
            selectedRowID = rowID
        }
        .onChange(of: fixture.selectedSection) { section in
            selectedSection = section
            selectedRowID = fixture.selectedRowID
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Messages")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button {
                    onAction("requests")
                } label: {
                    Image(systemName: "tray.full")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open inbox")
                .accessibilityIdentifier("messages.action.open-inbox")
            }
            .padding(14)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(fixture.sections) { section in
                        messageSection(section)
                    }
                }
                .padding(10)
            }
        }
        .frame(width: 230)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .thin)
        .accessibilityIdentifier("messages.sidebar")
    }

    private func messageSection(_ section: HQMessageSectionFixture) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                if section.kind == .requests {
                    onAction("requests")
                } else if let first = section.rows.first {
                    select(first, in: section.kind)
                }
            } label: {
                HStack {
                    Text(section.kind.title.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(section.rows.count)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("messages.sidebar.section.\(section.kind.rawValue)")

            ForEach(section.rows) { row in
                Button {
                    if section.kind == .requests {
                        onAction("requests")
                    } else {
                        select(row, in: section.kind)
                    }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        ZStack(alignment: .bottomTrailing) {
                            Circle()
                                .fill(.quaternary)
                                .frame(width: 28, height: 28)
                            Text(String(row.title.prefix(1)))
                                .font(.caption.weight(.semibold))
                            if row.unreadCount > 0 {
                                Circle()
                                    .fill(.primary)
                                    .frame(width: 7, height: 7)
                                    .overlay {
                                        Circle().stroke(.background, lineWidth: 1)
                                    }
                            }
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(row.title)
                                    .font(.caption.weight(row.unreadCount > 0 ? .semibold : .regular))
                                    .lineLimit(1)
                                Spacer()
                                Text(row.timestamp)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            HStack(spacing: 4) {
                                Text(row.preview)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if row.isMuted {
                                    Image(systemName: "speaker.slash")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(7)
                }
                .buttonStyle(.plain)
                .background(
                    selectedRowID == row.id
                        ? AnyShapeStyle(.quaternary)
                        : AnyShapeStyle(.clear),
                    in: RoundedRectangle(cornerRadius: 8)
                )
                .accessibilityIdentifier("messages.sidebar.row.\(row.id)")
            }
        }
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(visibleConversation.title)
                        .font(.headline)
                        .accessibilityLabel(visibleConversation.title)
                        .accessibilityIdentifier(
                            "messages.conversation.title"
                        )
                    Text(visibleConversation.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    showsThread.toggle()
                } label: {
                    Label(
                        showsThread ? "Hide Thread" : "Show Thread",
                        systemImage: "rectangle.righthalf.inset.filled"
                    )
                    .labelStyle(.iconOnly)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("messages.action.toggle-thread")
            }
            .padding(14)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(visibleConversation.messages) { message in
                        messageBubble(message, scope: "conversation")
                    }
                }
                .padding(18)
            }
            .accessibilityIdentifier("messages.conversation")

            Divider()

            HStack(spacing: 8) {
                TextField("Message \(visibleConversation.title)", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("messages.composer")

                Button {
                    sendDraft()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(
                    draft.trimmingCharacters(
                        in: .whitespacesAndNewlines
                    ).isEmpty || !canSendToSelection
                )
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("messages.action.send")
            }
            .padding(12)
        }
        .frame(minWidth: 350)
    }

    private func threadPane(_ thread: HQMessageThreadFixture) -> some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title)
                        .font(.headline)
                    Text("\(thread.replyCount) replies")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    showsThread = false
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close thread")
                .accessibilityIdentifier("messages.thread.close")
            }
            .padding(14)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(thread.messages) { message in
                        messageBubble(message, scope: "thread")
                    }
                }
                .padding(14)
            }
        }
        .frame(width: 250)
        .hqAdaptiveGlassSurface(cornerRadius: 0, fallback: .thin)
        .accessibilityIdentifier("messages.thread")
    }

    private func messageBubble(
        _ message: HQMessageBubbleFixture,
        scope: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(message.author)
                    .font(.caption.weight(.semibold))
                Text(message.timestamp)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
            }

            Text(message.body)
                .font(.body)
                .textSelection(.enabled)

            if !message.reactions.isEmpty {
                HStack(spacing: 5) {
                    ForEach(message.reactions) { reaction in
                        Text("\(reaction.emoji) \(reaction.count)")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(
                                reaction.reactedByCurrentUser
                                    ? AnyShapeStyle(.quaternary)
                                    : AnyShapeStyle(.clear),
                                in: Capsule()
                            )
                            .overlay {
                                Capsule().stroke(.quaternary, lineWidth: 1)
                            }
                        .accessibilityIdentifier(
                            "messages.reaction.\(message.id).\(reaction.emoji)"
                        )
                    }
                }
                .accessibilityIdentifier("messages.reactions")
            }
        }
        .padding(10)
        .hqAdaptiveGlassSurface(
            cornerRadius: 10,
            fallback: .thin,
            isEnabled: message.isCurrentUser
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("messages.\(scope).message.\(message.id)")
    }

    private func sendDraft() {
        guard canSendToSelection,
              !draft.trimmingCharacters(
                in: .whitespacesAndNewlines
              ).isEmpty
        else {
            return
        }
        onSend(
            HQMessagesSendRequest(
                body: draft,
                section: selectedSection,
                rowID: selectedRowID
            )
        )
        draft = ""
    }

    private func select(
        _ row: HQMessageListRowFixture,
        in section: HQMessageSectionKind
    ) {
        selectedSection = section
        selectedRowID = row.id
        showsThread = true
        onSelect(
            HQMessagesSelectionRequest(
                section: section,
                rowID: row.id
            )
        )
    }
}
