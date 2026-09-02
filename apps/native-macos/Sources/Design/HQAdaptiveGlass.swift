import SwiftUI

private struct HQForcedReduceTransparencyKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var hqForcedReduceTransparency: Bool {
        get { self[HQForcedReduceTransparencyKey.self] }
        set { self[HQForcedReduceTransparencyKey.self] = newValue }
    }
}

enum HQGlassFallbackMaterial: Sendable {
    case regular
    case thin

    var material: Material {
        switch self {
        case .regular:
            .regularMaterial
        case .thin:
            .thinMaterial
        }
    }
}

struct HQAdaptiveGlassSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat
    let fallback: HQGlassFallbackMaterial
    let isEnabled: Bool

    @Environment(\.accessibilityReduceTransparency)
    private var reduceTransparency
    @Environment(\.hqForcedReduceTransparency)
    private var forceReduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: cornerRadius,
            style: .continuous
        )
        if !isEnabled {
            content
        } else if reduceTransparency || forceReduceTransparency {
            content
                .background(
                    Color(nsColor: .windowBackgroundColor),
                    in: shape
                )
                .overlay {
                    shape.stroke(
                        Color.primary.opacity(0.12),
                        lineWidth: 1
                    )
                }
        } else if #available(macOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content
                .background(fallback.material, in: shape)
                .overlay {
                    shape.stroke(
                        Color.primary.opacity(0.10),
                        lineWidth: 1
                    )
                }
        }
    }
}

extension View {
    func hqAdaptiveGlassSurface(
        cornerRadius: CGFloat = 18,
        fallback: HQGlassFallbackMaterial = .regular,
        isEnabled: Bool = true
    ) -> some View {
        modifier(
            HQAdaptiveGlassSurfaceModifier(
                cornerRadius: cornerRadius,
                fallback: fallback,
                isEnabled: isEnabled
            )
        )
    }
}

struct HQAdaptiveGlassContainer<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    @Environment(\.accessibilityReduceTransparency)
    private var reduceTransparency
    @Environment(\.hqForcedReduceTransparency)
    private var forceReduceTransparency

    init(
        spacing: CGFloat = 14,
        @ViewBuilder content: () -> Content
    ) {
        self.spacing = spacing
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if reduceTransparency || forceReduceTransparency {
            content
        } else if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}
