import Foundation

enum HQDeepLinkRouter {
    /// Navigation links intentionally have one spelling. Keeping the envelope
    /// as strict as the route payload prevents Foundation's case folding and
    /// percent-decoding conveniences from creating a second route identity.
    static func route(from url: URL) -> HQRoute? {
        guard let components = URLComponents(string: url.absoluteString),
              components.scheme == "hqmobile",
              components.host == "route",
              components.user == nil, components.password == nil, components.port == nil,
              components.percentEncodedQuery == nil, components.fragment == nil
        else { return nil }

        let encodedPath = components.percentEncodedPath
        guard encodedPath.first == "/",
              encodedPath.count > 1,
              let route = HQRoute.parse(String(encodedPath.dropFirst())),
              url.absoluteString == canonicalEnvelope(for: route)
        else { return nil }

        return route
    }

    static func url(for route: HQRoute) -> URL? {
        URL(string: canonicalEnvelope(for: route))
    }

    private static func canonicalEnvelope(for route: HQRoute) -> String {
        "hqmobile://route/\(route.canonicalString)"
    }
}
