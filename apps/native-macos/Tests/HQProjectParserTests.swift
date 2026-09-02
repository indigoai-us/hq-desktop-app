import XCTest
@testable import HQNative

final class HQProjectParserTests: XCTestCase {
    func testParsesCurrentAndLegacyProjectShapes() throws {
        let json = """
        {
          "id": "native-app",
          "title": "Native macOS HQ",
          "objective": "Replace the webview shell",
          "status": "active",
          "branchName": "feat/native",
          "owner": "Corey",
          "userStories": [
            {
              "id": "NATIVE-001",
              "title": "Native shell",
              "description": "Open every destination",
              "priority": 1,
              "passes": false,
              "acceptanceCriteria": ["Uses SwiftUI", "Uses Liquid Glass"],
              "dependencies": []
            },
            {
              "id": "NATIVE-002",
              "title": "Already done",
              "passes": true,
              "acceptanceCriteria": []
            }
          ]
        }
        """.data(using: .utf8)!

        let path = URL(fileURLWithPath: "/tmp/HQ/companies/indigo/projects/native-app/prd.json")
        let project = try HQProjectParser.parse(data: json, companySlug: "indigo", path: path)

        XCTAssertEqual(project.id, "native-app")
        XCTAssertEqual(project.title, "Native macOS HQ")
        XCTAssertEqual(project.summary, "Replace the webview shell")
        XCTAssertEqual(project.branch, "feat/native")
        XCTAssertEqual(project.owner, "Corey")
        XCTAssertEqual(project.tasks.count, 2)
        XCTAssertEqual(project.tasks[0].state, .notStarted)
        XCTAssertEqual(project.tasks[1].state, .complete)
    }

    func testDerivesStartedStateFromNotesAndActiveFromLivePhase() throws {
        let json = """
        {
          "id": "native-app",
          "title": "Native",
          "stories": [
            {"id": "A", "title": "Queued", "passes": false},
            {"id": "B", "title": "Started", "passes": false, "notes": "Implementation underway"},
            {"id": "C", "title": "Running", "passes": false, "livePhase": "Testing"}
          ]
        }
        """.data(using: .utf8)!

        let project = try HQProjectParser.parse(
            data: json,
            companySlug: "indigo",
            path: URL(fileURLWithPath: "/tmp/prd.json")
        )

        XCTAssertEqual(project.tasks.map(\.state), [.notStarted, .inProgress, .active])
    }

    func testRejectsMalformedOrIdentityFreeProject() {
        XCTAssertThrowsError(
            try HQProjectParser.parse(
                data: Data("{}".utf8),
                companySlug: "indigo",
                path: URL(fileURLWithPath: "/tmp/prd.json")
            )
        )
        XCTAssertThrowsError(
            try HQProjectParser.parse(
                data: Data("not-json".utf8),
                companySlug: "indigo",
                path: URL(fileURLWithPath: "/tmp/prd.json")
            )
        )
    }
}

