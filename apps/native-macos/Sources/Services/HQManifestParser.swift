import Foundation

enum HQManifestParser {
    enum ParseError: LocalizedError {
        case missingCompanies

        var errorDescription: String? {
            "The HQ manifest does not contain a companies map."
        }
    }

    static func parse(_ yaml: String, root: URL) throws -> [HQWorkspace] {
        let lines = yaml.components(separatedBy: .newlines)
        guard let companiesIndex = lines.firstIndex(where: {
            content(of: $0) == "companies:"
        }) else {
            throw ParseError.missingCompanies
        }

        let companiesIndent = indentation(of: lines[companiesIndex])
        var rows: [HQWorkspace] = []
        var index = companiesIndex + 1

        while index < lines.count {
            let line = lines[index]
            let trimmed = content(of: line)
            if trimmed.isEmpty {
                index += 1
                continue
            }

            let indent = indentation(of: line)
            if indent <= companiesIndent {
                break
            }

            let expectedRowIndent = companiesIndent + 2
            guard indent == expectedRowIndent,
                  trimmed.hasSuffix(":"),
                  !trimmed.hasPrefix("-")
            else {
                index += 1
                continue
            }

            let slug = String(trimmed.dropLast()).trimmingCharacters(in: .whitespaces)
            guard !slug.isEmpty else {
                index += 1
                continue
            }

            var name = humanize(slug)
            var relativePath = "companies/\(slug)"
            var hasCloudIdentity = false
            let propertyIndent = expectedRowIndent + 2
            index += 1

            while index < lines.count {
                let propertyLine = lines[index]
                let propertyContent = content(of: propertyLine)
                if propertyContent.isEmpty {
                    index += 1
                    continue
                }

                let propertyLineIndent = indentation(of: propertyLine)
                if propertyLineIndent <= expectedRowIndent {
                    break
                }

                if propertyLineIndent == propertyIndent,
                   let separator = propertyContent.firstIndex(of: ":") {
                    let key = String(propertyContent[..<separator])
                    let raw = String(propertyContent[propertyContent.index(after: separator)...])
                    let value = unquote(raw.trimmingCharacters(in: .whitespaces))

                    switch key {
                    case "name":
                        if !value.isEmpty { name = value }
                    case "path":
                        if !value.isEmpty { relativePath = value }
                    case "cloud_uid", "bucket_name":
                        hasCloudIdentity = !value.isEmpty && value != "null"
                    default:
                        break
                    }
                }
                index += 1
            }

            rows.append(
                HQWorkspace(
                    slug: slug,
                    name: name,
                    path: root.appending(path: relativePath),
                    kind: slug == "personal" ? "personal" : "company",
                    state: hasCloudIdentity ? .connected : .needsConnect,
                    lastSyncedAt: nil
                )
            )
        }

        return rows
    }

    private static func indentation(of line: String) -> Int {
        line.prefix { $0 == " " }.count
    }

    private static func content(of line: String) -> String {
        let withoutComment = line.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
        return withoutComment.trimmingCharacters(in: .whitespaces)
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2,
              let first = value.first,
              let last = value.last,
              (first == "\"" && last == "\"") || (first == "'" && last == "'")
        else {
            return value
        }
        return String(value.dropFirst().dropLast())
    }

    private static func humanize(_ slug: String) -> String {
        slug.split(separator: "-")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
