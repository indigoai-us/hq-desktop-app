//! Single source of truth for the hq-pro vault-service routes this crate
//! calls directly (the `desktop_alt` request builders).
//!
//! Each constant is `"METHOD /path/{param}"`, byte-for-byte matching the
//! `routeKey` the route is registered under in hq-pro's `infra/*.ts`. The
//! desktop_alt URL builders format their request URL by substituting params
//! into [`path_for`] rather than hand-writing the path a second time, so a
//! route that drifts from this table fails to build the URL used at
//! runtime, not just a separately-maintained doc comment.
//!
//! `scripts/route-contract-check.mjs` also parses this file directly (regex
//! over `pub const ... &str = "...";`) to cross-check every entry against
//! the live hq-pro / hq-pro-agents route registries in CI. Keep entries here
//! as plain string literals — no `format!`/`concat!` construction — so both
//! the compiler and the contract check see the exact same text.

/// `GET /companies/{companyUid}/board`
pub const BOARD: &str = "GET /companies/{companyUid}/board";

/// `POST /v1/companies/{companyUid}/home-channel`
pub const HOME_CHANNEL: &str = "POST /v1/companies/{companyUid}/home-channel";

/// `GET /companies/{companyUid}/crm-projection`
pub const CRM_PROJECTION: &str = "GET /companies/{companyUid}/crm-projection";

/// `GET /companies/{companyUid}/activity`
pub const ACTIVITY: &str = "GET /companies/{companyUid}/activity";

/// `GET /secrets/{companyUid}`
pub const SECRETS: &str = "GET /secrets/{companyUid}";

/// Splits a `"METHOD /path/{companyUid}"` constant and substitutes
/// `{companyUid}` with the caller's id, returning the request path (with
/// leading `/`, no method, no base).
pub fn path_for(route: &str, company_uid: &str) -> String {
    let path = route.split_once(' ').map(|(_, p)| p).unwrap_or(route);
    path.replace("{companyUid}", company_uid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_for_substitutes_company_uid() {
        assert_eq!(
            path_for(HOME_CHANNEL, "cmp_01ABC"),
            "/v1/companies/cmp_01ABC/home-channel"
        );
        assert_eq!(path_for(BOARD, "cmp_01ABC"), "/companies/cmp_01ABC/board");
        assert_eq!(path_for(SECRETS, "cmp_01ABC"), "/secrets/cmp_01ABC");
    }
}
