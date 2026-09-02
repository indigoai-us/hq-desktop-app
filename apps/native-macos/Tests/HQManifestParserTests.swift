import XCTest
@testable import HQNative

final class HQManifestParserTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/tmp/HQ")

    func testParsesCompanyRowsAndPreservesManifestOrder() throws {
        let yaml = """
        version: 1
        companies:
          personal:
            name: Personal
            path: companies/personal
          indigo:
            name: Indigo
            path: companies/indigo
            cloud_uid: cmp_indigo
          local-lab:
            name: Local Lab
            path: companies/local-lab
        """

        let rows = try HQManifestParser.parse(yaml, root: root)

        XCTAssertEqual(rows.map(\.slug), ["personal", "indigo", "local-lab"])
        XCTAssertEqual(rows.map(\.name), ["Personal", "Indigo", "Local Lab"])
        XCTAssertEqual(rows[0].kind, "personal")
        XCTAssertEqual(rows[1].state, .connected)
        XCTAssertEqual(rows[2].state, .needsConnect)
        XCTAssertEqual(rows[1].path, root.appending(path: "companies/indigo"))
    }

    func testIgnoresNestedCompanyPropertiesThatLookLikeRows() throws {
        let yaml = """
        companies:
          indigo:
            name: Indigo
            repos:
              - repos/public/hq-desktop-app
            settings:
              name: This is not a company
        """

        let rows = try HQManifestParser.parse(yaml, root: root)
        XCTAssertEqual(rows.map(\.slug), ["indigo"])
    }

    func testThrowsForMissingCompaniesMap() {
        XCTAssertThrowsError(try HQManifestParser.parse("version: 1", root: root))
    }
}

