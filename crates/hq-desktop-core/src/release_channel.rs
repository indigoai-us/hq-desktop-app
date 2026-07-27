//! Release-channel resolver for the Tauri auto-updater.
//!
//! HQ Sync ships three channels — Stable, Beta, Alpha — distinguished
//! purely by GitHub tag suffix:
//!
//!   - `v0.1.109`         → Stable
//!   - `v0.1.109-beta.1`  → Beta
//!   - `v0.1.109-alpha.3` → Alpha
//!
//! Channel storage in `~/.hq/menubar.json` (`releaseChannel`) is the user
//! preference; the *effective* channel returned by [`effective_channel`]
//! coerces the preference against [`crate::util::feature_gate::is_indigo_user`]
//! so a non-`@getindigo.ai` user is never served a pre-release even if their
//! menubar.json has been hand-edited to `"beta"` or `"alpha"`. This is the
//! defense-in-depth gate — the Settings UI is the first gate (only
//! `@getindigo.ai` users see the picker), but a config-file edit must NOT
//! be sufficient to escape stable.
//!
//! Endpoint resolution ([`resolve_channel_endpoint`]) queries the public
//! GitHub Releases API (`/repos/indigoai-us/hq-desktop-app/releases?per_page=30`),
//! filters by channel, picks the highest semver, and returns the
//! per-release `latest.json` URL the Tauri updater can poll. On any failure
//! (network down, rate limit, malformed body, no eligible prerelease) the
//! resolver falls back to the static stable endpoint and marks that endpoint
//! as non-authoritative for absence —
//! `https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json`
//! — which GitHub's `releases/latest/` alias already filters to
//! non-prereleases. This means a Beta user behind a corporate proxy that
//! blocks api.github.com can still receive a stable update without allowing a
//! fallback null result to erase a previously discovered prerelease.
//!
//! Rationale for tag-suffix as the channel signal (vs. GitHub's
//! `prerelease` flag on the release object): the CI workflow controls the
//! `prerelease` flag, and earlier releases all carry `prerelease: false`.
//! Filtering on tag suffix makes the client correct independent of CI
//! state, which lets us ship the client change first and adjust the CI
//! flag in the same PR without ordering risk.

use std::time::Duration;

use serde::Deserialize;

use crate::client_info::build_client;

/// Public GitHub Releases API endpoint for the unified hq-desktop-app.
/// 30 results is enough to span several release cycles without paginating
/// — at the current ~weekly cadence that's roughly half a year of history,
/// far more than any user could miss between launches.
const GH_RELEASES_URL: &str =
    "https://api.github.com/repos/indigoai-us/hq-desktop-app/releases?per_page=30";

/// Per-release `latest.json` URL pattern. `{tag}` is substituted with the
/// matched release's `tag_name` (e.g. `v0.1.109-beta.1`).
const PER_RELEASE_MANIFEST_PATTERN: &str =
    "https://github.com/indigoai-us/hq-desktop-app/releases/download/{tag}/latest.json";

/// Static stable fallback. GitHub's `/releases/latest/download/` alias is
/// guaranteed to point at the newest non-prerelease — exactly the right
/// behavior for stable users, and a safe fallback for prerelease users
/// when the API is unreachable.
pub const STABLE_FALLBACK_ENDPOINT: &str =
    "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json";

/// Why a channel endpoint was selected. Only direct stable checks and a
/// successfully resolved prerelease-channel release are authoritative proof
/// that a null updater result means no applicable update exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointProvenance {
    StableChannel,
    ChannelRelease,
    StableFallback,
}

impl EndpointProvenance {
    pub fn absence_is_authoritative(self) -> bool {
        matches!(self, Self::StableChannel | Self::ChannelRelease)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChannelEndpoint {
    pub url: String,
    pub provenance: EndpointProvenance,
}

/// HTTP timeout for the GitHub API call. Tight on purpose — the updater
/// runs on a 6h background loop and a slow API must not stall it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Release channels offered to the user. Order matches advancement
/// stability: Stable < Beta < Alpha (alpha is most bleeding-edge).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseChannel {
    Stable,
    Beta,
    Alpha,
}

impl ReleaseChannel {
    /// Stringify for `MenubarPrefs.release_channel` storage. The on-disk
    /// representation is lowercase and stable across versions.
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseChannel::Stable => "stable",
            ReleaseChannel::Beta => "beta",
            ReleaseChannel::Alpha => "alpha",
        }
    }

    /// Parse a stored preference string. Unknown / empty values default
    /// to Stable so a corrupted menubar.json or a future channel string
    /// never breaks updates.
    pub fn from_pref(s: Option<&str>) -> Self {
        match s.map(str::to_ascii_lowercase).as_deref() {
            Some("alpha") => ReleaseChannel::Alpha,
            Some("beta") => ReleaseChannel::Beta,
            _ => ReleaseChannel::Stable,
        }
    }

    /// Returns true iff a release on `other` would be served to a user
    /// subscribed to `self`. Stable users see only Stable. Beta users see
    /// Stable + Beta. Alpha users see everything.
    pub fn includes(self, other: ReleaseChannel) -> bool {
        match self {
            ReleaseChannel::Stable => other == ReleaseChannel::Stable,
            ReleaseChannel::Beta => {
                other == ReleaseChannel::Stable || other == ReleaseChannel::Beta
            }
            ReleaseChannel::Alpha => true,
        }
    }
}

/// Classify a release tag (e.g. `v0.1.109`, `v0.1.109-beta.1`) into a
/// channel. Returns `None` for unparseable tags — the caller skips them.
///
/// Strict tag shapes (must match `release.yml` classifier exactly —
/// drift between this and CI silently strands a channel; see
/// `hq-sync-release-channels-client-gating`):
///
///   - `vX.Y.Z`            → Stable
///   - `vX.Y.Z-beta.N`     → Beta   (N is a numeric build number)
///   - `vX.Y.Z-alpha.N`    → Alpha
///
/// Other pre-release shapes are rejected:
///   - `X.Y.Z`               — missing the mandatory release-tag `v` prefix
///   - `vX.Y.Z-rc.1`, `-pre.1`, `-dev` — unknown channel identifier
///   - `vX.Y.Z-beta`        — missing the numeric `.N` suffix (CI rejects
///     this; a manually-pushed unnumbered tag must NOT be picked up)
///   - `vX.Y.Z-beta.1.2`    — extra identifier past the build number
///   - `vX.Y.Z+build`        — build metadata is outside the release contract
pub fn parse_channel_from_tag(tag: &str) -> Option<(ReleaseChannel, semver::Version)> {
    let stripped = tag.strip_prefix('v')?;
    let version = semver::Version::parse(stripped).ok()?;
    if !version.build.is_empty() {
        return None;
    }

    if version.pre.is_empty() {
        return Some((ReleaseChannel::Stable, version));
    }

    // semver::Prerelease is one string with dot-separated identifiers.
    // Require EXACTLY two identifiers: a channel marker (`beta` or
    // `alpha`) followed by a non-negative integer build number. This
    // mirrors `release.yml`'s `^v[0-9]+\.[0-9]+\.[0-9]+-(beta|alpha)\.[0-9]+$`
    // regex so the client and the workflow march in lockstep.
    let pre_ids: Vec<&str> = version.pre.as_str().split('.').collect();
    if pre_ids.len() != 2 {
        return None;
    }
    let channel = match pre_ids[0] {
        "alpha" => ReleaseChannel::Alpha,
        "beta" => ReleaseChannel::Beta,
        _ => return None,
    };
    // Reject non-numeric / negative build numbers.
    if pre_ids[1].is_empty() || pre_ids[1].parse::<u64>().is_err() {
        return None;
    }
    Some((channel, version))
}

/// Compute the effective channel for the updater. Combines the user's
/// stored preference with the indigo-domain gate.
///
/// `is_indigo` is taken as an argument (not fetched here) so this fn
/// stays sync + pure and is trivial to unit-test. The async fetch lives
/// at the call site in `updater.rs`.
pub fn effective_channel(stored_pref: Option<&str>, is_indigo: bool) -> ReleaseChannel {
    let parsed = ReleaseChannel::from_pref(stored_pref);
    if is_indigo {
        // Indigo user with no stored preference (None) defaults to Beta:
        // they auto-opt-in on first launch. An explicit "stable" is
        // honored — they can downgrade in Settings.
        match (stored_pref, parsed) {
            (None, _) => ReleaseChannel::Beta,
            (Some(_), p) => p,
        }
    } else {
        // Non-indigo: coerce to Stable regardless of stored value. This
        // is the defense-in-depth gate against hand-edited menubar.json.
        ReleaseChannel::Stable
    }
}

/// Minimal subset of the GitHub Releases API response. We only need the
/// tag name; assets/URLs are constructed from the tag.
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    // We deliberately ignore `prerelease`, `draft`, `assets`. The tag
    // suffix is authoritative for our channel; draft releases don't
    // appear in the public API response for unauthenticated callers.
}

/// Pick the highest applicable release for `channel` from a list of
/// release tags. Pure — extracted for testability.
///
/// Returns `None` if no tag matches.
pub fn pick_release_for_channel(channel: ReleaseChannel, tags: &[String]) -> Option<String> {
    tags.iter()
        .filter_map(|tag| {
            let (tag_channel, version) = parse_channel_from_tag(tag)?;
            if channel.includes(tag_channel) {
                Some((tag.clone(), version))
            } else {
                None
            }
        })
        .max_by(|a, b| a.1.cmp(&b.1))
        .map(|(tag, _)| tag)
}

fn stable_fallback() -> ResolvedChannelEndpoint {
    ResolvedChannelEndpoint {
        url: STABLE_FALLBACK_ENDPOINT.to_string(),
        provenance: EndpointProvenance::StableFallback,
    }
}

fn resolve_endpoint_from_tags(channel: ReleaseChannel, tags: &[String]) -> ResolvedChannelEndpoint {
    let has_eligible_prerelease = tags.iter().any(|tag| {
        parse_channel_from_tag(tag)
            .map(|(tag_channel, _)| {
                tag_channel != ReleaseChannel::Stable && channel.includes(tag_channel)
            })
            .unwrap_or(false)
    });

    if !has_eligible_prerelease {
        return stable_fallback();
    }

    match pick_release_for_channel(channel, tags) {
        Some(tag) => ResolvedChannelEndpoint {
            url: PER_RELEASE_MANIFEST_PATTERN.replace("{tag}", &tag),
            provenance: EndpointProvenance::ChannelRelease,
        },
        None => stable_fallback(),
    }
}

/// Resolve the per-channel `latest.json` URL and retain whether a null result
/// is authoritative. Prerelease channels still receive a stable fallback when
/// GitHub resolution fails, but callers must preserve trusted pending state if
/// that fallback reports no update.
///
/// `channel` MUST already be the effective channel (see
/// [`effective_channel`]). This fn does not re-gate against indigo
/// identity.
pub async fn resolve_channel_endpoint(channel: ReleaseChannel) -> ResolvedChannelEndpoint {
    // Stable always uses the static `/releases/latest/download/` alias.
    // No API call, no rate-limit risk, no extra hop — GitHub already
    // filters that URL to non-prereleases.
    if channel == ReleaseChannel::Stable {
        return ResolvedChannelEndpoint {
            url: STABLE_FALLBACK_ENDPOINT.to_string(),
            provenance: EndpointProvenance::StableChannel,
        };
    }

    match fetch_release_tags().await {
        Ok(tags) => resolve_endpoint_from_tags(channel, &tags),
        Err(_) => stable_fallback(),
    }
}

/// One-shot fetch of release tags from the GitHub API. Public so the
/// updater can log failures explicitly when needed.
pub async fn fetch_release_tags() -> Result<Vec<String>, String> {
    let client = build_client();
    let resp = client
        .get(GH_RELEASES_URL)
        .timeout(REQUEST_TIMEOUT)
        // GitHub returns a non-error JSON shape when this header is set;
        // matches the convention in `hq_cli_update.rs`.
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GH releases GET: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GH releases status {}", resp.status()));
    }

    let releases: Vec<GhRelease> = resp
        .json()
        .await
        .map_err(|e| format!("GH releases JSON: {e}"))?;

    Ok(releases.into_iter().map(|r| r.tag_name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_channel_from_tag -----------------------------------------

    #[test]
    fn parse_stable_tag() {
        let (channel, version) = parse_channel_from_tag("v0.1.109").unwrap();
        assert_eq!(channel, ReleaseChannel::Stable);
        assert_eq!(version, semver::Version::new(0, 1, 109));
    }

    #[test]
    fn parse_beta_tag() {
        let (channel, _) = parse_channel_from_tag("v0.1.109-beta.1").unwrap();
        assert_eq!(channel, ReleaseChannel::Beta);
    }

    #[test]
    fn parse_alpha_tag() {
        let (channel, _) = parse_channel_from_tag("v0.1.109-alpha.42").unwrap();
        assert_eq!(channel, ReleaseChannel::Alpha);
    }

    #[test]
    fn parse_beta_without_number_rejected() {
        // CI's `release.yml` rejects `v1.0.0-beta` (no `.N`) — the
        // client parser MUST reject the same shape so a manually-pushed
        // unnumbered tag never gets routed onto Beta. Lockstep with the
        // workflow's `^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$` regex.
        assert!(parse_channel_from_tag("v1.0.0-beta").is_none());
        assert!(parse_channel_from_tag("v1.0.0-alpha").is_none());
    }

    #[test]
    fn parse_beta_with_non_numeric_suffix_rejected() {
        // `-beta.x` parses as a valid SemVer prerelease but doesn't
        // match the strict shape we accept.
        assert!(parse_channel_from_tag("v1.0.0-beta.x").is_none());
        assert!(parse_channel_from_tag("v1.0.0-alpha.foo").is_none());
    }

    #[test]
    fn parse_beta_with_extra_identifiers_rejected() {
        // Three-segment prerelease (e.g. `-beta.1.2`) is also rejected
        // — the CI regex requires exactly `-beta.N`.
        assert!(parse_channel_from_tag("v1.0.0-beta.1.2").is_none());
        assert!(parse_channel_from_tag("v1.0.0-alpha.3.hotfix").is_none());
    }

    #[test]
    fn parse_unknown_prerelease_rejected() {
        // `-rc` is intentionally not classified — we don't ship rc tags
        // and don't want to silently route them onto beta.
        assert!(parse_channel_from_tag("v1.0.0-rc.1").is_none());
        assert!(parse_channel_from_tag("v1.0.0-pre.1").is_none());
        assert!(parse_channel_from_tag("v1.0.0-dev").is_none());
    }

    #[test]
    fn parse_malformed_tag_rejected() {
        assert!(parse_channel_from_tag("not-a-version").is_none());
        assert!(parse_channel_from_tag("v1.0").is_none());
        assert!(parse_channel_from_tag("").is_none());
    }

    #[test]
    fn parse_tag_without_v_prefix_rejected() {
        assert!(parse_channel_from_tag("0.1.109").is_none());
        assert!(parse_channel_from_tag("0.1.109-beta.1").is_none());
        assert!(parse_channel_from_tag("0.1.109-alpha.1").is_none());
    }

    #[test]
    fn parse_tag_with_build_metadata_rejected() {
        assert!(parse_channel_from_tag("v1.0.0+manual").is_none());
        assert!(parse_channel_from_tag("v1.0.0-beta.1+manual").is_none());
        assert!(parse_channel_from_tag("v1.0.0-alpha.1+manual").is_none());
    }

    // --- ReleaseChannel::includes ---------------------------------------

    #[test]
    fn stable_includes_only_stable() {
        assert!(ReleaseChannel::Stable.includes(ReleaseChannel::Stable));
        assert!(!ReleaseChannel::Stable.includes(ReleaseChannel::Beta));
        assert!(!ReleaseChannel::Stable.includes(ReleaseChannel::Alpha));
    }

    #[test]
    fn beta_includes_stable_and_beta() {
        assert!(ReleaseChannel::Beta.includes(ReleaseChannel::Stable));
        assert!(ReleaseChannel::Beta.includes(ReleaseChannel::Beta));
        assert!(!ReleaseChannel::Beta.includes(ReleaseChannel::Alpha));
    }

    #[test]
    fn alpha_includes_everything() {
        assert!(ReleaseChannel::Alpha.includes(ReleaseChannel::Stable));
        assert!(ReleaseChannel::Alpha.includes(ReleaseChannel::Beta));
        assert!(ReleaseChannel::Alpha.includes(ReleaseChannel::Alpha));
    }

    // --- ReleaseChannel::from_pref --------------------------------------

    #[test]
    fn from_pref_recognises_known_values() {
        assert_eq!(
            ReleaseChannel::from_pref(Some("stable")),
            ReleaseChannel::Stable
        );
        assert_eq!(
            ReleaseChannel::from_pref(Some("beta")),
            ReleaseChannel::Beta
        );
        assert_eq!(
            ReleaseChannel::from_pref(Some("alpha")),
            ReleaseChannel::Alpha
        );
        // Case-insensitive: a hand-edited config with TitleCase still works.
        assert_eq!(
            ReleaseChannel::from_pref(Some("Beta")),
            ReleaseChannel::Beta
        );
        assert_eq!(
            ReleaseChannel::from_pref(Some("ALPHA")),
            ReleaseChannel::Alpha
        );
    }

    #[test]
    fn from_pref_defaults_to_stable_for_unknown() {
        // None / empty / garbage all coerce to Stable — never panic, never
        // surface a parse error to the user.
        assert_eq!(ReleaseChannel::from_pref(None), ReleaseChannel::Stable);
        assert_eq!(ReleaseChannel::from_pref(Some("")), ReleaseChannel::Stable);
        assert_eq!(
            ReleaseChannel::from_pref(Some("nightly")),
            ReleaseChannel::Stable
        );
        assert_eq!(
            ReleaseChannel::from_pref(Some("rc")),
            ReleaseChannel::Stable
        );
    }

    // --- effective_channel: the security-critical gate ------------------

    #[test]
    fn non_indigo_always_coerced_to_stable() {
        // The whole point of the gate: even if the menubar.json has been
        // edited to "beta" or "alpha", a non-indigo user gets Stable.
        assert_eq!(
            effective_channel(Some("beta"), false),
            ReleaseChannel::Stable
        );
        assert_eq!(
            effective_channel(Some("alpha"), false),
            ReleaseChannel::Stable
        );
        assert_eq!(
            effective_channel(Some("stable"), false),
            ReleaseChannel::Stable
        );
        assert_eq!(effective_channel(None, false), ReleaseChannel::Stable);
        // Junk preference for non-indigo also coerces to Stable.
        assert_eq!(
            effective_channel(Some("garbage"), false),
            ReleaseChannel::Stable
        );
    }

    #[test]
    fn indigo_with_no_pref_defaults_to_beta() {
        // Auto-opt-in: indigo users land on Beta on first launch.
        assert_eq!(effective_channel(None, true), ReleaseChannel::Beta);
    }

    #[test]
    fn indigo_with_explicit_pref_honored() {
        // Indigo users can downgrade to Stable or upgrade to Alpha.
        assert_eq!(
            effective_channel(Some("stable"), true),
            ReleaseChannel::Stable
        );
        assert_eq!(effective_channel(Some("beta"), true), ReleaseChannel::Beta);
        assert_eq!(
            effective_channel(Some("alpha"), true),
            ReleaseChannel::Alpha
        );
    }

    #[test]
    fn indigo_with_garbage_pref_falls_back_to_stable() {
        // An explicit-but-unknown value still goes through from_pref,
        // which coerces to Stable. The auto-opt-in only fires on None.
        assert_eq!(
            effective_channel(Some("nightly"), true),
            ReleaseChannel::Stable
        );
        assert_eq!(effective_channel(Some(""), true), ReleaseChannel::Stable);
    }

    // --- pick_release_for_channel ---------------------------------------

    #[test]
    fn picks_newest_stable_for_stable_channel() {
        let tags = vec![
            "v0.1.107".to_string(),
            "v0.1.108".to_string(),
            "v0.1.109-beta.1".to_string(),
            "v0.1.109-alpha.3".to_string(),
        ];
        // Stable user must NEVER see beta/alpha even if they're newer.
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Stable, &tags),
            Some("v0.1.108".to_string())
        );
    }

    #[test]
    fn beta_picks_newest_of_stable_or_beta() {
        let tags = vec![
            "v0.1.108".to_string(),
            "v0.1.109-beta.1".to_string(),
            "v0.1.109-alpha.3".to_string(),
        ];
        // Beta sees beta (newer semver than 0.1.108) but not alpha.
        // 0.1.109-beta.1 > 0.1.108 per SemVer pre-release rules
        // (because 109 > 108 at the major.minor.patch level).
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Beta, &tags),
            Some("v0.1.109-beta.1".to_string())
        );
    }

    #[test]
    fn beta_falls_back_to_newest_stable_when_no_beta_available() {
        let tags = vec![
            "v0.1.107".to_string(),
            "v0.1.108".to_string(),
            "v0.1.109-alpha.3".to_string(), // alpha not eligible for beta channel
        ];
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Beta, &tags),
            Some("v0.1.108".to_string())
        );
    }

    #[test]
    fn alpha_picks_newest_overall() {
        let tags = vec![
            "v0.1.108".to_string(),
            "v0.1.109-beta.1".to_string(),
            "v0.1.109-alpha.3".to_string(),
        ];
        // Per SemVer pre-release ordering, alpha < beta lexically. So
        // among the prereleases of 0.1.109, beta wins. And 0.1.109-beta.1
        // > 0.1.108. So alpha user gets the beta build.
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Alpha, &tags),
            Some("v0.1.109-beta.1".to_string())
        );
    }

    #[test]
    fn alpha_picks_alpha_when_newer_than_beta() {
        // Alpha user with a newer alpha than any beta: picks the alpha.
        let tags = vec![
            "v0.1.108".to_string(),
            "v0.1.109-beta.1".to_string(),
            "v0.1.110-alpha.1".to_string(),
        ];
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Alpha, &tags),
            Some("v0.1.110-alpha.1".to_string())
        );
    }

    #[test]
    fn pick_skips_unparseable_tags() {
        let tags = vec![
            "not-a-tag".to_string(),
            "v0.1.108".to_string(),
            "v0.1.109-rc.1".to_string(), // unknown prerelease
            "v0.1.110-beta.1".to_string(),
        ];
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Beta, &tags),
            Some("v0.1.110-beta.1".to_string())
        );
    }

    #[test]
    fn pick_returns_none_when_no_eligible_release() {
        // Stable channel + tags that are all prerelease.
        let tags = vec![
            "v0.1.109-beta.1".to_string(),
            "v0.1.110-alpha.2".to_string(),
        ];
        assert_eq!(
            pick_release_for_channel(ReleaseChannel::Stable, &tags),
            None
        );
    }

    #[test]
    fn pick_returns_none_on_empty_list() {
        assert_eq!(pick_release_for_channel(ReleaseChannel::Beta, &[]), None);
    }

    // --- Network-dependent test of resolve_channel_endpoint -------------

    #[tokio::test]
    async fn stable_channel_returns_static_fallback_without_network() {
        // Stable resolution must NOT hit the network — it's the cheap
        // path that survives a corporate proxy, a rate-limited GH API,
        // or an offline cold start. Asserting this also keeps test
        // execution deterministic in CI.
        let resolved = resolve_channel_endpoint(ReleaseChannel::Stable).await;
        assert_eq!(resolved.url, STABLE_FALLBACK_ENDPOINT);
        assert_eq!(resolved.provenance, EndpointProvenance::StableChannel);
        assert!(resolved.provenance.absence_is_authoritative());
    }

    #[test]
    fn prerelease_channel_without_eligible_prerelease_is_non_authoritative_fallback() {
        let tags = vec!["v0.10.35".to_string()];
        let resolved = resolve_endpoint_from_tags(ReleaseChannel::Beta, &tags);

        assert_eq!(resolved.url, STABLE_FALLBACK_ENDPOINT);
        assert_eq!(resolved.provenance, EndpointProvenance::StableFallback);
        assert!(!resolved.provenance.absence_is_authoritative());
    }

    #[test]
    fn resolved_prerelease_channel_is_authoritative() {
        let tags = vec!["v0.10.35".to_string(), "v0.10.36-beta.1".to_string()];
        let resolved = resolve_endpoint_from_tags(ReleaseChannel::Beta, &tags);

        assert_eq!(
            resolved.url,
            "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.36-beta.1/latest.json"
        );
        assert_eq!(resolved.provenance, EndpointProvenance::ChannelRelease);
        assert!(resolved.provenance.absence_is_authoritative());
    }

    #[test]
    fn as_str_roundtrips_with_from_pref() {
        for ch in [
            ReleaseChannel::Stable,
            ReleaseChannel::Beta,
            ReleaseChannel::Alpha,
        ] {
            let s = ch.as_str();
            assert_eq!(ReleaseChannel::from_pref(Some(s)), ch);
        }
    }
}
