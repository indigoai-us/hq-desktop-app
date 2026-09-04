import XCTest
@testable import HQIOS

final class HQDeepLinkRouterTests: XCTestCase {
    func testCanonicalNavigationEnvelopeRoundTripsEncodedRouteIdentity() throws {
        let routes = try [
            HQRoute(kind: .global(.home)),
            HQRoute(kind: .company(slug: "Indigo & Café/%:HQ", section: .knowledge)),
            HQRoute(kind: .files(company: "R&D / HQ", path: "knowledge/🌎:100%.md")),
            HQRoute(kind: .project(company: "indigo labs", projectID: "ios/app")),
            HQRoute(kind: .project(company: "indigo", projectID: "ios%2Fapp")),
            HQRoute(kind: .project(company: "indigo", projectID: "%")),
            HQRoute(kind: .task(company: "indigo labs", projectID: "ios/app", taskID: "NATIVE:003")),
        ].map { try XCTUnwrap($0) }

        for route in routes {
            let link = try XCTUnwrap(HQDeepLinkRouter.url(for: route))
            XCTAssertEqual(HQDeepLinkRouter.route(from: link), route, route.canonicalString)
            XCTAssertEqual(link.absoluteString, "hqmobile://route/\(route.canonicalString)")
        }
    }

    func testOnlyCanonicalNavigationEnvelopeIsAccepted() throws {
        let rejected = [
            "hqmobile://auth?code=x&state=y",
            "hqmobile://inbox",
            "hqmobile://open?route=home",
            "hqmobile://route?route=home",
            "hqmobile://route/home?source=notification",
            "hqmobile://route/home#fragment",
            "hqmobile://user@route/home",
            "hqmobile://route:443/home",
            "hqmobile://unknown/home",
            "hqmobile://route/",
            "hqmobile://route/home/extra",
            "hqmobile://route/company:space%2fslash:overview",
            "HQMOBILE://route/home",
            "hqmobile://ROUTE/home",
            "https://example.invalid/route/home",
        ]

        for raw in rejected {
            let url = try XCTUnwrap(URL(string: raw), raw)
            XCTAssertNil(HQDeepLinkRouter.route(from: url), raw)
        }
    }
}
