//! Unit tests for `sync_outcome.rs`.
//!
//! Included from `sync_outcome.rs` via `#[path = "sync_outcome_tests.rs"] mod tests;`, so
//! this file is the parent module's `tests` child and `super::*` sees its
//! private items.

use super::*;

#[test]
fn runner_exit_meaning_uses_closed_values() {
    assert_eq!(
        runner_exit_meaning(Some(18), true),
        "identity_required_pass"
    );
    assert_eq!(runner_exit_meaning(Some(18), false), "exit_18_unattributed");
    assert_eq!(runner_exit_meaning(Some(2), false), "other");
    assert_eq!(runner_exit_meaning(None, false), "no_exit_code");
}

// ── grouping / suppression invariance (attribution must only ADD info) ───────
//
// The message-shape / path-root / provenance attribution added for
// HQ-DESKTOP-4T must never change how a runner exit groups or whether it
// alerts. These pins lock the exact pre-change return values of every token
// and decision the plan declares off-limits, so a future edit that turns
// attribution into re-grouping or suppression fails loudly.

#[test]
fn runner_error_class_group_tokens_are_pinned() {
    // fingerprint_token drives Sentry grouping; tag_name drives the tag value.
    // The Auth breadcrumb-token rename must not have touched either.
    let pinned = [
        (RunnerErrorClass::Eperm, "EPERM", "eperm"),
        (RunnerErrorClass::Eacces, "EACCES", "eacces"),
        (RunnerErrorClass::Enospc, "ENOSPC", "enospc"),
        (RunnerErrorClass::Ebusy, "EBUSY", "ebusy"),
        // New errno classes (HQ-DESKTOP-4T r2). The pre-existing seven rows
        // above/below MUST stay byte-identical so Sentry grouping and history
        // survive; these four are added, never substituted.
        (RunnerErrorClass::Enoent, "ENOENT", "enoent"),
        (RunnerErrorClass::Eexist, "EEXIST", "eexist"),
        (RunnerErrorClass::Enotempty, "ENOTEMPTY", "enotempty"),
        (RunnerErrorClass::Exdev, "EXDEV", "exdev"),
        (RunnerErrorClass::Network, "NETWORK", "network"),
        (RunnerErrorClass::Auth, "AUTH", "auth"),
        (RunnerErrorClass::Other, "OTHER", "other"),
    ];
    for (class, tag, fingerprint) in pinned {
        assert_eq!(class.tag_name(), tag);
        assert_eq!(class.fingerprint_token(), fingerprint);
    }
    // Completeness: every ALL variant is pinned above, so a future variant
    // added without a pinned tag/fingerprint pair fails here.
    assert_eq!(pinned.len(), RunnerErrorClass::ALL.len());
}

#[test]
fn new_errno_classes_are_named_while_op_axis_still_reports_rename() {
    // A plain-Node ENOENT rename fault: describeError renders
    // `code=ENOENT ENOENT: no such file …, rename …`. The class axis now
    // reports a real ENOENT class instead of OTHER while the op axis keeps
    // reporting rename from the same message.
    let enoent_rename = "code=ENOENT ENOENT: no such file or directory, rename 'a' -> 'b'";
    assert_eq!(
        classify_runner_error_class(enoent_rename),
        RunnerErrorClass::Enoent
    );
    assert_eq!(
        classify_runner_error_op(enoent_rename),
        RunnerErrorOp::Rename
    );
    // The other three new classes classify from their errno substrings.
    assert_eq!(
        classify_runner_error_class("EEXIST: file already exists, mkdir 'x'"),
        RunnerErrorClass::Eexist
    );
    assert_eq!(
        classify_runner_error_class("ENOTEMPTY: directory not empty, rmdir 'x'"),
        RunnerErrorClass::Enotempty
    );
    assert_eq!(
        classify_runner_error_class("EXDEV: cross-device link not permitted, rename 'a' -> 'b'"),
        RunnerErrorClass::Exdev
    );
}

#[test]
fn errno_class_requires_a_bounded_token_not_a_substring_of_a_word() {
    // The new errno class checks match a bounded token, so an errno spelled
    // INSIDE an ordinary word does not misclassify: "preexisting" contains the
    // substring "eexist" but is not an EEXIST fault.
    assert_eq!(
        classify_runner_error_class("failed to load cmp_preexisting entity"),
        RunnerErrorClass::Other
    );
    // A real describeError errno rendering still classifies …
    assert_eq!(
        classify_runner_error_class("code=EEXIST EEXIST: file already exists, mkdir 'x'"),
        RunnerErrorClass::Eexist
    );
    // … including an errno as the bounded token at the end of the message.
    assert_eq!(
        classify_runner_error_class("conflict mirror index write failed: EEXIST"),
        RunnerErrorClass::Eexist
    );
}

#[test]
fn errno_fault_populates_cause_class_op_and_path_axes_together() {
    // record_error drives every axis from the SAME message: an ENOENT rename
    // fault names the enoent cause AND the ENOENT class AND the rename op,
    // with the path root unchanged — the cause and class axes agree.
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "knowledge/hq-core/a.md".to_string(),
        message: "code=ENOENT ENOENT: no such file or directory, rename 'a' -> 'b'".to_string(),
    });
    assert_eq!(
        totals.runner_error_rollup.tag_value().as_deref(),
        Some("ENOENT:1")
    );
    assert_eq!(
        totals.runner_error_ops.tag_value().as_deref(),
        Some("rename:1")
    );
    assert_eq!(
        totals.runner_error_causes.tag_value().as_deref(),
        Some("enoent:1")
    );
    assert_eq!(
        totals.runner_error_path_roots.tag_value().as_deref(),
        Some("knowledge:1")
    );
}

#[test]
fn a_new_errno_class_blocks_disk_full_suppression() {
    // A pass with ENOSPC AND a new errno class (ENOENT) is NOT exclusively
    // disk-full: the new class must count as a non-disk-full error, exactly as
    // OTHER did before, so suppression behaviour is unchanged.
    let mut mixed = RunnerErrorRollup::default();
    mixed.record("ENOSPC: no space left on device, write 'x'");
    mixed.record("code=ENOENT ENOENT: no such file, rename 'a' -> 'b'");
    assert!(mixed.has_non_disk_full_error());
    assert!(!mixed.is_exclusively_disk_full());
}

#[test]
fn runner_error_rollup_group_token_is_pinned_for_the_hq_desktop_4t_shape() {
    // The event that motivated this fix: an all-OTHER flood must still group
    // as `other`, and an empty pass as `none`.
    let mut rollup = RunnerErrorRollup::default();
    for _ in 0..7205 {
        rollup.record("download skipped: local parent escaped the sync root");
    }
    assert_eq!(rollup.fingerprint_token(), "other");
    assert_eq!(RunnerErrorRollup::default().fingerprint_token(), "none");
}

#[test]
fn termination_fingerprint_token_is_pinned() {
    // exit:2 is the exact HQ-DESKTOP-4T termination; it must not regroup.
    assert_eq!(termination_fingerprint_token(Some(2), None), "exit:2");
    assert_eq!(termination_fingerprint_token(None, Some(15)), "signal:15");
    assert_eq!(
        termination_fingerprint_token(Some(0), Some(15)),
        "invalid:exit:0+signal:15"
    );
    assert_eq!(termination_fingerprint_token(None, None), "unknown");
}

#[test]
fn exit_disposition_is_pinned_across_the_alert_boundary() {
    // Alertable exit-2 (HQ-DESKTOP-4T) still alerts …
    assert_eq!(
        classify_runner_exit_disposition(Some(2), None, true, true, false),
        RunnerExitDisposition::Alert
    );
    assert!(should_alert_on_nonzero_exit(
        Some(2),
        None,
        true,
        true,
        false
    ));
    // … and a benign exit-2 fully explained by non-alertable errors is still
    // ignored — attribution must not flip either verdict.
    assert_eq!(
        classify_runner_exit_disposition(Some(2), None, true, false, false),
        RunnerExitDisposition::Ignore
    );
    assert!(!should_alert_on_nonzero_exit(
        Some(2),
        None,
        true,
        false,
        false
    ));
    // Node-too-old and transient-retry precedence unchanged.
    assert_eq!(
        classify_runner_exit_disposition(Some(2), None, true, true, true),
        RunnerExitDisposition::NodeTooOld
    );
    assert_eq!(
        classify_runner_exit_disposition(
            Some(RUNNER_TRANSIENT_RETRY_EXIT),
            None,
            false,
            false,
            false
        ),
        RunnerExitDisposition::TransientRetry
    );
    // A concurrent alertable fault still wins over a cancellation record.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(2),
            None,
            Some(SyncCancelCause::UserStop),
            true,
            true,
            true,
            false,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn runner_error_scope_splits_company_and_file_without_leaking_paths() {
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message: "Entity not found".to_string(),
    });
    for i in 0..3 {
        totals.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: format!("knowledge/secret-file-{i}.md"),
            message: "download skipped: local parent escaped the sync root".to_string(),
        });
    }
    assert_eq!(
        totals.runner_error_scope().as_deref(),
        Some("company:1,file:3")
    );
    // The shape + path-root rollups render only fixed tokens, never the seeded
    // path bytes.
    let shapes = totals
        .runner_error_shapes
        .tag_value()
        .expect("shapes present");
    let roots = totals
        .runner_error_path_roots
        .tag_value()
        .expect("roots present");
    // 3 per-file containment escapes + the company-scope "Entity not found"
    // (unknown shape). Path roots exclude the `(company)` sentinel entirely.
    assert_eq!(shapes, "containment_escape:3,unknown:1");
    assert_eq!(roots, "knowledge:3");
    for rendered in [&shapes, &roots] {
        assert!(!rendered.contains("secret-file"));
        assert!(!rendered.contains("acme"));
    }
}

#[test]
fn runner_error_scope_counts_discovery_separately_and_never_path_roots_it() {
    let mut totals = RunTotals::default();
    // A pre-fanout discovery failure: company absent, path is the sentinel.
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(discovery)".to_string(),
        message: "Vault unreachable".to_string(),
    });
    totals.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "knowledge/a.md".to_string(),
        message: "download skipped: local parent escaped the sync root".to_string(),
    });
    // Discovery is its own scope, appended after the company/file split, and
    // never counted as a per-file error …
    assert_eq!(
        totals.runner_error_scope().as_deref(),
        Some("company:0,file:1,discovery:1")
    );
    // … and never given a path root ("(discovery)" is not a file path).
    assert_eq!(
        totals.runner_error_path_roots.tag_value().as_deref(),
        Some("knowledge:1")
    );
    // Its message shape is still recorded like any other error.
    assert_eq!(
        totals.runner_error_shapes.tag_value().as_deref(),
        Some("containment_escape:1,unknown:1")
    );
}

#[test]
fn a_named_cause_drives_the_error_class_instead_of_the_keyword_fallback() {
    // The HQ-DESKTOP-4T recurrence: a VaultPermissionDeniedError whose text
    // carries none of the class matcher's keywords collapsed to OTHER on base,
    // so every such exit-2 landed on the one catch-all fingerprint. The cause
    // axis names it, and the bridge now classes it AUTH — for every rendering
    // that actually carries the identifier the cause axis can read.
    for message in [
        // Leading class name (the dominant describeError rendering).
        "VaultPermissionDeniedError permission denied for the company prefix",
        // The identity carried as a `cause=` value behind a plain Error.
        "sync worker failed cause=VaultPermissionDeniedError host=vault",
    ] {
        assert_eq!(
            classify_runner_error_cause(message),
            RunnerErrorCause::VaultPermissionDenied,
            "cause axis must name the fault: {message:?}"
        );
        assert_eq!(
            classify_runner_error_class(message),
            RunnerErrorClass::Auth,
            "a named vault permission denial must class AUTH, not OTHER: {message:?}"
        );
    }

    // The whole permission/authorization family classes AUTH, so none of them
    // can re-form the exit-2 catch-all the keyword matcher left them in.
    for (message, cause) in [
        (
            "AccessDenied access is denied",
            RunnerErrorCause::AccessDenied,
        ),
        (
            "VendDeniedError the vend was refused",
            RunnerErrorCause::VendDenied,
        ),
        (
            "EntityPermissionError caller lacks permission",
            RunnerErrorCause::EntityPermission,
        ),
    ] {
        assert_eq!(classify_runner_error_cause(message), cause, "{message:?}");
        assert_eq!(
            classify_runner_error_class(message),
            RunnerErrorClass::Auth,
            "permission/authorization family must class AUTH: {message:?}"
        );
    }

    // A named DNS/transport fault the keyword matcher omits (ENOTFOUND is not
    // in is_transient_network_error) now classes NETWORK through the cause.
    assert_eq!(
        classify_runner_error_class("ENOTFOUND: getaddrinfo failed for the vault host"),
        RunnerErrorClass::Network
    );
}

#[test]
fn an_unnamed_message_still_uses_the_keyword_classifier_unchanged() {
    // The bridge fires ONLY for a positively-named cause. An unnamed message
    // is classified exactly as before, so nothing the keyword matcher already
    // handled changes.

    // Pure pull-leg prose with no identity: unnamed on the cause axis, so the
    // bridge yields None and the keyword matcher decides — OTHER, as today.
    let prose = "download skipped: local parent escaped the sync root";
    assert_eq!(
        classify_runner_error_cause(prose),
        RunnerErrorCause::UnknownUnnamed
    );
    assert_eq!(classify_runner_error_class(prose), RunnerErrorClass::Other);

    // Content-safety boundary: a permission denial rendered as PROSE ONLY —
    // no class name, no code — has no content-safe identity to key on, so it
    // is NOT bridged to AUTH. Naming it would require reading free prose.
    assert_eq!(
        classify_runner_error_class("access to the company prefix was denied"),
        RunnerErrorClass::Other
    );

    // The keyword matcher still owns every class it already decided: an EPERM
    // rename (the bridge agrees), a transient-network "socket hang up" the
    // cause axis cannot name, and a bare auth marker.
    assert_eq!(
        classify_runner_error_class("EPERM: operation not permitted, rename 'a.hq-tmp' -> 'a'"),
        RunnerErrorClass::Eperm
    );
    assert_eq!(
        classify_runner_error_class("upload failed: socket hang up"),
        RunnerErrorClass::Network
    );
    assert_eq!(
        classify_runner_error_class("Unauthorized: cognito rejected the request"),
        RunnerErrorClass::Auth
    );
}

#[test]
fn auth_markers_match_as_bounded_tokens_not_in_word_substrings() {
    // HQ-DESKTOP-67: a manual-route exit-2 reached Sentry with 96 path-led
    // stderr breadcrumbs reading `identity` because the keyword matcher scanned
    // for `auth`/`token` with an unbounded `contains`. A path segment, a package
    // name, or a JSON key that merely SPELLS a marker in-word must now classify
    // OTHER (breadcrumb `other`), while a marker standing as its own word still
    // classifies AUTH (breadcrumb `identity`).

    // In-word occurrences → OTHER. None of these carries a standalone marker.
    for line in [
        // `auth` inside `authors` (path segment).
        "/Users/dev/hq/personal/library/authors/index.md",
        // `token` inside the `token-providers` package name (hyphen connector).
        "/Users/dev/.npm/_cacache/@aws-sdk/token-providers/dist/index.js",
        // `token` inside the `tokenCount` JSON key (camelCase).
        "tokenCount mismatch in manifest",
        // `auth` as a whole path segment is still bounded by `/` connectors, so a
        // bare path never reads as an identity failure.
        "/var/run/auth/worker.sock is unavailable",
    ] {
        assert_eq!(
            classify_runner_error_class(line),
            RunnerErrorClass::Other,
            "in-word marker must classify OTHER, not AUTH: {line:?}"
        );
    }
    // The class the breadcrumb renders for the dominant path-led line is the
    // denylist-safe `other`, NOT `identity` — the exact byte the event got wrong.
    assert_eq!(
        classify_runner_error_class("/Users/dev/hq/personal/library/authors/index.md")
            .breadcrumb_token(),
        "other"
    );

    // Standalone markers → AUTH, including `oauth` (which bounded matching would
    // otherwise miss because `auth` inside `oauth` is itself in-word).
    for line in [
        "auth request failed",
        "oauth handshake aborted",
        "the request was unauthorized",
        "forbidden",
        "cognito refused the refresh",
        "the token was rejected",
    ] {
        assert_eq!(
            classify_runner_error_class(line),
            RunnerErrorClass::Auth,
            "standalone marker must still classify AUTH: {line:?}"
        );
    }
    // A genuine identity failure keeps the denylist-safe `identity` spelling.
    assert_eq!(
        classify_runner_error_class("Unauthorized: cognito rejected the request")
            .breadcrumb_token(),
        "identity"
    );

    // Full-word and protocol auth forms that a bounded `auth`/`token` match alone
    // would drop still classify AUTH: the `auth-error` protocol discriminator that
    // runner_stderr_needs_reauth acts on, and `authentication`/`authorization`
    // prose, are recognized by the unambiguous auth vocabulary — while
    // `authors`/`token-providers`/`tokenCount` (checked above) stay OTHER.
    for line in [
        r#"{"type":"auth-error","message":"Sign in again"}"#,
        "authentication failed",
        "authorization denied for the company prefix",
        "reauthentication required",
    ] {
        assert_eq!(
            classify_runner_error_class(line),
            RunnerErrorClass::Auth,
            "genuine auth form must classify AUTH: {line:?}"
        );
    }

    // The shared bounded-token refactor preserves the errno boundary exactly:
    // a real errno rendering still classifies, `eexist` inside `preexisting` does
    // not (the regression message_contains_errno_token was introduced to stop).
    assert_eq!(
        classify_runner_error_class("EEXIST: file already exists, mkdir 'x'"),
        RunnerErrorClass::Eexist
    );
    assert_eq!(
        classify_runner_error_class("failed to load cmp_preexisting entity"),
        RunnerErrorClass::Other
    );
}

#[test]
fn every_runner_error_cause_has_a_deliberate_class_decision() {
    use RunnerErrorCause as C;
    // Every deliberate NON-None decision, spelled out so a wrong remap or an
    // unreviewed future variant fails here. The match in class_for_named_cause
    // is already exhaustive (a missing variant is a compile error); this table
    // additionally pins WHICH class each mapped cause chose, and asserts every
    // other variant keeps the keyword fallback (None).
    let auth = [
        C::EntityPermission,
        C::VaultPermissionDenied,
        C::VendDenied,
        C::AccessDenied,
        C::VaultIdentity,
        C::CognitoIdentity,
        C::CognitoIdentityRefresh,
        C::ExpiredIdentity,
        C::InvalidIdentity,
    ];
    let network = [
        C::Econnreset,
        C::Econnrefused,
        C::Etimedout,
        C::Epipe,
        C::EaiAgain,
        C::Enetdown,
        C::Enetunreach,
        C::Ehostunreach,
        C::Enotfound,
    ];
    let errno_class = [
        (C::Eperm, RunnerErrorClass::Eperm),
        (C::Eacces, RunnerErrorClass::Eacces),
        (C::Enospc, RunnerErrorClass::Enospc),
        (C::Ebusy, RunnerErrorClass::Ebusy),
        (C::Enoent, RunnerErrorClass::Enoent),
        (C::Eexist, RunnerErrorClass::Eexist),
        (C::Enotempty, RunnerErrorClass::Enotempty),
        (C::Exdev, RunnerErrorClass::Exdev),
    ];
    for cause in auth {
        assert_eq!(
            class_for_named_cause(cause),
            Some(RunnerErrorClass::Auth),
            "{cause:?} must bridge to AUTH"
        );
    }
    for cause in network {
        assert_eq!(
            class_for_named_cause(cause),
            Some(RunnerErrorClass::Network),
            "{cause:?} must bridge to NETWORK"
        );
    }
    for (cause, class) in errno_class {
        assert_eq!(class_for_named_cause(cause), Some(class), "{cause:?}");
    }
    let is_mapped = |c: RunnerErrorCause| {
        auth.contains(&c) || network.contains(&c) || errno_class.iter().any(|(mc, _)| *mc == c)
    };
    let mut mapped = 0;
    for cause in RunnerErrorCause::ALL {
        if is_mapped(cause) {
            mapped += 1;
        } else {
            assert_eq!(
                class_for_named_cause(cause),
                None,
                "{cause:?} must keep the keyword fallback (None)"
            );
        }
    }
    assert_eq!(
        mapped, 26,
        "exactly 26 causes bridge to a class; every other variant stays None"
    );
}

#[test]
fn record_error_populates_new_axes_across_scopes_without_perturbing_existing_ones() {
    let mut totals = RunTotals::default();
    // Company-scope describeError carrying an `http=` status, an AWS name, and
    // a secret-looking `host=` that must never surface on any axis.
    totals.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message:
            "AccessDenied http=403 host=hq-vault-cmp-acme-9f3.s3.us-east-1.amazonaws.com denied"
                .to_string(),
    });
    // Per-file presigned failures carrying the status in the `: <status>` tail.
    for i in 0..3 {
        totals.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: format!("knowledge/secret-{i}.md"),
            message: format!("presigned GET failed for knowledge/secret-{i}.md: 500 "),
        });
    }
    // A pre-fanout discovery describeError with its own `http=` status + name.
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(discovery)".to_string(),
        message: "InternalError http=500 we encountered an internal error".to_string(),
    });

    // New axes are populated for company-, per-file-, and discovery-scope
    // errors alike — the company-scope path is precisely the one that yielded
    // nothing before this change.
    assert_eq!(
        totals.runner_error_http.tag_value().as_deref(),
        Some("http_500:4,http_403:1")
    );
    assert_eq!(
        totals.runner_error_causes.tag_value().as_deref(),
        Some("unknown_unnamed:3,access_denied:1,internal_error:1")
    );
    // No unlisted (uppercase-initial, unmatched) identity appeared: AccessDenied
    // and InternalError are named, the presigned prose is unnamed — so the
    // signature axis attaches no tag.
    assert_eq!(totals.runner_error_cause_signature.tag_value(), None);

    // The scope, shape, path-root, and op axes are byte-identical to their
    // pre-change values for the same inputs — the cause bridge perturbs none
    // of them.
    assert_eq!(
        totals.runner_error_scope().as_deref(),
        Some("company:1,file:3,discovery:1")
    );
    assert_eq!(
        totals.runner_error_shapes.tag_value().as_deref(),
        Some("presigned_get_failed:3,unknown:2")
    );
    assert_eq!(
        totals.runner_error_path_roots.tag_value().as_deref(),
        Some("knowledge:3")
    );
    // The CLASS rollup now names the AccessDenied company-scope record AUTH
    // via the r3 cause→class bridge — its text carries none of the keyword
    // markers the class matcher looks for, so before this fix it collapsed to
    // OTHER. The four unnamed presigned/InternalError records stay OTHER, and
    // the dominant-by-count fingerprint token is unchanged (OTHER, 4 > 1).
    assert_eq!(
        totals.runner_error_rollup.tag_value().as_deref(),
        Some("AUTH:1,OTHER:4")
    );
    assert_eq!(
        totals.runner_error_ops.tag_value().as_deref(),
        Some("other:5")
    );
    assert_eq!(totals.runner_error_rollup.fingerprint_token(), "other");
    assert!(totals.saw_alertable_error);

    // Content safety: the rendered new-axis tags carry no host or path byte.
    for rendered in [
        totals.runner_error_http.tag_value().unwrap(),
        totals.runner_error_causes.tag_value().unwrap(),
    ] {
        for fragment in ["hq-vault", "acme", "9f3", "amazonaws", "secret-"] {
            assert!(
                !rendered.contains(fragment),
                "new-axis tag leaked {fragment:?}: {rendered}"
            );
        }
    }
}

// ── describe_exit ────────────────────────────────────────────────────────────

#[test]
fn describe_exit_with_normal_exit_code() {
    assert_eq!(describe_exit(Some(0), None), "with code 0");
    assert_eq!(describe_exit(Some(1), None), "with code 1");
    assert_eq!(describe_exit(Some(127), None), "with code 127");
}

#[test]
fn describe_exit_names_well_known_signals() {
    assert!(describe_exit(None, Some(9)).contains("SIGKILL"));
    assert!(describe_exit(None, Some(15)).contains("SIGTERM"));
    assert!(describe_exit(None, Some(11)).contains("SIGSEGV"));
    assert!(describe_exit(None, Some(10)).contains("SIGBUS"));
    assert!(describe_exit(None, Some(6)).contains("SIGABRT"));
    assert!(describe_exit(None, Some(2)).contains("SIGINT"));
    assert!(describe_exit(None, Some(1)).contains("SIGHUP"));
}

#[test]
fn describe_exit_falls_back_to_signal_number() {
    assert_eq!(describe_exit(None, Some(31)), "killed by signal 31");
}

#[test]
fn describe_exit_with_neither_returns_unknown() {
    assert_eq!(describe_exit(None, None), "with code unknown");
}

#[test]
fn describe_exit_prefers_code_over_signal() {
    // Should never happen in practice (POSIX is XOR), but be defensive.
    assert_eq!(describe_exit(Some(42), Some(9)), "with code 42");
}

#[test]
fn describe_exit_names_every_signal_only_shape_the_watcher_fallback_reaches() {
    // The watcher-exit fallback now routes signal-only terminations through
    // this renderer instead of a raw Debug tuple, so pin the exact strings —
    // SIGHUP being the one HQ-DESKTOP-5Y observed as `code=None signal=Some(1)`.
    assert_eq!(describe_exit(None, Some(SIGHUP_SIGNAL)), "killed by SIGHUP");
    assert_eq!(describe_exit(None, Some(SIGINT_SIGNAL)), "killed by SIGINT");
    assert_eq!(
        describe_exit(None, Some(SIGKILL_SIGNAL)),
        "killed by SIGKILL (likely OOM or force-quit)"
    );
    assert_eq!(
        describe_exit(None, Some(SIGSEGV_SIGNAL)),
        "crashed with SIGSEGV (segfault)"
    );
    assert_eq!(
        describe_exit(None, Some(SIGBUS_SIGNAL_MACOS)),
        "crashed with SIGBUS"
    );
    assert_eq!(
        describe_exit(None, Some(SIGABRT_SIGNAL)),
        "aborted with SIGABRT"
    );
    assert_eq!(
        describe_exit(None, Some(SIGTERM_SIGNAL)),
        "killed by SIGTERM (cancelled)"
    );
    // An unmapped signal still names itself rather than leaking a raw tuple.
    assert_eq!(describe_exit(None, Some(31)), "killed by signal 31");
}

#[test]
fn watcher_exit_signal_class_is_a_closed_vocabulary() {
    // A signal-free exit is `none`; SIGHUP is `hangup`.
    assert_eq!(watcher_exit_signal_class(None), "none");
    assert_eq!(watcher_exit_signal_class(Some(SIGHUP_SIGNAL)), "hangup");
    assert_eq!(watcher_exit_signal_class(Some(SIGINT_SIGNAL)), "interrupt");
    assert_eq!(watcher_exit_signal_class(Some(SIGTERM_SIGNAL)), "cancel");

    // Exhaustive over the POSIX signal range: every signal maps to exactly one
    // of the six fixed tokens, and the `fault` arm is byte-for-byte the
    // `is_crash_signal` set (so the two can never drift).
    const VOCAB: [&str; 6] = ["fault", "cancel", "hangup", "interrupt", "other", "none"];
    for sig in 1..=31 {
        let class = watcher_exit_signal_class(Some(sig));
        assert!(
            VOCAB.contains(&class),
            "signal {sig} produced out-of-vocabulary class {class}"
        );
        assert_eq!(
            class == "fault",
            is_crash_signal(Some(sig)),
            "fault-arm drift from is_crash_signal at signal {sig}"
        );
    }
}

#[test]
fn watcher_exit_class_groups_known_native_and_node_fatal_exits() {
    assert_eq!(
        watcher_exit_class(Some(RUNNER_ALREADY_OWNED_EXIT), None, false, false),
        "already_owned"
    );
    assert_eq!(watcher_exit_class(Some(19), None, false, false), "other");
    assert_eq!(watcher_exit_class(Some(21), None, false, false), "other");
    assert_eq!(
        watcher_exit_class(Some(0xC000_0005u32 as i32), None, false, false),
        "access_violation"
    );
    assert_eq!(
        watcher_exit_class(Some(0xC000_0409u32 as i32), None, false, false),
        "stack_buffer_overrun"
    );
    assert_eq!(
        watcher_exit_class(Some(WINDOWS_SESSION_TERMINATE_EXIT), None, false, false),
        "dbg_terminate"
    );
    assert_eq!(
        watcher_exit_class(Some(-1), None, false, false),
        "minus_one"
    );
    assert_eq!(
        watcher_exit_class(None, Some(SIGTERM_SIGNAL), false, false),
        "sigterm"
    );
    assert_eq!(
        watcher_exit_class(None, Some(SIGKILL_SIGNAL), false, false),
        "sigkill"
    );
    assert_eq!(watcher_exit_class(Some(1), None, true, false), "node_fatal");
    assert_eq!(watcher_exit_class(Some(127), None, false, false), "other");
}

#[test]
fn watcher_exit_class_carries_disk_full_and_preserves_unknown_exits() {
    assert_eq!(
        watcher_exit_class_with_fatal_cause(Some(21), None, false, false, false, "disk_full"),
        "disk_full"
    );
    assert_eq!(
        watcher_exit_class_with_fatal_cause(Some(21), None, false, false, false, "none"),
        "other"
    );
    assert_eq!(
        watcher_exit_class_with_fatal_cause(
            None,
            Some(SIGSEGV_SIGNAL),
            false,
            false,
            false,
            "disk_full"
        ),
        "other"
    );
    assert_eq!(
        watcher_exit_class_with_fatal_cause(Some(21), None, false, false, true, "disk_full"),
        "other"
    );
    assert_eq!(
        watcher_exit_class_with_fatal_cause(
            Some(0xC000_001Du32 as i32),
            None,
            false,
            false,
            false,
            "disk_full"
        ),
        "other"
    );
}

#[test]
fn watcher_exit_class_converges_only_evidence_backed_memory_deaths() {
    let memory_deaths = [
        (None, Some(SIGKILL_SIGNAL), false, "sigkill"),
        (None, Some(SIGABRT_SIGNAL), false, "other"),
        (
            Some(0xC000_0409u32 as i32),
            None,
            false,
            "stack_buffer_overrun",
        ),
    ];

    for (code, signal, node_fatal, unproven_class) in memory_deaths {
        assert_eq!(
            watcher_exit_class(code, signal, node_fatal, false),
            unproven_class,
            "without memory evidence the host exit class stays distinct"
        );
        assert_eq!(
            watcher_exit_class(code, signal, node_fatal, true),
            "runner_memory",
            "evidence-backed memory deaths converge across host encodings"
        );
    }
}

#[test]
fn watcher_exit_fingerprint_groups_variable_unknown_statuses_by_class() {
    let first = [
        "sync-watcher-exit",
        watcher_exit_class(Some(127), None, false, false),
    ];
    let second = [
        "sync-watcher-exit",
        watcher_exit_class(Some(143), None, false, false),
    ];
    assert_eq!(first, second);
}

#[test]
fn watcher_fingerprint_tokens_are_unchanged_across_the_shape_matrix() {
    // This fix is reporting-only: it changes the message text, never the
    // fingerprint. Pin the three fingerprint helpers for the full shape matrix
    // so a grouping regression fails loudly. SIGHUP stays `signal:1`.
    let none = MemoryExhaustionEvidence::default();
    let cases: [(Option<i32>, Option<i32>, &str); 6] = [
        (None, Some(SIGHUP_SIGNAL), "signal:1"),
        (None, Some(SIGKILL_SIGNAL), "signal:9"),
        (Some(221), None, "exit:221"),
        (
            Some(0xC000_0409u32 as i32),
            None,
            "windows:fault:0xC0000409",
        ),
        (Some(3), Some(9), "invalid:exit:3+signal:9"),
        (None, None, "unknown"),
    ];
    for (code, signal, token) in cases {
        assert_eq!(termination_fingerprint_token(code, signal), token);
        // With no memory evidence the watcher token is exactly the host token.
        assert_eq!(
            watcher_termination_fingerprint_token(code, signal, TerminationHost::Posix, none),
            termination_fingerprint_token_for_host(code, signal, TerminationHost::Posix)
        );
    }
    // SIGABRT is the one shape normalized away from its raw signal token, on
    // BOTH hosts — pinned so the fix does not disturb that convergence.
    assert_eq!(
        termination_fingerprint_token_for_host(None, Some(SIGABRT_SIGNAL), TerminationHost::Posix),
        "abort:sigabrt"
    );
    assert_eq!(
        termination_fingerprint_token_for_host(
            Some(NODE_WINDOWS_ABORT_EXIT),
            None,
            TerminationHost::Windows
        ),
        "abort:sigabrt"
    );
    // SIGHUP is NOT normalized: its host token is its raw signal token.
    assert_eq!(
        termination_fingerprint_token_for_host(None, Some(SIGHUP_SIGNAL), TerminationHost::Posix),
        "signal:1"
    );
}

#[test]
fn windows_exit_statuses_are_classified_from_independent_hex_literals() {
    assert_eq!(
        classify_windows_exit_status(0xC000_013Au32 as i32),
        WindowsTermination::ConsoleControl
    );
    assert_eq!(
        classify_windows_exit_status(0x4001_0004u32 as i32),
        WindowsTermination::SessionTerminate
    );
    assert_eq!(
        classify_windows_exit_status(0xFFFF_FFFFu32 as i32),
        WindowsTermination::IndeterminateStatus
    );
    for raw in [0xC000_0005u32, 0xC000_00FD, 0xC000_0409] {
        assert_eq!(
            classify_windows_exit_status(raw as i32),
            WindowsTermination::Fault(raw),
            "0x{raw:08X} must remain an alertable Windows fault"
        );
    }
    assert_eq!(
        classify_windows_exit_status(17),
        WindowsTermination::Ordinary(17)
    );
}

#[test]
fn windows_exit_descriptions_keep_the_raw_hex_and_class() {
    assert_eq!(
        describe_exit(Some(0xFFFF_FFFFu32 as i32), None),
        "with Windows status 0xFFFFFFFF (origin unknown)"
    );
    assert_eq!(
        describe_exit(Some(0xC000_0409u32 as i32), None),
        "with Windows status 0xC0000409 (fault)"
    );
}

#[test]
fn session_terminate_exit_description_pins_the_sentry_wire_value() {
    // Sentry reports this status as a positive decimal, whereas the
    // Windows classifier reads its bit pattern. Pin both spellings so a
    // future refactor cannot accidentally turn it back into exit:1073807364.
    const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
    assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);
    assert_eq!(
        describe_exit(Some(OBSERVED_SESSION_TERMINATE_EXIT), None),
        "with Windows status 0x40010004 (session terminate)"
    );
}

#[test]
fn termination_fingerprint_separates_exit_codes_from_signals() {
    assert_eq!(termination_fingerprint_token(Some(2), None), "exit:2");
    assert_eq!(termination_fingerprint_token(None, Some(2)), "signal:2");
    assert_eq!(termination_fingerprint_token(Some(126), None), "exit:126");
    assert_eq!(
        termination_fingerprint_token(Some(WINDOWS_CONTROL_C_EXIT), None),
        "windows:console-control"
    );
    assert_eq!(
        termination_fingerprint_token(Some(0xFFFF_FFFFu32 as i32), None),
        "windows:status-ffffffff"
    );
    assert_eq!(
        termination_fingerprint_token(Some(0xC000_0409u32 as i32), None),
        "windows:fault:0xC0000409"
    );
    assert_ne!(
        termination_fingerprint_token(Some(2), None),
        termination_fingerprint_token(Some(126), None)
    );
}

#[test]
fn session_terminate_fingerprint_is_windows_scoped_not_a_posix_exit() {
    const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
    assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);
    assert_eq!(
        termination_fingerprint_token(Some(OBSERVED_SESSION_TERMINATE_EXIT), None),
        "windows:session-terminate"
    );
    assert_ne!(
        termination_fingerprint_token(Some(OBSERVED_SESSION_TERMINATE_EXIT), None),
        "exit:1073807364"
    );
}

#[test]
fn termination_fingerprint_isolates_invalid_dual_statuses() {
    assert_eq!(
        termination_fingerprint_token(Some(2), Some(2)),
        "invalid:exit:2+signal:2"
    );
    assert_eq!(termination_fingerprint_token(None, None), "unknown");
}

#[test]
fn normalized_abort_fingerprints_join_only_the_observed_host_encodings() {
    for (code, signal, host) in [
        (
            Some(NODE_WINDOWS_ABORT_EXIT),
            None,
            TerminationHost::Windows,
        ),
        (None, Some(SIGABRT_SIGNAL), TerminationHost::Posix),
        (None, Some(SIGABRT_SIGNAL), TerminationHost::Windows),
    ] {
        assert_eq!(
            termination_fingerprint_token_for_host(code, signal, host),
            "abort:sigabrt"
        );
    }

    assert_eq!(
        termination_fingerprint_token_for_host(
            Some(NODE_WINDOWS_ABORT_EXIT),
            None,
            TerminationHost::Posix,
        ),
        "exit:134"
    );
}

#[test]
fn normalized_abort_descriptions_are_exact_and_host_scoped() {
    assert_eq!(
        normalized_abort_description(None, Some(SIGABRT_SIGNAL), TerminationHost::Posix),
        Some("aborted with SIGABRT")
    );
    assert_eq!(
        normalized_abort_description(None, Some(SIGABRT_SIGNAL), TerminationHost::Windows),
        Some("aborted with SIGABRT")
    );
    assert_eq!(
        normalized_abort_description(
            Some(NODE_WINDOWS_ABORT_EXIT),
            None,
            TerminationHost::Windows,
        ),
        Some("aborted (Node abort exit code 134)")
    );

    for (code, signal, host) in [
        (Some(NODE_WINDOWS_ABORT_EXIT), None, TerminationHost::Posix),
        (
            Some(NODE_WINDOWS_ABORT_EXIT),
            Some(SIGABRT_SIGNAL),
            TerminationHost::Windows,
        ),
        (None, None, TerminationHost::Posix),
        (Some(221), None, TerminationHost::Windows),
    ] {
        assert_eq!(normalized_abort_description(code, signal, host), None);
    }
}

#[test]
fn non_abort_host_tokens_delegate_byte_for_byte_to_the_base_contract() {
    let cases = [
        (Some(0), None, "exit:0"),
        (Some(1), None, "exit:1"),
        (Some(2), None, "exit:2"),
        (Some(126), None, "exit:126"),
        (Some(127), None, "exit:127"),
        (Some(221), None, "exit:221"),
        (
            Some(WINDOWS_CONTROL_C_EXIT),
            None,
            "windows:console-control",
        ),
        (
            Some(WINDOWS_SESSION_TERMINATE_EXIT),
            None,
            "windows:session-terminate",
        ),
        (
            Some(0xC000_0409u32 as i32),
            None,
            "windows:fault:0xC0000409",
        ),
        (Some(2), Some(2), "invalid:exit:2+signal:2"),
        (None, None, "unknown"),
    ];

    for host in [TerminationHost::Posix, TerminationHost::Windows] {
        for (code, signal, expected) in cases {
            assert_eq!(
                termination_fingerprint_token_for_host(code, signal, host),
                expected
            );
            assert_eq!(
                termination_fingerprint_token_for_host(code, signal, host),
                termination_fingerprint_token(code, signal)
            );
        }
    }
}

#[test]
fn memory_evidence_is_attributed_only_with_a_source() {
    assert!(!MemoryExhaustionEvidence::default().is_attributed());
    assert!(MemoryExhaustionEvidence {
        heap_oom_class: true,
        ..Default::default()
    }
    .is_attributed());
    assert!(MemoryExhaustionEvidence {
        footprint_at_or_above_ceiling: true,
        ..Default::default()
    }
    .is_attributed());
    assert!(MemoryExhaustionEvidence {
        supervisor_preempt: true,
        ..Default::default()
    }
    .is_attributed());
}

#[test]
fn watcher_memory_token_converges_the_three_host_encodings_when_evidenced() {
    // The three deaths in this cluster (a SIGKILL, a SIGABRT heap abort, and a
    // Windows fault) each carry a DISTINCT host token before convergence.
    let encodings = [
        (None, Some(9), TerminationHost::Posix, "signal:9"),
        (
            None,
            Some(SIGABRT_SIGNAL),
            TerminationHost::Posix,
            "abort:sigabrt",
        ),
        (
            Some(0xC000_0409u32 as i32),
            None,
            TerminationHost::Windows,
            "windows:fault:0xC0000409",
        ),
    ];
    // Each evidence source, on its own, collapses every encoding to one token.
    let evidences = [
        MemoryExhaustionEvidence {
            heap_oom_class: true,
            ..Default::default()
        },
        MemoryExhaustionEvidence {
            footprint_at_or_above_ceiling: true,
            ..Default::default()
        },
        MemoryExhaustionEvidence {
            supervisor_preempt: true,
            ..Default::default()
        },
    ];
    for (code, signal, host, raw) in encodings {
        // Sanity: the pre-convergence token really is the distinct host token.
        assert_eq!(
            termination_fingerprint_token_for_host(code, signal, host),
            raw
        );
        for evidence in evidences {
            assert_eq!(
                watcher_termination_fingerprint_token(code, signal, host, evidence),
                RUNNER_MEMORY_EXHAUSTION_TOKEN,
                "evidenced {raw} must converge on the memory token"
            );
        }
    }
}

#[test]
fn watcher_memory_token_preserves_evidence_free_terminations_byte_for_byte() {
    // With NO memory evidence the gated token equals today's host token exactly,
    // so a force-quit is never relabelled an OOM and unrelated exits never
    // regroup. A bare SIGKILL stays signal:9.
    let none = MemoryExhaustionEvidence::default();
    for host in [TerminationHost::Posix, TerminationHost::Windows] {
        for (code, signal) in [
            (None, Some(9)),
            (None, Some(15)),
            (Some(1), None),
            (Some(0xC000_0409u32 as i32), None),
            (None, Some(SIGABRT_SIGNAL)),
            (None, None),
        ] {
            assert_eq!(
                watcher_termination_fingerprint_token(code, signal, host, none),
                termination_fingerprint_token_for_host(code, signal, host)
            );
        }
    }
    // The named example the cluster owes: an evidence-free SIGKILL stays signal:9.
    assert_eq!(
        watcher_termination_fingerprint_token(None, Some(9), TerminationHost::Posix, none),
        "signal:9"
    );
}

#[test]
fn current_termination_host_matches_the_build_target() {
    let expected = if cfg!(target_os = "windows") {
        TerminationHost::Windows
    } else {
        TerminationHost::Posix
    };
    assert_eq!(current_termination_host(), expected);
}

#[test]
fn posix_termination_tokens_and_descriptions_are_byte_identical() {
    for (code, signal, token, description) in [
        (Some(126), None, "exit:126", "with code 126"),
        (Some(127), None, "exit:127", "with code 127"),
        (Some(2), None, "exit:2", "with code 2"),
        (
            None,
            Some(11),
            "signal:11",
            "crashed with SIGSEGV (segfault)",
        ),
    ] {
        assert_eq!(termination_fingerprint_token(code, signal), token);
        assert_eq!(describe_exit(code, signal), description);
    }
    assert_eq!(
        termination_fingerprint_token(Some(2), Some(11)),
        "invalid:exit:2+signal:11"
    );
    assert_eq!(describe_exit(None, None), "with code unknown");
}

// ── RunTotals ────────────────────────────────────────────────────────

use crate::events::{
    SyncAllCompleteEvent, SyncAuthErrorEvent, SyncCompleteEvent, SyncMaintenanceProgressEvent,
    SyncProgressEvent,
};

fn complete(company: &str, conflicts: u32, aborted: bool) -> SyncEvent {
    SyncEvent::Complete(SyncCompleteEvent {
        company: company.to_string(),
        files_downloaded: 0,
        bytes_downloaded: 0,
        files_skipped: 0,
        conflicts,
        aborted,
        files_tombstoned: None,
        files_refused_stale: None,
    })
}

#[test]
fn test_run_totals_default_is_zero() {
    let t = RunTotals::default();
    assert_eq!(t.conflicts, 0);
    assert_eq!(t.runner_error_rollup.tag_value(), None);
}

#[test]
fn runner_error_rollup_is_fixed_vocabulary_and_never_leaks_path_or_message() {
    let path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
    let raw_message = format!("EPERM: rename '{path}.hq-tmp-a1b2' -> '{path}'");
    let mut totals = RunTotals::default();
    totals.record_error(&make_company_error(Some("personal"), path, &raw_message));
    totals.record_error(&make_company_error(
        Some("personal"),
        "another-private-path.md",
        "EPERM: operation not permitted",
    ));
    totals.record_error(&make_company_error(
        Some("personal"),
        "ignored-path.md",
        "EACCES: access denied",
    ));

    let tag = totals
        .runner_error_rollup
        .tag_value()
        .expect("error counts");
    assert_eq!(tag, "EPERM:2,EACCES:1");
    assert!(!tag.contains(path));
    assert!(!tag.contains("hq-tmp-a1b2"));
    assert!(!tag.contains("operation not permitted"));
}

#[test]
fn runner_error_rollup_fingerprint_token_is_dominant_class_and_permutation_stable() {
    let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
    let records = [
        (
            "personal",
            format!(
                "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
            ),
        ),
        (
            "health",
            format!("Unauthorized: cognito token rejected, open '{private_path}'"),
        ),
        (
            "personal",
            format!(
                "EPERM: operation not permitted, rename '{private_path}.hq-tmp-c3d4' -> '{private_path}'"
            ),
        ),
        (
            "health",
            format!("Unauthorized: cognito token rejected, open '{private_path}'"),
        ),
    ];

    let mut first = RunTotals::default();
    for (company, message) in &records {
        first.record_error(&make_company_error(Some(company), private_path, message));
    }

    let mut permuted = RunTotals::default();
    for (company, message) in records.iter().rev() {
        permuted.record_error(&make_company_error(Some(company), private_path, message));
    }

    assert_eq!(first.runner_error_rollup.fingerprint_token(), "eperm");
    assert_eq!(
        permuted.runner_error_rollup.fingerprint_token(),
        "eperm",
        "ties must use the fixed RunnerErrorClass declaration order"
    );
    assert_eq!(
        first.runner_error_ops.tag_value().as_deref(),
        Some("rename:2,open:2")
    );
    assert_eq!(
        permuted.runner_error_ops.tag_value(),
        first.runner_error_ops.tag_value()
    );
    assert_eq!(first.runner_error_company_count(), 2);
    assert_eq!(permuted.runner_error_company_count(), 2);
    assert_eq!(
        RunTotals::default().runner_error_rollup.fingerprint_token(),
        "none"
    );

    let mut readlink_einval = RunTotals::default();
    readlink_einval.record_error(&make_company_error(
        Some("personal"),
        private_path,
        &format!("EINVAL: invalid argument, readlink '{private_path}'"),
    ));
    assert_eq!(
        readlink_einval.runner_error_rollup.fingerprint_token(),
        "other"
    );
    assert_eq!(
        readlink_einval.runner_error_ops.tag_value().as_deref(),
        Some("readlink:1")
    );
}

#[test]
fn classify_runner_error_op_is_fixed_vocabulary_and_never_leaks_path_or_message() {
    let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
    let cases = [
        ("rename", RunnerErrorOp::Rename),
        ("unlink", RunnerErrorOp::Unlink),
        ("open", RunnerErrorOp::Open),
        ("mkdir", RunnerErrorOp::Mkdir),
        ("rmdir", RunnerErrorOp::Rmdir),
        ("symlink", RunnerErrorOp::Symlink),
        ("readlink", RunnerErrorOp::Readlink),
        ("stat", RunnerErrorOp::Stat),
        ("lstat", RunnerErrorOp::Lstat),
        ("chmod", RunnerErrorOp::Chmod),
        ("copyfile", RunnerErrorOp::Copyfile),
        ("utimes", RunnerErrorOp::Utimes),
        ("scandir", RunnerErrorOp::Scandir),
        ("read", RunnerErrorOp::Read),
        ("write", RunnerErrorOp::Write),
        ("access", RunnerErrorOp::Access),
    ];

    for (operation, expected) in cases {
        let raw_message =
            format!("EPERM: operation not permitted, {operation} '{private_path}.hq-tmp-a1b2'");
        let actual = classify_runner_error_op(&raw_message);
        assert_eq!(
            actual, expected,
            "must recognize Node's {operation} errno shape"
        );
        assert_eq!(actual.as_str(), operation);
        assert!(!actual.as_str().contains(private_path));
        assert!(!actual.as_str().contains("hq-tmp-a1b2"));
    }

    assert_eq!(
        classify_runner_error_op(&format!("custom failure at '{private_path}'")),
        RunnerErrorOp::Other
    );
}

#[test]
fn fatal_runner_signatures_are_evidence_only() {
    let mut totals = RunTotals::default();
    totals.record_stderr_line("fatal error: unrecoverable runtime failure");
    assert!(totals.saw_fatal_runner_signature);
    assert!(!totals.saw_node_too_old);
    assert!(is_fatal_runner_signature("UnhandledRejection: boom"));
    assert!(!is_fatal_runner_signature("EPERM: operation not permitted"));
}

#[test]
fn runner_fatal_class_is_fixed_vocabulary_and_never_copies_stderr() {
    let private_path = r"C:\\Users\\Ada\\hq\\companies\\personal\\secret-plan.md";
    let libuv_assertion = format!(
        "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\\\win\\\\async.c, line 76: {private_path}"
    );
    let permission_denied =
        format!("sh: {private_path}/node_modules/.bin/hq-sync-runner: Permission denied");

    assert_eq!(
        classify_runner_fatal_class(&libuv_assertion),
        RunnerFatalClass::LibuvAssert
    );
    assert_eq!(
        classify_runner_fatal_class(&permission_denied),
        RunnerFatalClass::ExecPermissionDenied
    );
    assert_eq!(
        classify_runner_fatal_class("FATAL ERROR: JavaScript heap out of memory"),
        RunnerFatalClass::HeapOom
    );
    assert_eq!(
        classify_runner_fatal_class("thread 'main' panicked at 'boom'"),
        RunnerFatalClass::RustPanic
    );
    assert_eq!(
        classify_runner_fatal_class("UnhandledRejection: boom"),
        RunnerFatalClass::NodeFatal
    );
    assert_eq!(
        classify_runner_fatal_class("sh: hq-sync-runner: command not found"),
        RunnerFatalClass::ExecNotFound
    );
    assert_eq!(
        classify_runner_fatal_class(
            "TypeError: diagnostics_channel.tracingChannel is not a function"
        ),
        RunnerFatalClass::NodeTooOld
    );
    assert_eq!(
        classify_runner_fatal_class("EPERM: operation not permitted"),
        RunnerFatalClass::None
    );
    assert_eq!(
        classify_runner_fatal_class("EACCES: permission denied, open /private/user-file"),
        RunnerFatalClass::None,
        "ordinary runner file errors are not launch failures"
    );
    assert_eq!(
        classify_runner_fatal_class("ENOENT: no such file or directory, open /private/user-file"),
        RunnerFatalClass::None,
        "ordinary runner file errors are not launch failures"
    );
    assert_eq!(classify_runner_fatal_class(""), RunnerFatalClass::None);

    let token = classify_runner_fatal_class(&libuv_assertion).as_str();
    assert_eq!(token, "libuv_assert");
    assert!(!token.contains("Ada"));
    assert!(!token.contains("secret-plan"));
}

#[test]
fn watch_owner_holder_fields_accept_only_bounded_safe_identity() {
    let line = "[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=1234, process=sync-runner, startedAt=2026-10-04T08:10:11.123Z); exiting.";
    assert_eq!(
        parse_watch_owner_holder_fields(line),
        Some(WatchOwnerHolderFields {
            owner: "hq-daemon".to_string(),
            pid: "1234".to_string(),
            process_name: "sync-runner",
            started_at: "2026-10-04T08:10:11.123Z".to_string(),
        })
    );

    // An unsafe value is replaced by `unknown`; the other fields survive and
    // the unsafe text never appears in the result.
    for (unsafe_line, secret) in [
        ("[sync] hq-sync-runner already owned for this HQ root (owner=/private/path, pid=1234, process=sync-runner, startedAt=2026-10-04T08:10:11.123Z); exiting.", "/private/path"),
        ("[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=1234, process=node /private/secret, startedAt=2026-10-04T08:10:11.123Z); exiting.", "/private/secret"),
        ("[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=1234, process=sync-runner, startedAt=secret); exiting.", "secret"),
        ("[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=-7, process=sync-runner, startedAt=2026-10-04T08:10:11.123Z); exiting.", "-7"),
    ] {
        let fields = parse_watch_owner_holder_fields(unsafe_line).expect("refusal line keeps holder evidence");
        assert!(!format!("{fields:?}").contains(secret), "{secret} leaked from {unsafe_line}");
    }
    let unsafe_owner = parse_watch_owner_holder_fields("[sync] hq-sync-runner already owned for this HQ root (owner=/private/path, pid=1234, process=sync-runner, startedAt=2026-10-04T08:10:11.123Z); exiting.").unwrap();
    assert_eq!(unsafe_owner.owner, "unknown");
    assert_eq!(unsafe_owner.pid, "1234");
    let unsafe_process = parse_watch_owner_holder_fields("[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=1234, process=node /private/secret, startedAt=2026-10-04T08:10:11.123Z); exiting.").unwrap();
    assert_eq!(unsafe_process.process_name, "unknown");
    assert_eq!(unsafe_process.started_at, "2026-10-04T08:10:11.123Z");

    assert_eq!(parse_watch_owner_holder_fields("later diagnostic 3"), None);
}

#[test]
fn watch_owner_holder_fields_read_unknown_for_pre_holder_format_line() {
    // Runners before hq-cloud #837 print only owner and pid.
    assert_eq!(
        parse_watch_owner_holder_fields(
            "[sync] hq-sync-runner already owned for this HQ root (owner=hq-daemon, pid=123); exiting."
        ),
        Some(WatchOwnerHolderFields {
            owner: "hq-daemon".to_string(),
            pid: "123".to_string(),
            process_name: "unknown",
            started_at: "unknown".to_string(),
        })
    );
}

#[test]
fn npm_relay_stderr_classifies_as_npm_install_relay_and_never_exec() {
    let home_path = "/Users/ada/.npm/_npx/f72697f8e89f117e/node_modules/.bin/hq-sync-runner";
    // npm relays a failing lifecycle status while printing only its OWN
    // `npm error …` lines. These attribute to the npm relay — including an
    // ENOENT under `_npx`, which the shell-exec `/.npm/_npx/` marker would
    // otherwise mislabel exec_not_found (the reorder-before-exec-arms fix).
    let enoent_under_npx =
        format!("npm error enoent ENOENT: no such file or directory, open '{home_path}'");
    let npm_lines = [
        "npm error code ELIFECYCLE".to_string(),
        "npm error errno 190".to_string(),
        "npm error command failed".to_string(),
        "npm error command sh -c hq-sync-runner --watch".to_string(),
        enoent_under_npx.clone(),
        "npm ERR! code E190".to_string(),
        "  npm error path /Users/ada/.npm/_npx/f72697f8e89f117e".to_string(),
    ];
    for npm_line in &npm_lines {
        assert_eq!(
            classify_runner_fatal_class(npm_line),
            RunnerFatalClass::NpmInstallRelay,
            "npm own-prefixed line must attribute to the npm relay: {npm_line:?}"
        );
    }

    // Fixed constant — no observed bytes, no path or username fragment.
    let token = classify_runner_fatal_class(&enoent_under_npx).as_str();
    assert_eq!(token, "npm_install_relay");
    assert!(!token.contains("ada"));
    assert!(!token.contains("_npx"));
    assert!(!token.contains('/'));

    // Only npm-prefixed lines change class relative to base: the shell-exec
    // legs this cluster's fix actually addresses stay exactly as they were.
    assert_eq!(
        classify_runner_fatal_class(&format!("sh: {home_path}: Permission denied")),
        RunnerFatalClass::ExecPermissionDenied
    );
    assert_eq!(
        classify_runner_fatal_class(&format!("sh: {home_path}: No such file or directory")),
        RunnerFatalClass::ExecNotFound
    );
    assert_eq!(
        classify_runner_fatal_class("bash: hq-sync-runner: command not found"),
        RunnerFatalClass::ExecNotFound
    );
    assert_eq!(
        classify_runner_fatal_class("zsh: hq-sync-runner: permission denied"),
        RunnerFatalClass::ExecPermissionDenied
    );
    // A bare node_modules/.bin marker line (no npm/shell own-prefix) keeps its
    // base class — it is not npm-prefixed, so it must not change.
    assert_eq!(
        classify_runner_fatal_class("node_modules/.bin/hq-sync-runner: No such file or directory"),
        RunnerFatalClass::ExecNotFound
    );
}

#[test]
fn watcher_owner_stderr_reports_safe_cause_producer_and_lease_result() {
    let busy = classify_runner_fatal_signature(
        "[sync] hq-sync-runner already owned for this HQ root (owner=PRIVATE_OWNER, pid=123); exiting.",
    );
    assert_eq!(busy.class, RunnerFatalClass::None);
    let busy_debug = format!("{busy:?}");
    for expected in [
        "stderr_cause: \"already_owned\"",
        "watch_owner_result: \"busy\"",
        "exit_producer: \"runner\"",
    ] {
        assert!(
            busy_debug.contains(expected),
            "missing {expected} in {busy_debug}"
        );
    }
    assert!(!busy_debug.contains("PRIVATE_OWNER"));

    let lost = classify_runner_fatal_signature(
        "[sync] watch-owner lease lost; stopping watch runner: PRIVATE_DETAIL",
    );
    assert_eq!(lost.class, RunnerFatalClass::None);
    let lost_debug = format!("{lost:?}");
    for expected in [
        "stderr_cause: \"owner_lease_lost\"",
        "watch_owner_result: \"lost\"",
        "exit_producer: \"runner\"",
    ] {
        assert!(
            lost_debug.contains(expected),
            "missing {expected} in {lost_debug}"
        );
    }
    assert!(!lost_debug.contains("PRIVATE_DETAIL"));
}

#[test]
fn libuv_fatal_syscall_is_classified_with_allow_listed_syscall_and_integer_errno() {
    // The exact live-event shape (HQ-DESKTOP-4X) that classified to `none`.
    let signature = classify_runner_fatal_signature("ReadDirectoryChangesW: (5) Access is denied.");
    assert_eq!(signature.class, RunnerFatalClass::LibuvFatalSyscall);
    assert_eq!(signature.syscall, Some("ReadDirectoryChangesW"));
    assert_eq!(signature.errno, Some(5));
    assert_eq!(signature.class.as_str(), "libuv_fatal_syscall");
    // Case-insensitive identifier match still yields the canonical constant.
    let lowercased = classify_runner_fatal_signature("readdirectorychangesw: (5) x");
    assert_eq!(lowercased.syscall, Some("ReadDirectoryChangesW"));

    // Near-misses all stay None — no parentheses, non-integer errno, unknown
    // leading identifier, and an ordinary message with a colon and a number.
    for near_miss in [
        "ReadDirectoryChangesW: 5 Access is denied.",
        "ReadDirectoryChangesW: (five) Access is denied.",
        "TotallyMadeUpSyscall: (5) Access is denied.",
        "Progress: 5 files copied",
        "",
    ] {
        assert_eq!(
            classify_runner_fatal_class(near_miss),
            RunnerFatalClass::None,
            "near-miss must stay None: {near_miss:?}"
        );
    }
}

#[test]
fn libuv_fatal_syscall_shape_maps_unknown_identifiers_to_the_other_constant() {
    // Defensive content-safety: even if the shape parses with an unknown
    // identifier, the parser reports the fixed constant `other`, never the
    // observed word — and the class still refuses to classify it.
    let (token, errno) = parse_libuv_fatal_syscall("SecretInternalCall: (13) /Users/ada/private")
        .expect("shape parses");
    assert_eq!(token, "other");
    assert_eq!(errno, 13);
    assert!(!is_libuv_fatal_syscall_line(
        "SecretInternalCall: (13) /Users/ada/private"
    ));
    assert!(!token.contains("Secret"));
}

#[test]
fn widened_libuv_assert_arm_covers_libuv_sources_but_not_generic_paths() {
    // Node's bundled libuv prints its vendor path (`deps/uv/`) for every
    // source, so fs-event.c / pipe.c / core.c assertions still classify —
    // and the back-compat `src\win\async.c` marker is preserved.
    for libuv_source in [
        r"Assertion failed: ..., file c:\ws\deps\uv\src\win\fs-event.c, line 480",
        "Assertion failed: cond, file deps/uv/src/unix/core.c, line 12",
        r"Assertion failed: cond, file ..\deps\uv\src\win\pipe.c, line 7",
        r"Assertion failed: cond, file src\win\async.c, line 1",
    ] {
        assert_eq!(
            classify_runner_fatal_class(libuv_source),
            RunnerFatalClass::LibuvAssert,
            "libuv-source assertion must classify as libuv_assert: {libuv_source:?}"
        );
    }
    // A generic src\win\ / src/unix/ path with no unambiguous libuv marker
    // must NOT be mislabeled libuv_assert (other trees are organised the same
    // way), and a bare application assertion still stays None.
    for non_libuv in [
        r"Assertion failed: cond, file src\win\pipe.c, line 7",
        "Assertion failed: cond, file src/unix/fs.c, line 3",
        "Assertion failed: !(n > 0) || (ret != nullptr)",
    ] {
        assert_eq!(
            classify_runner_fatal_class(non_libuv),
            RunnerFatalClass::None,
            "a non-libuv assertion must stay None: {non_libuv:?}"
        );
    }
}

#[test]
fn previously_classified_fixtures_keep_their_class_after_the_new_arm() {
    // Every arm that already classified must be unaffected by the new,
    // last-position libuv-fatal-syscall arm.
    for (line, expected) in [
        (
            "TypeError: diagnostics_channel.tracingChannel is not a function",
            RunnerFatalClass::NodeTooOld,
        ),
        (
            r"Assertion failed: cond, file src\win\async.c, line 76",
            RunnerFatalClass::LibuvAssert,
        ),
        (
            "  #  Assertion failed: !(n > 0) || (ret != nullptr)",
            RunnerFatalClass::NodeCheckAbort,
        ),
        (
            "FATAL ERROR: JavaScript heap out of memory",
            RunnerFatalClass::HeapOom,
        ),
        (
            "thread 'main' panicked at 'boom'",
            RunnerFatalClass::RustPanic,
        ),
        ("uncaught exception: boom", RunnerFatalClass::NodeFatal),
        (
            "sh: hq-sync-runner: Permission denied",
            RunnerFatalClass::ExecPermissionDenied,
        ),
        (
            "sh: hq-sync-runner: command not found",
            RunnerFatalClass::ExecNotFound,
        ),
    ] {
        assert_eq!(
            classify_runner_fatal_class(line),
            expected,
            "fixture changed class: {line:?}"
        );
    }
}

#[test]
fn record_stderr_line_moves_class_syscall_and_errno_in_lockstep() {
    let mut totals = RunTotals::default();
    totals.record_stderr_line("ReadDirectoryChangesW: (5) Access is denied.");
    totals.record_stderr_line("    at fs.watch (node:fs:1:1)");
    // A later unclassified continuation line never clears the winning line.
    assert_eq!(
        totals.runner_fatal_class,
        RunnerFatalClass::LibuvFatalSyscall
    );
    assert_eq!(totals.runner_fatal_syscall(), Some("ReadDirectoryChangesW"));
    assert_eq!(totals.runner_fatal_errno(), Some(5));

    // A later, different libuv-fatal line wins as a whole triple.
    totals.record_stderr_line("CreateIoCompletionPort: (1450) Insufficient resources.");
    assert_eq!(
        totals.runner_fatal_class,
        RunnerFatalClass::LibuvFatalSyscall
    );
    assert_eq!(
        totals.runner_fatal_syscall(),
        Some("CreateIoCompletionPort")
    );
    assert_eq!(totals.runner_fatal_errno(), Some(1450));

    // A non-libuv fatal class leaves syscall/errno cleared for that line.
    let mut assert_totals = RunTotals::default();
    assert_totals.record_stderr_line(r"Assertion failed: cond, file src\win\async.c, line 1");
    assert_eq!(
        assert_totals.runner_fatal_class,
        RunnerFatalClass::LibuvAssert
    );
    assert_eq!(assert_totals.runner_fatal_syscall(), None);
    assert_eq!(assert_totals.runner_fatal_errno(), None);
}

#[test]
fn runner_fatal_class_all_enumerates_a_fixed_content_safe_vocabulary() {
    // The emitter's own vocabulary, so this content-safety guard cannot drift
    // out of date and automatically covers the new variant.
    let mut seen = std::collections::HashSet::new();
    for class in RunnerFatalClass::ALL {
        let token = class.as_str();
        assert!(
            !token.is_empty() && token.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
            "fatal-class token must be a fixed lower_snake constant: {token:?}"
        );
        assert!(seen.insert(token), "duplicate fatal-class token: {token:?}");
    }
    assert!(seen.contains("libuv_fatal_syscall"));
    assert_eq!(seen.len(), RunnerFatalClass::ALL.len());
}

#[test]
fn node_check_abort_classifier_requires_the_observed_assertion_line_shape() {
    let companion = r"  #  C:\WINDOWS\system32\cmd.exe [44452]: char *__cdecl node::Realloc<char>(char *,unsigned __int64) at c:\ws\src\util-inl.h:378";
    let assertion = "  #  Assertion failed: !(n > 0) || (ret != nullptr)";

    assert_eq!(
        classify_runner_fatal_class(assertion),
        RunnerFatalClass::NodeCheckAbort
    );
    assert_eq!(
        classify_runner_fatal_class(companion),
        RunnerFatalClass::None
    );
    assert_eq!(
        classify_runner_fatal_class(
            "# Assertion failed: loop != nullptr, src\\\\win\\\\async.c libuv"
        ),
        RunnerFatalClass::LibuvAssert
    );
    assert_eq!(
        classify_runner_fatal_class("Assertion failed: !(n > 0) || (ret != nullptr)"),
        RunnerFatalClass::None
    );
    assert_eq!(
        RunnerFatalClass::NodeCheckAbort.as_str(),
        "node_check_abort"
    );
}

#[test]
fn node_check_abort_stderr_rollup_is_sticky_across_the_observed_pair() {
    let companion = r"  #  C:\WINDOWS\system32\cmd.exe [44452]: char *__cdecl node::Realloc<char>(char *,unsigned __int64) at c:\ws\src\util-inl.h:378";
    let assertion = "  #  Assertion failed: !(n > 0) || (ret != nullptr)";

    let mut companion_then_assertion = RunTotals::default();
    for line in [companion, assertion, "", "    at journal.js:1:1"] {
        companion_then_assertion.record_stderr_line(line);
    }
    assert_eq!(
        companion_then_assertion.runner_fatal_class,
        RunnerFatalClass::NodeCheckAbort
    );

    let mut assertion_then_companion = RunTotals::default();
    for line in [assertion, companion, ""] {
        assertion_then_companion.record_stderr_line(line);
    }
    assert_eq!(
        assertion_then_companion.runner_fatal_class,
        RunnerFatalClass::NodeCheckAbort
    );

    let mut companion_only = RunTotals::default();
    companion_only.record_stderr_line(companion);
    assert_eq!(companion_only.runner_fatal_class, RunnerFatalClass::None);
}

#[test]
fn fatal_diagnostics_do_not_change_termination_fingerprints() {
    for (code, signal, expected) in [
        (Some(-1_073_740_791), None, "windows:fault:0xC0000409"),
        (Some(126), None, "exit:126"),
        (Some(2), None, "exit:2"),
        (Some(17), None, "exit:17"),
        (
            Some(0xC000_0005u32 as i32),
            None,
            "windows:fault:0xC0000005",
        ),
        (Some(0xC000_013Au32 as i32), None, "windows:console-control"),
        (
            Some(0x4001_0004u32 as i32),
            None,
            "windows:session-terminate",
        ),
    ] {
        assert_eq!(termination_fingerprint_token(code, signal), expected);
    }
}

#[test]
fn well_known_windows_fault_symbols_are_fixed_vocabulary() {
    assert_eq!(
        windows_fault_symbol(0xC000_0409u32 as i32),
        Some("STATUS_STACK_BUFFER_OVERRUN")
    );
    assert_eq!(
        windows_fault_symbol(0xC000_0005u32 as i32),
        Some("ACCESS_VIOLATION")
    );
    assert_eq!(
        windows_fault_symbol(0xC000_013Au32 as i32),
        Some("CONTROL_C_EXIT")
    );
    assert_eq!(
        windows_fault_symbol(0x8000_0003u32 as i32),
        Some("BREAKPOINT")
    );
    assert_eq!(windows_fault_symbol(17), None);
}

#[test]
fn test_accumulate_ignores_setup_needed() {
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::SetupNeeded);
    assert_eq!(t.conflicts, 0);
}

#[test]
fn test_accumulate_ignores_progress() {
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::Progress(SyncProgressEvent {
        company: "x".to_string(),
        path: "y".to_string(),
        bytes: 0,
        message: None,
        direction: None,
        deleted: None,
        author: None,
    }));
    assert_eq!(t.conflicts, 0);
}

#[test]
fn test_accumulate_ignores_maintenance_progress() {
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::MaintenanceProgress(
        SyncMaintenanceProgressEvent {
            company: "indigo".to_string(),
            bytes_processed: 128 * 1024 * 1024,
            total_bytes: 2_153_544_154,
        },
    ));
    assert_eq!(t, RunTotals::default());
}

#[test]
fn test_accumulate_ignores_all_complete() {
    let mut t = RunTotals {
        conflicts: 4,
        ..Default::default()
    };
    t.accumulate(&SyncEvent::AllComplete(SyncAllCompleteEvent {
        companies_attempted: 1,
        files_downloaded: 0,
        bytes_downloaded: 0,
        errors: vec![],
    }));
    // AllComplete is the signal to read, not accumulate — totals unchanged.
    assert_eq!(t.conflicts, 4);
}

#[test]
fn test_accumulate_sums_conflicts_across_completes() {
    let mut t = RunTotals::default();
    t.accumulate(&complete("a", 3, false));
    t.accumulate(&complete("b", 2, true)); // aborted companies still contribute
    assert_eq!(t.conflicts, 5);
}

#[test]
fn test_accumulate_zero_conflicts_is_noop() {
    let mut t = RunTotals {
        conflicts: 10,
        ..Default::default()
    };
    t.accumulate(&complete("a", 0, false));
    assert_eq!(t.conflicts, 10);
}

#[test]
fn test_accumulate_saturates_on_overflow() {
    let mut t = RunTotals {
        conflicts: u32::MAX,
        ..Default::default()
    };
    t.accumulate(&complete("a", 1, false));
    assert_eq!(t.conflicts, u32::MAX);
}

#[test]
fn auth_error_is_terminal_even_with_exit_zero() {
    let mut totals = RunTotals::default();
    totals.accumulate(&SyncEvent::AuthError(SyncAuthErrorEvent {
        message: "Sign in to keep sync moving".to_string(),
    }));

    assert!(totals.saw_auth_error);
    assert!(!should_synthesize_all_complete(
        true,
        totals.all_complete_seen,
        totals.saw_auth_error,
    ));
}

#[test]
fn successful_early_exit_still_synthesizes_when_auth_is_healthy() {
    assert!(should_synthesize_all_complete(true, false, false));
    assert!(!should_synthesize_all_complete(false, false, false));
    assert!(!should_synthesize_all_complete(true, true, false));
}

// ── is_entity_not_yet_provisioned ────────────────────────────────────────

fn make_company_error(company: Option<&str>, path: &str, message: &str) -> SyncErrorEvent {
    SyncErrorEvent {
        company: company.map(str::to_string),
        path: path.to_string(),
        message: message.to_string(),
    }
}

#[test]
fn test_not_provisioned_404_not_found_in_message() {
    let err = make_company_error(
        Some("acme"),
        "(company)",
        "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
    );
    assert!(is_entity_not_yet_provisioned(&err));
}

#[test]
fn test_not_provisioned_no_bucket() {
    let err = make_company_error(
        Some("newco"),
        "(company)",
        "Entity cmp_01ABC (newco) has no bucket provisioned. Run VLT-2 bucket provisioning first.",
    );
    assert!(is_entity_not_yet_provisioned(&err));
}

#[test]
fn test_not_provisioned_case_insensitive() {
    // Both "entity" and "not found" must be present; case-insensitive.
    let err = make_company_error(Some("acme"), "(company)", "Entity cmp_XYZ NOT FOUND");
    assert!(is_entity_not_yet_provisioned(&err));
}

#[test]
fn test_not_provisioned_generic_not_found_excluded() {
    // "not found" without "entity" must NOT match — protects against auth
    // errors like "Token not found" or "Session not found".
    let err = make_company_error(Some("acme"), "(company)", "Token not found");
    assert!(!is_entity_not_yet_provisioned(&err));
}

#[test]
fn test_not_provisioned_file_level_error_excluded() {
    // File-level errors on real paths must not be swallowed.
    let err = make_company_error(Some("acme"), "docs/secret.md", "not found");
    assert!(!is_entity_not_yet_provisioned(&err));
}

#[test]
fn test_not_provisioned_different_company_error_not_matched() {
    // A real per-company failure (e.g. STS 500) must surface as an error.
    let err = make_company_error(
        Some("acme"),
        "(company)",
        "STS vend failed for cmp_01ABC: 500 Internal Server Error",
    );
    assert!(!is_entity_not_yet_provisioned(&err));
}

#[test]
fn test_not_provisioned_discovery_error_still_matches_predicate() {
    // The predicate checks only path + message; it has no knowledge of company.
    // A None-company error can still match the predicate — the caller
    // (classify_error_event) is responsible for the None guard.
    let err = make_company_error(
        None,
        "(company)",
        "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
    );
    assert!(is_entity_not_yet_provisioned(&err));
}

// ── is_transient_network_error ───────────────────────────────────────────

#[test]
fn test_transient_network_error_matches_known_markers() {
    // The exact shape the runner's `describeError` surfaces for the
    // latest-event scenario (HQ-SYNC-WEB-6): a socket reset mid-fanout.
    assert!(is_transient_network_error(
        "TimeoutError code=ECONNRESET read ECONNRESET"
    ));
    assert!(is_transient_network_error(
        "connect ECONNREFUSED 10.0.0.1:443"
    ));
    assert!(is_transient_network_error(
        "Client network socket disconnected: socket hang up"
    ));
    assert!(is_transient_network_error(
        "request to https://vault failed, reason: ETIMEDOUT"
    ));
    assert!(is_transient_network_error(
        "getaddrinfo EAI_AGAIN hqapi.getindigo.ai"
    ));
    // Case-insensitive.
    assert!(is_transient_network_error("Econnreset"));
}

#[test]
fn test_transient_network_error_excludes_real_defects() {
    // Filesystem + HTTP-status + opaque errors are NOT transient and must
    // keep alerting.
    assert!(!is_transient_network_error(
        "EISDIR: illegal operation on a directory, read"
    ));
    assert!(!is_transient_network_error("Unknown http=403 UnknownError"));
    assert!(!is_transient_network_error(
        "Failed to fetch entity cmp_01ABC: 404 {\"error\":\"gone\"}"
    ));
    assert!(!is_transient_network_error(
        "ScopeShrinkBlockedError code=SCOPE_SHRINK_BLOCKED"
    ));
    assert!(!is_transient_network_error("something unexpected"));
}

// ── is_alertable_error ───────────────────────────────────────────────────

#[test]
fn test_alertable_false_for_not_yet_provisioned() {
    // The vault's correct 404 is benign — the UI already absorbs it as an
    // empty sync; re-alerting at exit is the noise this fix removes.
    let err = make_company_error(
        Some("newco"),
        "(company)",
        "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
    );
    assert!(!is_alertable_error(&err));
}

#[test]
fn test_alertable_false_for_transient_network() {
    let err = make_company_error(
        Some("personal"),
        "(company)",
        "TimeoutError code=ECONNRESET read ECONNRESET",
    );
    assert!(!is_alertable_error(&err));
}

#[test]
fn test_alertable_false_for_expected_acl_scope_skip() {
    // HQ-SYNC-WEB-6: a per-file 403 SCOPE_EXCEEDS_PARENT skip — the file is
    // kept local-only and the user is told to grant the path. Benign on
    // BOTH the HEAD and PUT skip messages the runner emits.
    let head = make_company_error(
        Some("romy"),
        "data/homepage-img-src/hero-lineup.png",
        "skipped: outside granted ACL scope (server returned 403 \
             SCOPE_EXCEEDS_PARENT / access denied on HEAD). Grant this path to \
             push it, or it stays local-only.",
    );
    assert!(!is_alertable_error(&head));
    let put = make_company_error(
        Some("romy"),
        "projects/homepage/index.html",
        "skipped: outside granted ACL scope (server returned 403 \
             SCOPE_EXCEEDS_PARENT / access denied on PUT). Grant this path to \
             push it, or it stays local-only.",
    );
    assert!(!is_alertable_error(&put));
}

#[test]
fn test_alertable_true_for_real_defect() {
    // EISDIR (a genuine bug) and a 403 (auth) must still alert.
    let eisdir = make_company_error(
        Some("acme"),
        "(company)",
        "EISDIR: illegal operation on a directory, read",
    );
    assert!(is_alertable_error(&eisdir));
    let forbidden = make_company_error(
        Some("acme"),
        "(company)",
        "STS /sts/vend-self failed: 403 {\"error\":\"denied\"}",
    );
    assert!(is_alertable_error(&forbidden));
}

#[test]
fn test_alertable_true_for_real_file_level_error() {
    // A genuine per-file failure (not an expected ACL-scope skip) DOES drive
    // the runner's exit-2 tally and must keep alerting — file level no
    // longer gets a blanket pass.
    let err = make_company_error(
        Some("acme"),
        "docs/a.md",
        "EISDIR: illegal operation on a directory, read",
    );
    assert!(is_alertable_error(&err));
}

// ── should_alert_on_nonzero_exit ─────────────────────────────────────────

#[test]
fn runner_exit_disposition_precedence_is_pinned() {
    use RunnerExitDisposition::{Alert, Ignore, NodeTooOld, TransientRetry, WindowsConsoleControl};

    // This matrix preserves the pre-existing manual-sync dispatch ordering
    // for every non-75 input while pinning the new hq-cloud retry contract.
    let cases = [
        (None, Some(SIGTERM_SIGNAL), false, false, false, Ignore),
        (
            Some(WINDOWS_CONTROL_C_EXIT),
            None,
            false,
            false,
            false,
            WindowsConsoleControl,
        ),
        (
            Some(RUNNER_OPERATION_LOCKED_EXIT),
            None,
            true,
            true,
            false,
            Ignore,
        ),
        (Some(1), None, false, false, true, NodeTooOld),
        (None, Some(SIGTERM_SIGNAL), false, false, true, NodeTooOld),
        (
            Some(WINDOWS_CONTROL_C_EXIT),
            None,
            false,
            false,
            true,
            NodeTooOld,
        ),
        (
            Some(RUNNER_OPERATION_LOCKED_EXIT),
            None,
            false,
            false,
            true,
            NodeTooOld,
        ),
        (Some(2), None, true, false, false, Ignore),
        (
            Some(RUNNER_TRANSIENT_RETRY_EXIT),
            None,
            true,
            true,
            false,
            TransientRetry,
        ),
        (
            Some(RUNNER_TRANSIENT_RETRY_EXIT),
            None,
            false,
            false,
            false,
            TransientRetry,
        ),
        (
            Some(RUNNER_TRANSIENT_RETRY_EXIT),
            None,
            true,
            true,
            true,
            NodeTooOld,
        ),
        (Some(2), None, true, true, false, Alert),
        (Some(1), None, false, false, false, Alert),
    ];

    for (code, signal, saw_error, saw_alertable_error, saw_node_too_old, expected) in cases {
        assert_eq!(
            classify_runner_exit_disposition(
                code,
                signal,
                saw_error,
                saw_alertable_error,
                saw_node_too_old,
            ),
            expected,
            "unexpected disposition for code={code:?}, signal={signal:?}, error={saw_error}, alertable={saw_alertable_error}, node_too_old={saw_node_too_old}"
        );
    }
}

#[test]
fn should_alert_is_only_a_projection_of_runner_exit_disposition() {
    let cases = [
        (None, Some(SIGTERM_SIGNAL), false, false, false),
        (Some(WINDOWS_CONTROL_C_EXIT), None, false, false, false),
        (Some(RUNNER_OPERATION_LOCKED_EXIT), None, true, true, false),
        (Some(1), None, false, false, true),
        (Some(2), None, true, false, false),
        (Some(RUNNER_TRANSIENT_RETRY_EXIT), None, true, true, false),
        (Some(RUNNER_TRANSIENT_RETRY_EXIT), None, false, false, false),
        (Some(2), None, true, true, false),
        (Some(1), None, false, false, false),
    ];

    for (code, signal, saw_error, saw_alertable_error, saw_node_too_old) in cases {
        assert_eq!(
            should_alert_on_nonzero_exit(
                code,
                signal,
                saw_error,
                saw_alertable_error,
                saw_node_too_old,
            ),
            matches!(
                classify_runner_exit_disposition(
                    code,
                    signal,
                    saw_error,
                    saw_alertable_error,
                    saw_node_too_old,
                ),
                RunnerExitDisposition::Alert
            )
        );
    }
}

#[test]
fn test_exit_alert_suppressed_for_operation_locked() {
    // Exit 17 = another sync holds the lock — a normal concurrent race.
    assert!(!should_alert_on_nonzero_exit(
        Some(17),
        None,
        false,
        false,
        false
    ));
    // Even if it somehow co-occurred with an alertable error, locked wins.
    assert!(!should_alert_on_nonzero_exit(
        Some(17),
        None,
        true,
        true,
        false
    ));
}

#[test]
fn test_exit_alert_suppressed_for_sigterm_cancellation() {
    // HQ-SYNC-WEB-H: the runner killed by SIGTERM (signal 15, code None) is
    // OUR own cancel_process_impl ending the run — Stop button, timeout
    // watchdog, app quit, or a newer sync superseding this one. An expected
    // cancellation must NEVER alert, even with no protocol seen…
    assert!(!should_alert_on_nonzero_exit(
        None,
        Some(15),
        false,
        false,
        false
    ));
    // …and even if company errors (benign or alertable) were mid-flight when
    // the cancel landed — the cancellation is the cause, not the errors.
    assert!(!should_alert_on_nonzero_exit(
        None,
        Some(15),
        true,
        false,
        false
    ));
    assert!(!should_alert_on_nonzero_exit(
        None,
        Some(15),
        true,
        true,
        false
    ));
}

#[test]
fn windows_console_control_exit_is_exact_and_suppressed_for_manual_sync() {
    assert!(is_windows_console_control_exit(
        Some(WINDOWS_CONTROL_C_EXIT),
        None
    ));
    for code in [
        -1073741509, // adjacent non-control NTSTATUS
        -1073741819, // 0xC0000005 access violation
        -1073741571, // 0xC00000FD stack overflow
        0,
        1,
        2,
        RUNNER_OPERATION_LOCKED_EXIT,
        126,
        127,
    ] {
        assert!(
            !is_windows_console_control_exit(Some(code), None),
            "only STATUS_CONTROL_C_EXIT may be suppressed: {code}"
        );
    }
    assert!(!is_windows_console_control_exit(None, None));
    assert!(!is_windows_console_control_exit(
        Some(WINDOWS_CONTROL_C_EXIT),
        Some(SIGTERM_SIGNAL)
    ));

    for (saw_error, saw_alertable_error, saw_node_too_old) in [
        (false, false, false),
        (true, false, false),
        (true, true, false),
        (true, true, true),
    ] {
        assert!(!should_alert_on_nonzero_exit(
            Some(WINDOWS_CONTROL_C_EXIT),
            None,
            saw_error,
            saw_alertable_error,
            saw_node_too_old,
        ));
    }

    for fault in [-1073741819, -1073741571, 126, 127] {
        assert!(should_alert_on_nonzero_exit(
            Some(fault),
            None,
            false,
            false,
            false,
        ));
    }
}

#[test]
fn test_exit_alert_fires_for_genuine_crash_signals() {
    // A real crash signal is NOT a cancellation and must stay loud:
    // SIGSEGV (11) / SIGBUS (10) / SIGABRT (6) are crashes, and SIGKILL (9)
    // is an OOM or force-quit worth seeing — only SIGTERM is suppressed.
    assert!(should_alert_on_nonzero_exit(
        None,
        Some(11),
        false,
        false,
        false
    ));
    assert!(should_alert_on_nonzero_exit(
        None,
        Some(10),
        false,
        false,
        false
    ));
    assert!(should_alert_on_nonzero_exit(
        None,
        Some(6),
        false,
        false,
        false
    ));
    assert!(should_alert_on_nonzero_exit(
        None,
        Some(9),
        false,
        false,
        false
    ));
}

#[test]
fn test_exit_alert_suppressed_when_all_errors_benign() {
    // The HQ-SYNC-WEB-6 shape: exit 2 driven solely by benign errors
    // (per-file ACL-scope skips, a not-provisioned 404, or a transient
    // ECONNRESET) → saw_error && !saw_alertable_error → no alert.
    assert!(!should_alert_on_nonzero_exit(
        Some(2),
        None,
        true,
        false,
        false
    ));
}

#[test]
fn test_exit_alert_fires_for_real_error() {
    // exit 2 with at least one alertable error (e.g. EISDIR) → alert.
    assert!(should_alert_on_nonzero_exit(
        Some(2),
        None,
        true,
        true,
        false
    ));
}

#[test]
fn test_exit_alert_fires_for_unexplained_exit() {
    // Non-zero exit with NO error event seen — runner panicked / was
    // OOM-killed before emitting protocol. This is the original
    // "bailed before a useful stream" signal and must keep alerting.
    assert!(should_alert_on_nonzero_exit(
        Some(1),
        None,
        false,
        false,
        false
    ));
    // Signal-kill with neither code nor a recognized signal is likewise
    // unexplained (only a SIGTERM cancel is suppressed).
    assert!(should_alert_on_nonzero_exit(
        None, None, false, false, false
    ));
}

#[test]
fn effective_app_cancellation_is_suppressed_only_for_its_own_exit_shape() {
    let (owned_code, owned_signal) = match current_termination_host() {
        TerminationHost::Windows => (Some(1), None),
        TerminationHost::Posix => (None, Some(SIGTERM_SIGNAL)),
    };
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            owned_code,
            owned_signal,
            Some(SyncCancelCause::TimeoutWatchdog),
            true,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
    );

    // An attempted cancellation is not evidence that it terminated the
    // runner. A later real failure must stay loud.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(1),
            None,
            Some(SyncCancelCause::UserStop),
            false,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::Alert,
    );

    // The alertable runner fault wins even when our termination also
    // succeeded; this preserves the EPERM class in the reported issue.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(1),
            None,
            Some(SyncCancelCause::AppQuit),
            true,
            true,
            true,
            false,
        ),
        RunnerExitDisposition::Alert,
    );

    // A natural non-zero exit racing a cancellation is not attributable to
    // the application solely because a cancellation record exists.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(2),
            None,
            Some(SyncCancelCause::TimeoutWatchdog),
            true,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::Alert,
    );
}

#[cfg(not(target_os = "windows"))]
#[test]
fn posix_code_one_after_an_effective_app_cancellation_is_attributed_to_the_app() {
    // HQ-DESKTOP-5Z: on POSIX an app-owned cancellation whose runner exits
    // code 1 with no signal (an npx / shim / interpreter that trapped our
    // SIGTERM and collapsed it into a generic failure) is the app's own
    // termination, not an alertable runner fault — the exact shape the
    // Windows arm has always accepted.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(1),
            None,
            Some(SyncCancelCause::TimeoutWatchdog),
            true,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
    );
}

#[cfg(not(target_os = "windows"))]
#[test]
fn posix_app_termination_shape_set_attributes_and_everything_else_stays_loud() {
    // Every shape our own SIGTERM/SIGKILL can surface as — a direct signal
    // death, the code-1 wrapper collapse, and the 128+signal shell
    // convention — attributes to the app once the cancellation is owned and
    // observed effective.
    for (code, signal) in [
        (None, Some(SIGTERM_SIGNAL)),
        (None, Some(SIGKILL_SIGNAL)),
        (Some(1), None),
        (Some(128 + SIGTERM_SIGNAL), None),
        (Some(128 + SIGKILL_SIGNAL), None),
    ] {
        assert!(
            posix_exit_matches_app_termination(code, signal),
            "shape code={code:?} signal={signal:?} must be an app-termination shape",
        );
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                code,
                signal,
                Some(SyncCancelCause::UserStop),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::UserStop),
            "shape code={code:?} signal={signal:?} must attribute to the app",
        );
    }

    // Any other terminal shape keeps its legacy verdict even with an
    // effective cancellation record present — an arbitrary crash exit is
    // never silently swallowed.
    for (code, signal) in [
        (Some(2), None),
        (Some(7), None),
        (Some(RUNNER_OPERATION_LOCKED_EXIT), None),
        (None, Some(SIGSEGV_SIGNAL)),
    ] {
        assert!(
            !posix_exit_matches_app_termination(code, signal),
            "shape code={code:?} signal={signal:?} must NOT be an app-termination shape",
        );
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                code,
                signal,
                Some(SyncCancelCause::UserStop),
                true,
                false,
                false,
                false,
            ),
            classify_runner_exit_disposition(code, signal, false, false, false),
            "shape code={code:?} signal={signal:?} must keep its legacy verdict",
        );
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn posix_code_one_still_alerts_without_an_effective_owned_cancellation() {
    // The widened shape only ever converts an ALREADY-attributed,
    // already-effective cancellation. Strip any one of the other three gates
    // and the same (Some(1), None) shape must stay loud.

    // Gate 1 — no recorded cause (a natural code-1 exit with no app cancel).
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(1),
            None,
            None,
            true,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::Alert,
    );
    // Gate 2 — cause recorded but termination not observed to take effect.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(1),
            None,
            Some(SyncCancelCause::UserStop),
            false,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::Alert,
    );
    // Gate 4 — a concurrent alertable runner error wins (the HQ-DESKTOP-5M /
    // HQ-DESKTOP-62 class that must keep alerting after this fix).
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            Some(1),
            None,
            Some(SyncCancelCause::UserStop),
            true,
            true,
            true,
            false,
        ),
        RunnerExitDisposition::Alert,
    );
}

#[test]
fn watcher_boundary_helper_attributes_only_through_all_four_gates() {
    let (owned_code, owned_signal) = match current_termination_host() {
        TerminationHost::Windows => (Some(1), None),
        TerminationHost::Posix => (None, Some(SIGKILL_SIGNAL)),
    };

    // All four gates satisfied: a heartbeat-stall teardown SIGKILL that the
    // app observed take effect, with no alertable runner error — attributed.
    assert!(watcher_exit_attributed_to_app_teardown(
        owned_code,
        owned_signal,
        Some(SyncCancelCause::HeartbeatStall),
        true,
        false,
    ));
    // SIGTERM shape is equally an app-termination shape on POSIX.
    let sigterm_shape = matches!(current_termination_host(), TerminationHost::Posix);
    if sigterm_shape {
        assert!(watcher_exit_attributed_to_app_teardown(
            None,
            Some(SIGTERM_SIGNAL),
            Some(SyncCancelCause::HeartbeatStall),
            true,
            false,
        ));
    }

    // Gate 1 — no recorded cause (an external kill with no app cancellation).
    assert!(!watcher_exit_attributed_to_app_teardown(
        owned_code,
        owned_signal,
        None,
        true,
        false,
    ));
    // Gate 2 — cause recorded but termination not observed (ESRCH / lost /
    // timed-out publication). This is the invariant that keeps external kills
    // alertable, so it must never be weakened.
    assert!(!watcher_exit_attributed_to_app_teardown(
        owned_code,
        owned_signal,
        Some(SyncCancelCause::HeartbeatStall),
        false,
        false,
    ));
    // Gate 3 — wrong exit shape. Both of these are an app-termination shape
    // on NEITHER host: on POSIX the set is (code=None, signal in {15,9}) or
    // (code in {1, 143, 137}, no signal); Windows wants (code=1,
    // signal=None). So a crash signal (SIGABRT) or a plain exit code outside
    // {1, 143, 137} never attributes regardless of platform.
    assert!(!watcher_exit_attributed_to_app_teardown(
        None,
        Some(6), // SIGABRT
        Some(SyncCancelCause::HeartbeatStall),
        true,
        false,
    ));
    assert!(!watcher_exit_attributed_to_app_teardown(
        Some(2), // plain non-zero exit code — outside the app-termination set
        None,
        Some(SyncCancelCause::HeartbeatStall),
        true,
        false,
    ));
    // Gate 4 — a concurrent alertable runner error wins over attribution.
    assert!(!watcher_exit_attributed_to_app_teardown(
        owned_code,
        owned_signal,
        Some(SyncCancelCause::HeartbeatStall),
        true,
        true,
    ));
}

#[test]
fn watcher_boundary_matches_full_classifier_over_the_lattice() {
    // The reduced-input boundary helper must agree with the full manual-sync
    // classifier's `CancelledByApp` projection for EVERY combination of
    // `saw_error` and `saw_node_too_old` — proving those two inputs cannot
    // change an attribution verdict, which is what justifies omitting them.
    let shapes: [(Option<i32>, Option<i32>); 9] = [
        (None, Some(SIGTERM_SIGNAL)),
        (None, Some(SIGKILL_SIGNAL)),
        (None, Some(6)),
        (Some(1), None),
        (Some(128 + SIGTERM_SIGNAL), None),
        (Some(128 + SIGKILL_SIGNAL), None),
        (Some(0), None),
        (Some(2), None),
        (None, None),
    ];
    let causes = [
        None,
        Some(SyncCancelCause::HeartbeatStall),
        Some(SyncCancelCause::UserStop),
        Some(SyncCancelCause::TimeoutWatchdog),
        Some(SyncCancelCause::AppQuit),
    ];
    for (code, signal) in shapes {
        for cause in causes {
            for termination_effected in [false, true] {
                for saw_error in [false, true] {
                    for saw_alertable_error in [false, true] {
                        for saw_node_too_old in [false, true] {
                            let full = matches!(
                                classify_runner_exit_disposition_with_cancellation(
                                    code,
                                    signal,
                                    cause,
                                    termination_effected,
                                    saw_error,
                                    saw_alertable_error,
                                    saw_node_too_old,
                                ),
                                RunnerExitDisposition::CancelledByApp(_)
                            );
                            let boundary = watcher_exit_attributed_to_app_teardown(
                                code,
                                signal,
                                cause,
                                termination_effected,
                                saw_alertable_error,
                            );
                            assert_eq!(
                                boundary, full,
                                "boundary/classifier disagree for code={code:?} signal={signal:?} cause={cause:?} effected={termination_effected} saw_error={saw_error} saw_alertable={saw_alertable_error} saw_node={saw_node_too_old}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn cancellation_classifier_preserves_legacy_policy_outside_exact_effective_stops() {
    let (owned_code, owned_signal) = match current_termination_host() {
        TerminationHost::Windows => (Some(1), None),
        TerminationHost::Posix => (None, Some(SIGTERM_SIGNAL)),
    };
    for (code, signal, saw_error, saw_alertable_error, saw_node_too_old) in [
        (Some(1), None, false, false, false),
        (Some(RUNNER_OPERATION_LOCKED_EXIT), None, true, true, false),
        (Some(RUNNER_TRANSIENT_RETRY_EXIT), None, false, false, false),
        (Some(WINDOWS_CONTROL_C_EXIT), None, false, false, false),
        (Some(2), None, true, false, false),
    ] {
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                code,
                signal,
                None,
                false,
                saw_error,
                saw_alertable_error,
                saw_node_too_old,
            ),
            classify_runner_exit_disposition(
                code,
                signal,
                saw_error,
                saw_alertable_error,
                saw_node_too_old,
            ),
            "no cancellation evidence must delegate unchanged"
        );
    }

    for cause in [SyncCancelCause::UserStop, SyncCancelCause::AppQuit] {
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                owned_code,
                owned_signal,
                Some(cause),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::CancelledByApp(cause),
        );
    }

    // Unix terminal status shapes are attributable only with an exact,
    // observed application termination. A bare SIGKILL remains loud.
    if current_termination_host() == TerminationHost::Posix {
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                None,
                Some(SIGKILL_SIGNAL),
                Some(SyncCancelCause::UserStop),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::UserStop),
        );
    }
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            None,
            Some(SIGKILL_SIGNAL),
            None,
            false,
            false,
            false,
            false,
        ),
        RunnerExitDisposition::Alert,
    );

    // Cancellation takes precedence over the no-capture Node marker, but
    // never over a genuine alertable runner fault.
    assert_eq!(
        classify_runner_exit_disposition_with_cancellation(
            owned_code,
            owned_signal,
            Some(SyncCancelCause::TimeoutWatchdog),
            true,
            false,
            false,
            true,
        ),
        RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
    );

    // An exact effective cancellation still delegates every legacy special
    // disposition when its terminal status is not one produced by our
    // terminator. This keeps runner-side lock timeouts, Ctrl+C teardown,
    // and transient retry semantics byte-for-byte unchanged.
    for (code, signal) in [
        (Some(RUNNER_OPERATION_LOCKED_EXIT), None),
        (Some(WINDOWS_CONTROL_C_EXIT), None),
        (Some(RUNNER_TRANSIENT_RETRY_EXIT), None),
    ] {
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                code,
                signal,
                Some(SyncCancelCause::TimeoutWatchdog),
                true,
                false,
                false,
                false,
            ),
            classify_runner_exit_disposition(code, signal, false, false, false),
            "a non-owned status must retain its legacy disposition"
        );
    }
}

#[test]
fn test_exit_alert_suppressed_for_node_too_old() {
    assert!(!should_alert_on_nonzero_exit(
        Some(1),
        None,
        false,
        false,
        true
    ));
    assert!(!should_alert_on_nonzero_exit(
        Some(2),
        None,
        true,
        true,
        true
    ));
}

// ── accumulate / record_error: any-level error classification ────────────

#[test]
fn test_accumulate_flags_benign_company_error_not_alertable() {
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::Error(make_company_error(
        Some("personal"),
        "(company)",
        "TimeoutError code=ECONNRESET read ECONNRESET",
    )));
    assert!(t.saw_error);
    assert!(!t.saw_alertable_error);
}

#[test]
fn test_accumulate_flags_real_company_error_alertable() {
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::Error(make_company_error(
        Some("acme"),
        "(company)",
        "EISDIR: illegal operation on a directory, read",
    )));
    assert!(t.saw_error);
    assert!(t.saw_alertable_error);
}

#[test]
fn test_accumulate_mixed_errors_stay_alertable() {
    // A benign error must not "downgrade" a real one seen in the same run.
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::Error(make_company_error(
        Some("personal"),
        "(company)",
        "TimeoutError code=ECONNRESET read ECONNRESET",
    )));
    t.accumulate(&SyncEvent::Error(make_company_error(
        Some("acme"),
        "(company)",
        "EISDIR: illegal operation on a directory, read",
    )));
    assert!(t.saw_error);
    assert!(t.saw_alertable_error);
}

#[test]
fn test_accumulate_file_level_acl_scope_skip_benign() {
    // A per-file ACL-scope skip (the HQ-SYNC-WEB-6 flood) now feeds the
    // alert decision — seen, but NOT alertable — so a run whose only errors
    // are these skips suppresses the exit alert.
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::Error(make_company_error(
        Some("romy"),
        "data/homepage-img-src/hero-lineup.png",
        "skipped: outside granted ACL scope (server returned 403 \
             SCOPE_EXCEEDS_PARENT / access denied on HEAD).",
    )));
    assert!(t.saw_error);
    assert!(!t.saw_alertable_error);
}

#[test]
fn test_accumulate_file_level_real_error_alertable() {
    // A genuine per-file failure now correctly counts as alertable (it
    // drives the runner's exit-2 tally just like a company-level error).
    let mut t = RunTotals::default();
    t.accumulate(&SyncEvent::Error(make_company_error(
        Some("acme"),
        "docs/a.md",
        "EISDIR: illegal operation on a directory, read",
    )));
    assert!(t.saw_error);
    assert!(t.saw_alertable_error);
}

#[test]
fn test_record_error_from_parsed_stderr_acl_scope_line() {
    // End-to-end of the regression: the runner (hq-cloud PR #34) emits the
    // ACL-scope skip as an ndjson `error` line on STDERR. The stderr arm
    // parses it and records it; the run must then NOT alert on exit 2.
    let line = r#"{"type":"error","company":"romy","path":"projects/homepage/index.html","message":"skipped: outside granted ACL scope (server returned 403 SCOPE_EXCEEDS_PARENT / access denied on HEAD). Grant this path to push it, or it stays local-only."}"#;
    let event: SyncEvent =
        serde_json::from_str(line).expect("stderr ndjson error line should parse");
    let mut t = RunTotals::default();
    if let SyncEvent::Error(payload) = event {
        t.record_error(&payload);
    } else {
        panic!("expected SyncEvent::Error");
    }
    assert!(t.saw_error);
    assert!(!t.saw_alertable_error);
    assert!(!should_alert_on_nonzero_exit(
        Some(2),
        None,
        t.saw_error,
        t.saw_alertable_error,
        t.saw_node_too_old
    ));
}

#[test]
fn test_node_too_old_signature_matches_crash_and_ebadengine() {
    assert!(is_node_too_old_signature(
        "TypeError: diagChan.tracingChannel is not a function"
    ));
    assert!(is_node_too_old_signature(
        "npm warn EBADENGINE Unsupported engine { required: { node: '>=20.0.0' }, current: { node: 'v19.3.0' } }"
    ));
}

#[test]
fn test_node_too_old_signature_ignores_unrelated_stderr() {
    assert!(!is_node_too_old_signature("uploading projects/index.html"));
    assert!(!is_node_too_old_signature(
        "Error: connect ECONNRESET 10.0.0.1:443"
    ));
    assert!(!is_node_too_old_signature(
        "npm warn EBADENGINE required: { npm: '>=10' }"
    ));
}

#[test]
fn test_record_stderr_line_flags_node_too_old_only() {
    let mut t = RunTotals::default();
    t.record_stderr_line("TypeError: diagChan.tracingChannel is not a function");
    assert!(t.saw_node_too_old);
    assert!(!t.saw_error);
    assert!(!t.saw_alertable_error);
}

// ── classify_error_event ─────────────────────────────────────────────────

#[test]
fn test_classify_error_event_not_provisioned_returns_complete() {
    // Entity 404: must convert to a zero-files SyncCompleteEvent.
    let err = make_company_error(
        Some("acme"),
        "(company)",
        "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
    );
    let result = classify_error_event(&err);
    assert!(result.is_some());
    let complete = result.unwrap();
    assert_eq!(complete.company, "acme");
    assert_eq!(complete.files_downloaded, 0);
    assert_eq!(complete.bytes_downloaded, 0);
    assert_eq!(complete.files_skipped, 0);
    assert_eq!(complete.conflicts, 0);
    assert!(!complete.aborted);
}

#[test]
fn test_classify_error_event_none_company_passes_through() {
    // Discovery-phase error (no company): must NOT be converted — return None.
    let err = make_company_error(
        None,
        "(company)",
        "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
    );
    assert!(classify_error_event(&err).is_none());
}

#[test]
fn test_classify_error_event_real_error_passes_through() {
    // A real per-company failure (STS 500): must NOT be converted — return None.
    let err = make_company_error(
        Some("acme"),
        "(company)",
        "STS vend failed for cmp_01ABC: 500 Internal Server Error",
    );
    assert!(classify_error_event(&err).is_none());
}

#[test]
fn test_classify_error_event_no_bucket_returns_complete() {
    // "no bucket provisioned" path also converts correctly.
    let err = make_company_error(
        Some("newco"),
        "(company)",
        "Entity cmp_01ABC (newco) has no bucket provisioned. Run VLT-2 bucket provisioning first.",
    );
    let result = classify_error_event(&err);
    assert!(result.is_some());
    assert_eq!(result.unwrap().company, "newco");
}

// ── auto-sync watcher Sentry policy (HQ-DESKTOP-3Z/40/41) ────────────

#[test]
fn watcher_exit_capture_policy_is_explicit_for_known_and_unknown_codes() {
    let cases = [
        (Some(0), None, WatcherExitCapturePolicy::Capture),
        (Some(1), None, WatcherExitCapturePolicy::LocalLogOnly),
        (Some(2), None, WatcherExitCapturePolicy::LocalLogOnly),
        (
            Some(126),
            None,
            WatcherExitCapturePolicy::CaptureRateLimited,
        ),
        (
            Some(127),
            None,
            WatcherExitCapturePolicy::CaptureRateLimited,
        ),
        // HQ-DESKTOP-3Z: unknown codes must stay visible, not guessed.
        (Some(221), None, WatcherExitCapturePolicy::Capture),
        (Some(99), None, WatcherExitCapturePolicy::Capture),
        (Some(2), Some(9), WatcherExitCapturePolicy::Capture),
    ];

    for (code, signal, expected) in cases {
        assert_eq!(
            watcher_exit_capture_policy(code, signal),
            expected,
            "code={code:?} signal={signal:?}"
        );
    }
}

#[test]
fn session_end_affirmation_ttl_has_a_strict_twenty_second_boundary() {
    assert_eq!(SESSION_END_AFFIRMATION_TTL_MS, 20_000);
    assert!(session_end_affirms(Some(0), 19_999));
    assert!(!session_end_affirms(Some(0), 20_000));
    assert!(!session_end_affirms(Some(0), 20_001));
    assert!(!session_end_affirms(None, 0));
}

/// Every attribution the app can produce. Kept as one list so the
/// exhaustive table below cannot silently stop covering a new variant. The
/// three terminal resolution states (`SessionEndProbed`, `SessionEndLatched`,
/// `UnattributedNoTeardown`) are produced only after a deferral's grace,
/// never read from the observer at exit time.
const ALL_TERMINATOR_ATTRIBUTIONS: [WindowsTerminatorAttribution; 9] = [
    WindowsTerminatorAttribution::SessionEndObserved,
    WindowsTerminatorAttribution::SessionEndProbed,
    WindowsTerminatorAttribution::SessionEndLatched,
    WindowsTerminatorAttribution::UnattributedNoSignal,
    WindowsTerminatorAttribution::UnattributedQueryOnly,
    WindowsTerminatorAttribution::UnattributedStaleAffirmation,
    WindowsTerminatorAttribution::UnattributedNoTeardown,
    WindowsTerminatorAttribution::ObserverUnavailable,
    WindowsTerminatorAttribution::ObserverFailed,
];

/// The three terminal resolution states, produced by
/// [`resolved_session_end_attribution`] and never read raw from the observer.
/// They must never re-trigger a deferral if fed back in as a reading.
const TERMINAL_RESOLUTION_STATES: [WindowsTerminatorAttribution; 3] = [
    WindowsTerminatorAttribution::SessionEndProbed,
    WindowsTerminatorAttribution::SessionEndLatched,
    WindowsTerminatorAttribution::UnattributedNoTeardown,
];

/// Every latch reading the producer can emit, driven from the producer's own
/// vocabulary so a new state cannot silently escape the table below.
const ALL_LATCH_READINGS: [SessionEndLatchReading; 3] = [
    SessionEndLatchReading::Latched,
    SessionEndLatchReading::Absent,
    SessionEndLatchReading::Unavailable,
];

#[test]
fn session_end_attribution_suppresses_only_the_affirmed_session_terminate_shape() {
    let mut attributions = vec![None];
    attributions.extend(ALL_TERMINATOR_ATTRIBUTIONS.map(Some));
    let codes = [
        Some(WINDOWS_SESSION_TERMINATE_EXIT),
        Some(0xC000_0409u32 as i32),
        Some(-1),
        Some(0),
        Some(1),
        Some(2),
        Some(126),
        Some(127),
        Some(221),
    ];

    for attribution in attributions {
        for code in codes {
            for signal in [None, Some(9)] {
                for latch in ALL_LATCH_READINGS {
                    let actual = watcher_exit_capture_policy_with_attribution(
                        code,
                        signal,
                        attribution,
                        latch,
                    );
                    let is_session_terminate_shape =
                        code == Some(WINDOWS_SESSION_TERMINATE_EXIT) && signal.is_none();
                    let expected = if !is_session_terminate_shape {
                        // Off the session-terminate/no-signal shape neither the
                        // latch nor the attribution is consulted: real fault
                        // statuses and every signalled exit stay alertable.
                        watcher_exit_capture_policy(code, signal)
                    } else if latch.suppresses()
                        || attribution == Some(WindowsTerminatorAttribution::SessionEndObserved)
                    {
                        // Positive evidence at exit: a contemporaneous latch or
                        // an observed session-end message suppresses at once.
                        WatcherExitCapturePolicy::LocalLogOnly
                    } else if attribution
                        .is_some_and(|reading| reading.is_deferrable_observer_reading())
                    {
                        // r3: every raw observer reading now defers — the two
                        // observer-fault readings as well as the unattributed
                        // family — so the probe and the latch get a second look.
                        WatcherExitCapturePolicy::DeferSessionEndDecision
                    } else {
                        // A terminal resolution state or a `None` reading
                        // delegates verbatim and never re-defers.
                        watcher_exit_capture_policy(code, signal)
                    };
                    assert_eq!(
                        actual, expected,
                        "code={code:?} signal={signal:?} attribution={attribution:?} latch={latch:?}"
                    );
                }
            }
        }
    }
}

// The regression this fix exists for: a session-terminate exit the observer
// could not attribute must no longer be captured on the spot. r3 widens this
// to the observer-fault readings too — the exact family
// (`ObserverFailed`/`observer_failed`) the recurrence event
// 5bcd8d2aa8c047768419f18613426a59 (hq-sync-win@0.10.150) fired on.
#[test]
fn an_unattributed_session_terminate_defers_instead_of_capturing() {
    // With no contemporaneous latch, EVERY raw observer reading on the
    // session-terminate shape now defers so the r2 probe and the latch are
    // consulted after the grace, instead of firing immediately.
    for attribution in [
        WindowsTerminatorAttribution::UnattributedNoSignal,
        WindowsTerminatorAttribution::UnattributedQueryOnly,
        WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        // r3: these two were sent immediately by r1 and are the recurrence.
        WindowsTerminatorAttribution::ObserverUnavailable,
        WindowsTerminatorAttribution::ObserverFailed,
    ] {
        assert!(
            attribution.is_deferrable_observer_reading(),
            "{attribution:?}"
        );
        assert_eq!(
            watcher_exit_capture_policy_with_attribution(
                Some(WINDOWS_SESSION_TERMINATE_EXIT),
                None,
                Some(attribution),
                SessionEndLatchReading::Absent,
            ),
            WatcherExitCapturePolicy::DeferSessionEndDecision,
            "{attribution:?} must defer, not capture"
        );

        // A contemporaneous latch is positive evidence at exit: the same
        // reading suppresses immediately, exactly like an observed message.
        assert_eq!(
            watcher_exit_capture_policy_with_attribution(
                Some(WINDOWS_SESSION_TERMINATE_EXIT),
                None,
                Some(attribution),
                SessionEndLatchReading::Latched,
            ),
            WatcherExitCapturePolicy::LocalLogOnly,
            "{attribution:?} with a contemporaneous latch must suppress at once"
        );
    }
}

// The other half of the widened gate: the terminal resolution states and a
// `None` reading must NEVER re-trigger a deferral — they are what a re-read
// resolves to, so on the session-terminate shape they delegate to the
// established (immediate) capture policy verbatim.
#[test]
fn terminal_resolution_states_and_none_never_redefer_on_the_session_terminate_shape() {
    for latch in [
        SessionEndLatchReading::Absent,
        SessionEndLatchReading::Unavailable,
    ] {
        for attribution in TERMINAL_RESOLUTION_STATES {
            assert!(
                !attribution.is_deferrable_observer_reading(),
                "{attribution:?}"
            );
            assert_eq!(
                watcher_exit_capture_policy_with_attribution(
                    Some(WINDOWS_SESSION_TERMINATE_EXIT),
                    None,
                    Some(attribution),
                    latch,
                ),
                WatcherExitCapturePolicy::Capture,
                "{attribution:?} must not re-defer"
            );
        }
        assert_eq!(
            watcher_exit_capture_policy_with_attribution(
                Some(WINDOWS_SESSION_TERMINATE_EXIT),
                None,
                None,
                latch,
            ),
            WatcherExitCapturePolicy::Capture,
            "a None reading must delegate verbatim"
        );
    }
}

const ALL_TEARDOWN_VERDICTS: [WindowsTeardownVerdict; 3] = [
    WindowsTeardownVerdict::Confirmed,
    WindowsTeardownVerdict::Absent,
    WindowsTeardownVerdict::Unknown,
];

#[test]
fn a_deferral_drops_the_first_unconfirmed_and_escalates_a_repeat() {
    // Exhaustive over {every attribution} x {every verdict} x {every latch
    // reading}. Positive OS evidence (an observed message, a contemporaneous
    // latch, or a probe-confirmed teardown) ALWAYS drops the held alert. With
    // no positive evidence the exit is UNCONFIRMED: the FIRST such exit per app
    // run (count == 1) is the benign sign-out shape and also drops; only a
    // repeat within the same run (count == 2, a capture milestone) escalates.
    for attribution in ALL_TERMINATOR_ATTRIBUTIONS {
        for verdict in ALL_TEARDOWN_VERDICTS {
            for latch in ALL_LATCH_READINGS {
                let confirmed_evidence =
                    deferred_session_end_confirmed(attribution, verdict, latch);

                // The first unconfirmed exit per run never sends, and positive
                // evidence never sends — so count == 1 always drops.
                assert_eq!(
                    deferred_session_end_outcome(attribution, verdict, latch, 1),
                    DeferredSessionEndOutcome::Drop,
                    "first unconfirmed / confirmed must drop: \
                         {attribution:?} + {verdict:?} + {latch:?}"
                );

                // A second unconfirmed exit in the same run escalates; a second
                // exit that DID carry positive evidence still drops (it is a
                // real session end, no matter how many preceded it).
                let expected_second = if confirmed_evidence {
                    DeferredSessionEndOutcome::Drop
                } else {
                    DeferredSessionEndOutcome::Capture
                };
                assert_eq!(
                    deferred_session_end_outcome(attribution, verdict, latch, 2),
                    expected_second,
                    "{attribution:?} + {verdict:?} + {latch:?}"
                );

                // Lockstep: the resolved tag suppresses exactly when a repeat
                // would drop (i.e. positive evidence), and sends exactly when a
                // repeat would escalate. Only the RAW readings are ever fed back
                // at resolution in production (an observed message or a
                // deferrable observer reading); a terminal resolution state is
                // what a re-read *produces*, never an input.
                let is_raw_reading = attribution
                    == WindowsTerminatorAttribution::SessionEndObserved
                    || attribution.is_deferrable_observer_reading();
                if is_raw_reading {
                    let resolved = resolved_session_end_attribution(attribution, verdict, latch);
                    let tag_suppresses = matches!(
                        resolved,
                        WindowsTerminatorAttribution::SessionEndObserved
                            | WindowsTerminatorAttribution::SessionEndLatched
                            | WindowsTerminatorAttribution::SessionEndProbed
                    );
                    assert_eq!(
                        tag_suppresses,
                        expected_second == DeferredSessionEndOutcome::Drop,
                        "tag {resolved:?} disagrees with escalation outcome for \
                             {attribution:?} + {verdict:?} + {latch:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_unconfirmed_session_terminate_run_counter_is_silent_then_escalates() {
    // The pure per-run escalation predicate: the first unconfirmed exit is
    // silent, a repeat escalates, and beyond the second it re-uses the
    // crash-loop milestone so a repeating external killer alerts on 2, 4, 8 …
    // rather than on every single repeat.
    assert!(!unconfirmed_session_terminate_escalates(0));
    assert!(!unconfirmed_session_terminate_escalates(1));
    assert!(unconfirmed_session_terminate_escalates(2));
    assert!(!unconfirmed_session_terminate_escalates(3));
    assert!(unconfirmed_session_terminate_escalates(4));
    assert!(!unconfirmed_session_terminate_escalates(5));
    assert!(!unconfirmed_session_terminate_escalates(7));
    assert!(unconfirmed_session_terminate_escalates(8));
    // And it is exactly `is_capture_milestone` past the first, so it can never
    // become an unbounded capture loop.
    for count in 2..=64u32 {
        assert_eq!(
            unconfirmed_session_terminate_escalates(count),
            is_capture_milestone(count),
            "escalation past the first must track the milestone limiter (count={count})"
        );
    }
}

#[test]
fn a_contemporaneous_latch_drops_every_deferrable_reading_and_names_itself() {
    // The r3 latch: for the unattributed family AND the observer-fault
    // readings, a contemporaneous latch suppresses regardless of the probe
    // verdict, and the resolved tag names `session_end_latched`.
    for attribution in [
        WindowsTerminatorAttribution::UnattributedNoSignal,
        WindowsTerminatorAttribution::UnattributedQueryOnly,
        WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        WindowsTerminatorAttribution::ObserverUnavailable,
        WindowsTerminatorAttribution::ObserverFailed,
    ] {
        for verdict in ALL_TEARDOWN_VERDICTS {
            assert_eq!(
                deferred_session_end_outcome(
                    attribution,
                    verdict,
                    SessionEndLatchReading::Latched,
                    // A contemporaneous latch is positive evidence, so it drops
                    // no matter how many session-terminate exits preceded it.
                    2
                ),
                DeferredSessionEndOutcome::Drop,
                "{attribution:?} + {verdict:?} + latch must drop"
            );
            assert_eq!(
                resolved_session_end_attribution(
                    attribution,
                    verdict,
                    SessionEndLatchReading::Latched
                ),
                WindowsTerminatorAttribution::SessionEndLatched,
                "{attribution:?} + {verdict:?} + latch must name the latch"
            );
        }
    }
    // An absent or unavailable latch is not evidence: with an Unknown probe
    // and no message, a REPEAT observer-fault reading still SENDS (the first
    // per run is the benign sign-out shape and drops; a second escalates).
    for latch in [
        SessionEndLatchReading::Absent,
        SessionEndLatchReading::Unavailable,
    ] {
        assert_eq!(
            deferred_session_end_outcome(
                WindowsTerminatorAttribution::ObserverFailed,
                WindowsTeardownVerdict::Unknown,
                latch,
                1
            ),
            DeferredSessionEndOutcome::Drop,
            "observer_failed + Unknown + {latch:?}: the first per run is silent"
        );
        assert_eq!(
            deferred_session_end_outcome(
                WindowsTerminatorAttribution::ObserverFailed,
                WindowsTeardownVerdict::Unknown,
                latch,
                2
            ),
            DeferredSessionEndOutcome::Capture,
            "observer_failed + Unknown + {latch:?}: a repeat must still send"
        );
    }
}

#[test]
fn the_latch_honours_the_affirmation_ttl_boundary() {
    // The latch shares the observer affirmation's 20s TTL, evaluated by the
    // pure mapper. One millisecond inside the window latches; the boundary
    // itself and everything past it fail closed to `Absent` and thus SEND.
    let latched_at = 1_000u64;
    let just_inside = latched_at + SESSION_END_AFFIRMATION_TTL_MS - 1;
    let at_boundary = latched_at + SESSION_END_AFFIRMATION_TTL_MS;
    assert_eq!(
        session_end_latch_reading(Some(latched_at), just_inside),
        SessionEndLatchReading::Latched
    );
    assert_eq!(
        session_end_latch_reading(Some(latched_at), at_boundary),
        SessionEndLatchReading::Absent,
        "the TTL boundary must fail closed"
    );
    assert_eq!(
        session_end_latch_reading(None, at_boundary),
        SessionEndLatchReading::Absent,
        "an unset latch is Absent, never Latched"
    );
    // The boundary reading, fed to the exit-time policy, must therefore
    // DEFER (fail closed) rather than suppress.
    assert_eq!(
        watcher_exit_capture_policy_with_attribution(
            Some(WINDOWS_SESSION_TERMINATE_EXIT),
            None,
            Some(WindowsTerminatorAttribution::ObserverFailed),
            session_end_latch_reading(Some(latched_at), at_boundary),
        ),
        WatcherExitCapturePolicy::DeferSessionEndDecision
    );
}

#[test]
fn only_a_confirmed_teardown_suppresses_a_deferrable_reading() {
    // The exact recurrence shape the post-fix events reported: registered or
    // FAILED observer, no message, DBG_TERMINATE_PROCESS, no latch. Confirmed
    // suppresses; Absent and Unknown both fail closed to a send. r3 extends
    // this from the unattributed family to the observer-fault readings too
    // (recurrence event 5bcd8d2aa8c047768419f18613426a59 was ObserverFailed):
    // if the OS probe confirms the teardown, a failed observer is a false
    // alarm, not a crash.
    for attribution in [
        WindowsTerminatorAttribution::UnattributedNoSignal,
        WindowsTerminatorAttribution::UnattributedQueryOnly,
        WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        WindowsTerminatorAttribution::ObserverFailed,
        WindowsTerminatorAttribution::ObserverUnavailable,
    ] {
        assert!(
            attribution.is_deferrable_observer_reading(),
            "{attribution:?}"
        );
        assert_eq!(
            deferred_session_end_outcome(
                attribution,
                WindowsTeardownVerdict::Confirmed,
                SessionEndLatchReading::Absent,
                2
            ),
            DeferredSessionEndOutcome::Drop,
            "{attribution:?} + a confirmed teardown must suppress even on a repeat"
        );
        for verdict in [
            WindowsTeardownVerdict::Absent,
            WindowsTeardownVerdict::Unknown,
        ] {
            // The first unconfirmed exit per run is silent; a repeat fails
            // closed to a send.
            assert_eq!(
                deferred_session_end_outcome(
                    attribution,
                    verdict,
                    SessionEndLatchReading::Absent,
                    1
                ),
                DeferredSessionEndOutcome::Drop,
                "{attribution:?} + {verdict:?} + no latch: the first per run is silent"
            );
            assert_eq!(
                deferred_session_end_outcome(
                    attribution,
                    verdict,
                    SessionEndLatchReading::Absent,
                    2
                ),
                DeferredSessionEndOutcome::Capture,
                "{attribution:?} + {verdict:?} + no latch: a repeat must send (fail closed)"
            );
        }
    }
}

#[test]
fn the_teardown_verdict_confirms_only_on_positive_evidence() {
    use TeardownLogReading as Log;
    use TeardownShuttingDown as Sd;

    let verdict = |exit, resolve, log| {
        windows_teardown_verdict(WindowsTeardownProbeReading {
            shuttingdown_at_exit: exit,
            shuttingdown_at_resolve: resolve,
            log,
        })
    };

    // A live shutting-down flag confirms from either read.
    assert_eq!(
        verdict(Sd::Yes, Sd::No, Log::None),
        WindowsTeardownVerdict::Confirmed
    );
    assert_eq!(
        verdict(Sd::No, Sd::Yes, Log::None),
        WindowsTeardownVerdict::Confirmed
    );
    // A COMMITTED System-channel record (the OS actually shut down) confirms
    // even with both flags negative.
    for committed in [
        TeardownLogClass::KernelGeneral,
        TeardownLogClass::KernelPower,
    ] {
        assert!(committed.is_committed_teardown());
        assert_eq!(
            verdict(Sd::No, Sd::No, Log::Record(committed)),
            WindowsTeardownVerdict::Confirmed,
            "{committed:?} proves the teardown proceeded"
        );
    }
    // A positive flag wins even when the log is unreadable.
    assert_eq!(
        verdict(Sd::Yes, Sd::Unavailable, Log::Unavailable),
        WindowsTeardownVerdict::Confirmed
    );

    // An INITIATION-only record (User32 1074) does NOT confirm on its own: a
    // shutdown can be initiated and then aborted. With both flags negative it
    // is neither Confirmed nor Absent — it fails closed to Unknown, and the
    // record is preserved for diagnostics rather than suppressing an alert.
    assert!(!TeardownLogClass::User32Initiated.is_committed_teardown());
    assert_eq!(
        verdict(
            Sd::No,
            Sd::No,
            Log::Record(TeardownLogClass::User32Initiated)
        ),
        WindowsTeardownVerdict::Unknown,
        "a bare initiation must never suppress a coincident real crash"
    );
    // But a live flag still confirms even when only an initiation was logged.
    assert_eq!(
        verdict(
            Sd::Yes,
            Sd::No,
            Log::Record(TeardownLogClass::User32Initiated)
        ),
        WindowsTeardownVerdict::Confirmed
    );

    // Absent requires unanimous negatives across every source, with the
    // channel open and holding NO record at all — not even an initiation.
    assert_eq!(
        verdict(Sd::No, Sd::No, Log::None),
        WindowsTeardownVerdict::Absent
    );

    // Any non-unanimous, non-positive mix fails closed to Unknown.
    assert_eq!(
        verdict(Sd::No, Sd::No, Log::Unavailable),
        WindowsTeardownVerdict::Unknown
    );
    assert_eq!(
        verdict(Sd::Unavailable, Sd::Unavailable, Log::Unavailable),
        WindowsTeardownVerdict::Unknown
    );
    assert_eq!(
        verdict(Sd::No, Sd::Unavailable, Log::None),
        WindowsTeardownVerdict::Unknown
    );
}

#[test]
fn the_resolved_attribution_tracks_the_verdict_and_agrees_with_the_outcome() {
    // Observed always keeps its own value and drops, regardless of latch.
    for verdict in ALL_TEARDOWN_VERDICTS {
        for latch in ALL_LATCH_READINGS {
            assert_eq!(
                resolved_session_end_attribution(
                    WindowsTerminatorAttribution::SessionEndObserved,
                    verdict,
                    latch
                ),
                WindowsTerminatorAttribution::SessionEndObserved
            );
        }
    }
    // An unattributed reading with no latch is renamed by the verdict, and
    // the rename agrees with the drop/capture decision for the same inputs.
    for attribution in [
        WindowsTerminatorAttribution::UnattributedNoSignal,
        WindowsTerminatorAttribution::UnattributedQueryOnly,
        WindowsTerminatorAttribution::UnattributedStaleAffirmation,
    ] {
        let no_latch = SessionEndLatchReading::Absent;
        assert_eq!(
            resolved_session_end_attribution(
                attribution,
                WindowsTeardownVerdict::Confirmed,
                no_latch
            ),
            WindowsTerminatorAttribution::SessionEndProbed
        );
        assert_eq!(
            resolved_session_end_attribution(attribution, WindowsTeardownVerdict::Absent, no_latch),
            WindowsTerminatorAttribution::UnattributedNoTeardown
        );
        // Unknown keeps the original discriminated value.
        assert_eq!(
            resolved_session_end_attribution(
                attribution,
                WindowsTeardownVerdict::Unknown,
                no_latch
            ),
            attribution
        );
        // A suppressing rename must coincide with a Drop outcome, and a
        // sending rename with an escalating Capture outcome — the tag never
        // lies. Evaluated at a repeat (count == 2) so the sending case is
        // reachable; the first per run drops regardless of the tag.
        assert_eq!(
            deferred_session_end_outcome(
                attribution,
                WindowsTeardownVerdict::Confirmed,
                no_latch,
                2
            ),
            DeferredSessionEndOutcome::Drop
        );
        assert_eq!(
            deferred_session_end_outcome(attribution, WindowsTeardownVerdict::Absent, no_latch, 2),
            DeferredSessionEndOutcome::Capture
        );
    }
    // An observer-fault reading with no latch keeps its own raw value when it
    // sends (Absent/Unknown), and is renamed to the suppressing SessionEndProbed
    // only when the probe confirmed — never to an unattributed_* token it is not.
    for attribution in [
        WindowsTerminatorAttribution::ObserverFailed,
        WindowsTerminatorAttribution::ObserverUnavailable,
    ] {
        let no_latch = SessionEndLatchReading::Absent;
        assert_eq!(
            resolved_session_end_attribution(
                attribution,
                WindowsTeardownVerdict::Confirmed,
                no_latch
            ),
            WindowsTerminatorAttribution::SessionEndProbed
        );
        for verdict in [
            WindowsTeardownVerdict::Absent,
            WindowsTeardownVerdict::Unknown,
        ] {
            assert_eq!(
                resolved_session_end_attribution(attribution, verdict, no_latch),
                attribution,
                "{attribution:?} + {verdict:?} + no latch keeps its raw value"
            );
        }
    }
}

#[test]
fn a_deferred_capture_keeps_the_crash_loop_milestone_limiter() {
    let deferred = WatcherExitCapturePolicy::DeferSessionEndDecision;
    for consecutive in [1, 2, 4, 8, 16] {
        assert!(
            should_capture_watcher_exit(deferred, consecutive),
            "milestone #{consecutive} must still send"
        );
    }
    for consecutive in [3, 5, 6, 7, 9] {
        assert!(
            !should_capture_watcher_exit(deferred, consecutive),
            "non-milestone #{consecutive} must stay limited"
        );
    }
    // Byte for byte the `Capture` limiter — a deferral delays a send, it
    // never changes which sends happen.
    for consecutive in 1..64u32 {
        assert_eq!(
            should_capture_watcher_exit(deferred, consecutive),
            should_capture_watcher_exit(WatcherExitCapturePolicy::Capture, consecutive),
            "deferral diverged from Capture at #{consecutive}"
        );
    }
}

#[test]
fn the_session_end_grace_sits_inside_both_of_its_ceilings() {
    assert_eq!(SESSION_END_GRACE_MS, 6_000);
    // Never outlive the affirmation window it waits on.
    assert!(SESSION_END_GRACE_MS < SESSION_END_AFFIRMATION_TTL_MS);
    // Windows' 5s default WaitToKillAppTimeout plus the app's own ~1.75s
    // capped session-end teardown: at a real session end the app reaches
    // its exit path and drops the deferral rather than racing it.
    assert!(SESSION_END_GRACE_MS < 5_000 + 1_750);
}

#[test]
fn an_affirmation_inside_the_grace_suppresses_and_one_outside_it_does_not() {
    // The forward half of the window, expressed against the same TTL the
    // backward half uses: an affirmation stamped anywhere within the grace
    // is still fresh when the deferral re-reads it.
    let exit_at_ms = 100_000;
    let affirmed_just_inside = exit_at_ms + SESSION_END_GRACE_MS - 1;
    let resolves_at = exit_at_ms + SESSION_END_GRACE_MS;
    assert!(session_end_affirms(Some(affirmed_just_inside), resolves_at));

    // And an affirmation that never arrives leaves the held-back event to
    // send — the grace delays an alert, it never cancels one.
    assert!(!session_end_affirms(None, resolves_at));

    // The 20s TTL still fails closed at exactly 20000ms, unchanged.
    assert!(session_end_affirms(Some(0), 19_999));
    assert!(!session_end_affirms(Some(0), 20_000));
}

#[test]
fn the_query_phase_shares_the_committed_ends_freshness_boundary() {
    // One boundary, two callers: a query recorded 20s ago is no more
    // contemporaneous than a commit recorded 20s ago, so a stale query can
    // never masquerade as a live session-end phase hours later.
    assert!(session_end_signal_is_fresh(Some(0), 19_999));
    assert!(!session_end_signal_is_fresh(Some(0), 20_000));
    assert!(!session_end_signal_is_fresh(None, 0));
    for now in [0, 1, 19_999, 20_000, 50_000] {
        assert_eq!(
            session_end_signal_is_fresh(Some(0), now),
            session_end_affirms(Some(0), now),
            "the two freshness checks diverged at {now}"
        );
    }
}

#[test]
fn terminator_attribution_names_stay_a_fixed_content_safe_vocabulary() {
    let names: Vec<&str> = ALL_TERMINATOR_ATTRIBUTIONS
        .iter()
        .map(|attribution| attribution.class_name())
        .collect();
    assert_eq!(
        names,
        vec![
            "session_end_observed",
            "session_end_probed",
            "session_end_latched",
            "unattributed_no_signal",
            "unattributed_query_only",
            "unattributed_stale_affirmation",
            "unattributed_no_teardown",
            "observer_unavailable",
            "observer_failed",
        ]
    );
    // The undiscriminated value is gone: a residual recurrence has to name
    // which link of the chain failed.
    assert!(!names.contains(&"unattributed"));
    for name in &names {
        assert!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "{name} is not a fixed-vocabulary tag token"
        );
    }

    // The probe's own wire vocabulary is equally fixed and content-safe.
    let probe_tokens = [
        WindowsTeardownVerdict::Confirmed.class_name(),
        WindowsTeardownVerdict::Absent.class_name(),
        WindowsTeardownVerdict::Unknown.class_name(),
        TeardownShuttingDown::Yes.class_name(),
        TeardownShuttingDown::No.class_name(),
        TeardownShuttingDown::Unavailable.class_name(),
        TeardownLogReading::Record(TeardownLogClass::User32Initiated).class_name(),
        TeardownLogReading::Record(TeardownLogClass::KernelGeneral).class_name(),
        TeardownLogReading::Record(TeardownLogClass::KernelPower).class_name(),
        TeardownLogReading::None.class_name(),
        TeardownLogReading::Unavailable.class_name(),
    ];
    for token in probe_tokens {
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "{token} is not a fixed-vocabulary probe token"
        );
    }

    for (waited, bucket) in [
        (0u64, "under_1s"),
        (999, "under_1s"),
        (1_000, "1s_to_3s"),
        (2_999, "1s_to_3s"),
        (3_000, "3s_to_6s"),
        (5_999, "3s_to_6s"),
        (6_000, "at_or_over_6s"),
        (60_000, "at_or_over_6s"),
    ] {
        assert_eq!(
            session_end_grace_waited_bucket(waited),
            bucket,
            "{waited}ms"
        );
    }
}

/// A realistic User32 Event 1074 (shutdown initiated) as `EvtRender` emits
/// it, carrying an initiating user, a full process path and a machine name —
/// exactly the fields a careless parser could leak.
const SAMPLE_USER32_1074: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='User32' Guid='{b0aa8734-56f1-4918-a988-b7d54bb8a4b5}' EventSourceName='User32'/><EventID Qualifiers='32768'>1074</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2026-08-20T05:11:57.1234567Z'/><EventRecordID>90210</EventRecordID><Correlation/><Execution ProcessID='1064' ThreadID='2088'/><Channel>System</Channel><Computer>DESKTOP-QOH7J4N</Computer><Security UserID='S-1-5-21-1111-2222-3333-1001'/></System><EventData><Data Name='param1'>C:\Windows\System32\shutdown.exe (DESKTOP-QOH7J4N)</Data><Data Name='param2'>DESKTOP-QOH7J4N</Data><Data Name='param5'>power off</Data><Data Name='param7'>Ada</Data></EventData></Event>"#;

#[test]
fn parse_teardown_record_recognises_only_the_three_initiation_records() {
    assert_eq!(
        parse_teardown_record(SAMPLE_USER32_1074).map(|record| record.class),
        Some(TeardownLogClass::User32Initiated)
    );

    let kernel_general = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-General' Guid='{a68ca8b7}'/><EventID>13</EventID><TimeCreated SystemTime='2026-08-20T05:11:58.5Z'/><Channel>System</Channel><Computer>DESKTOP-QOH7J4N</Computer></System><EventData><Data Name='StopTime'>2026-08-20T05:11:58Z</Data></EventData></Event>"#;
    assert_eq!(
        parse_teardown_record(kernel_general).map(|record| record.class),
        Some(TeardownLogClass::KernelGeneral)
    );

    let kernel_power = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a}'/><EventID>109</EventID><TimeCreated SystemTime='2026-08-20T05:11:59Z'/><Channel>System</Channel></System><EventData><Data Name='TransitionsToOff'>1</Data></EventData></Event>"#;
    assert_eq!(
        parse_teardown_record(kernel_power).map(|record| record.class),
        Some(TeardownLogClass::KernelPower)
    );

    // A matching EventID under the WRONG provider is rejected — the id alone
    // is not evidence.
    let wrong_provider = r#"<Event><System><Provider Name='Some-Other-Provider'/><EventID>1074</EventID><TimeCreated SystemTime='2026-08-20T05:11:59Z'/></System></Event>"#;
    assert_eq!(parse_teardown_record(wrong_provider), None);

    // An unrelated System event is not a teardown record at all.
    let unrelated = r#"<Event><System><Provider Name='Service Control Manager'/><EventID>7036</EventID><TimeCreated SystemTime='2026-08-20T05:11:59Z'/></System></Event>"#;
    assert_eq!(parse_teardown_record(unrelated), None);
}

#[test]
fn parse_teardown_record_extracts_only_content_safe_fields() {
    let record = parse_teardown_record(SAMPLE_USER32_1074).expect("1074 must parse to a record");
    // Only a fixed class token and a bare integer time survive parsing.
    assert_eq!(record.class, TeardownLogClass::User32Initiated);
    assert!(record.event_time_unix_ms.is_some());

    // The Debug rendering of the parsed record — the only thing that could
    // ever reach a log/tag/extra — must not carry any raw field from the XML.
    let rendered = format!("{record:?}");
    for leaked in [
        "shutdown.exe",
        "DESKTOP-QOH7J4N",
        "Ada",
        "S-1-5-21",
        "power off",
        r"C:\Windows",
        "param1",
    ] {
        assert!(
            !rendered.contains(leaked),
            "parsed teardown record leaked {leaked:?}: {rendered}"
        );
    }
    assert_eq!(record.class.class_name(), "user32_1074");
}

#[test]
fn a_teardown_record_brackets_only_a_contemporaneous_exit() {
    let exit_ms = 1_760_000_000_000;
    let now_ms = exit_ms + SESSION_END_GRACE_MS as i64;

    let at_exit = TeardownRecord {
        class: TeardownLogClass::KernelGeneral,
        event_time_unix_ms: Some(exit_ms),
    };
    assert!(teardown_record_brackets_exit(&at_exit, exit_ms, now_ms));

    // A record initiated a few seconds before the child died still brackets.
    let just_before = TeardownRecord {
        event_time_unix_ms: Some(exit_ms - 3_000),
        ..at_exit
    };
    assert!(teardown_record_brackets_exit(&just_before, exit_ms, now_ms));

    // A boot-time record from a previous session — hours earlier — does not,
    // which is what stops a healthy runner's historical shutdown from ever
    // reading as a live teardown.
    let last_boot = TeardownRecord {
        event_time_unix_ms: Some(exit_ms - 6 * 60 * 60 * 1000),
        ..at_exit
    };
    assert!(!teardown_record_brackets_exit(&last_boot, exit_ms, now_ms));

    // A record with no parseable time is never treated as bracketing —
    // absence of a time is not evidence of contemporaneity.
    let no_time = TeardownRecord {
        event_time_unix_ms: None,
        ..at_exit
    };
    assert!(!teardown_record_brackets_exit(&no_time, exit_ms, now_ms));
}

#[test]
fn exec_not_runnable_exits_escalate_only_after_a_sustained_streak() {
    let policy = watcher_exit_capture_policy(Some(127), None);
    for consecutive in [1, 2, 3] {
        assert!(
            !should_capture_watcher_exit(policy, consecutive),
            "one-off exec failure #{consecutive} must remain local"
        );
    }
    assert!(should_capture_watcher_exit(policy, 4));
    assert!(!should_capture_watcher_exit(policy, 5));
    assert!(should_capture_watcher_exit(policy, 8));
}

#[test]
fn crash_loop_milestones_remain_first_then_powers_of_two() {
    for consecutive in [1, 2, 4, 8, 16, 32] {
        assert!(is_capture_milestone(consecutive));
    }
    for consecutive in [3, 5, 6, 7, 9, 15, 31] {
        assert!(!is_capture_milestone(consecutive));
    }
}

#[test]
fn transient_spawn_resource_exhaustion_retries_without_capture() {
    let retry_cases = [
        (ErrorKind::WouldBlock, Some(35), SpawnFailurePlatform::Macos), // macOS EAGAIN/EWOULDBLOCK
        (ErrorKind::WouldBlock, Some(11), SpawnFailurePlatform::Linux), // Linux EAGAIN/EWOULDBLOCK
        (
            ErrorKind::OutOfMemory,
            Some(12),
            SpawnFailurePlatform::Linux,
        ), // ENOMEM
        (ErrorKind::Other, Some(24), SpawnFailurePlatform::Macos),      // EMFILE
        (ErrorKind::Other, Some(23), SpawnFailurePlatform::Linux),      // ENFILE
    ];
    for (kind, raw, platform) in retry_cases {
        assert_eq!(
            spawn_failure_capture_policy_for_platform(kind, raw, platform),
            SpawnFailureCapturePolicy::RetryAndLog,
            "kind={kind:?} raw={raw:?} platform={platform:?}"
        );
    }

    for (kind, raw, platform) in [
        (ErrorKind::NotFound, Some(2), SpawnFailurePlatform::Linux), // ENOENT
        (
            ErrorKind::PermissionDenied,
            Some(13),
            SpawnFailurePlatform::Macos,
        ), // EACCES
        // Raw Unix errno values are not portable; 11 must not silence an
        // unrelated Windows/other-platform spawn failure.
        (ErrorKind::Other, Some(11), SpawnFailurePlatform::Other),
    ] {
        assert_eq!(
            spawn_failure_capture_policy_for_platform(kind, raw, platform),
            SpawnFailureCapturePolicy::CaptureRateLimited,
            "kind={kind:?} raw={raw:?} platform={platform:?}"
        );
    }
}

#[test]
fn spawn_failure_fingerprint_is_machine_path_independent() {
    let first = spawn_failure_fingerprint_token(ErrorKind::NotFound, Some(2));
    let second = spawn_failure_fingerprint_token(ErrorKind::NotFound, None);
    assert_eq!(first, second);
    assert_eq!(first, "not-found");
    assert!(!first.contains("/Users/"));
    assert!(!first.contains("/opt/homebrew/"));
    assert!(!first.contains("alice"));
}

#[test]
fn runner_stack_shape_recognises_both_libuv_windows_spellings() {
    let backslash = vec![
        r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76: C:\Users\Ada\secret-plan.md"
            .to_string(),
    ];
    let slash = vec![backslash[0].replace(r"src\win\async.c", "src/win/async.c")];

    let first = runner_stack_shape(&backslash);
    let second = runner_stack_shape(&slash);
    assert_ne!(first.shape, "all_redacted");
    assert_eq!(first, second);
}

#[test]
fn runner_stack_shape_preserves_multi_line_frame_order_and_distinguishes_shapes() {
    let first = runner_stack_shape(&[
        "at node:internal/process/task_queues:95:5".to_string(),
        "private application frame C:\\Users\\Ada\\secret-plan.md:10:2".to_string(),
        "at node:events:517:28".to_string(),
    ]);
    let second = runner_stack_shape(&[
        "at node:events:517:28".to_string(),
        "private application frame C:\\Users\\Grace\\other.md:90:4".to_string(),
        "at node:internal/process/task_queues:95:5".to_string(),
    ]);

    assert_eq!(first.shape, "node_task_queues>app>node_events");
    assert_eq!(first.signature, "90c372213834ca17");
    assert_eq!(first.depth, 3);
    assert_eq!(first.redacted_frames, 1);
    assert_ne!(first.shape, second.shape);
    assert_ne!(first.signature, second.signature);
}

#[test]
fn runner_stack_shape_recognises_named_v8_parenthesized_locations() {
    let shape = runner_stack_shape(&[
        "at Module._compile (node:internal/modules/cjs/loader:1356:14)".to_string(),
        "at EventEmitter.emit (node:events:517:28)".to_string(),
    ]);

    assert_eq!(shape.shape, "node_cjs_loader>node_events");
    assert_eq!(shape.depth, 2);
    assert_eq!(shape.redacted_frames, 0);
}

#[test]
fn runner_stack_shape_has_an_honest_all_redacted_contract_and_eight_frame_cap() {
    let private_a = runner_stack_shape(&[
        "at C:\\Users\\Ada\\secret-plan.md:10:2".to_string(),
        "at company_private_symbol:20:4".to_string(),
    ]);
    let private_b = runner_stack_shape(&[
        "at /Users/grace/another-secret.md:99:8".to_string(),
        "at different_private_symbol:1:1".to_string(),
    ]);
    assert_eq!(private_a.shape, "all_redacted");
    assert_eq!(private_a.signature, "unknown");
    assert_eq!(private_a.redacted_frames, private_a.depth);
    assert_eq!(private_b.shape, "all_redacted");
    assert_eq!(private_b.signature, "unknown");

    let many = (0..12)
        .map(|_| "at node:fs:1:1".to_string())
        .collect::<Vec<_>>();
    let capped = runner_stack_shape(&many);
    assert_eq!(capped.depth, 8);
    assert_eq!(capped.shape.split('>').count(), 8);
    assert!(capped
        .shape
        .split('>')
        .all(|token| RUNNER_STACK_TOKENS.contains(&token)));
}

#[test]
fn runner_stack_shape_rejects_marker_spoofing_outside_frame_positions() {
    for line in [
        "message embedding node:fs for a user",
        "home path /Users/Ada/node:internal/process/task_queues",
        "symbol core::panicking_helper",
        "file src/win/async.c.bak",
    ] {
        let shape = runner_stack_shape(&[line.to_string()]);
        assert_eq!(shape.shape, "all_redacted", "line={line}");
        assert_eq!(shape.signature, "unknown", "line={line}");
    }
}

// ── V8 heap-OOM retention + attribution (HQ-DESKTOP-55) ─────────────────
//
// Both fixtures are the EXACT stderr of a real reproduced V8 heap OOM on
// node v22 (exit 134/SIGABRT). They share an identical first-8 machinery
// prefix and diverge only from frame 9, differing in their allocating
// frame — the direct proof the review demanded that a fixed 8-frame window
// plus fixed-token hashing cannot discriminate them, but a signature over
// the full captured section can.

/// Fixture A — array-allocation OOM, 16 native frames, allocating frame
/// `v8::internal::Runtime_NewArray` at depth 15.
const HEAP_OOM_FIXTURE_A: &[&str] = &[
    "",
    "<--- Last few GCs --->",
    "",
    "[1174487:0x1e0a3000]       66 ms: Mark-Compact 47.7 (80.5) -> 47.7 (80.5) MB, pooled: 0 MB, 1.65 / 0.00 ms  (average mu = 0.862, current mu = 0.808) allocation failure; scavenge might not succeed",
    "",
    "",
    "<--- JS stacktrace --->",
    "",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "----- Native stack trace -----",
    "",
    " 1: 0xe46bbe node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
    " 2: 0x1243740 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
    " 3: 0x1243a17 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
    " 4: 0x1472925  [node]",
    " 5: 0x148c1b9 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]",
    " 6: 0x14608b8 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
    " 7: 0x14617e5 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
    " 8: 0x1439b0e v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]",
    " 9: 0x1427e9a v8::internal::FactoryBase<v8::internal::Factory>::AllocateRawArray(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]",
    "10: 0x1428608 v8::internal::FactoryBase<v8::internal::Factory>::NewFixedDoubleArray(int, v8::internal::AllocationType) [node]",
    "11: 0x16075a6  [node]",
    "12: 0x1621b62  [node]",
    "13: 0x1642638  [node]",
    "14: 0x1644ba5 v8::internal::ArrayConstructInitializeElements(v8::internal::Handle<v8::internal::JSArray>, v8::internal::Arguments<(v8::internal::ArgumentsType)1>*) [node]",
    "15: 0x1889f5d v8::internal::Runtime_NewArray(int, unsigned long*, v8::internal::Isolate*) [node]",
    "16: 0x1dfcaf6  [node]",
    "timeout: the monitored command dumped core",
];

/// Fixture B — string-flatten OOM, 14 native frames, allocating frame
/// `v8::internal::Runtime_StringSubstring` at depth 13. GC line is `47.4`.
const HEAP_OOM_FIXTURE_B: &[&str] = &[
    "",
    "<--- Last few GCs --->",
    "",
    "[2510830:0x1f857000]       73 ms: Mark-Compact 47.4 (80.5) -> 47.4 (80.5) MB, pooled: 0 MB, 8.34 / 0.00 ms  (average mu = 0.681, current mu = 0.276) allocation failure; scavenge might not succeed",
    "",
    "",
    "<--- JS stacktrace --->",
    "",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "----- Native stack trace -----",
    "",
    " 1: 0xe46bbe node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
    " 2: 0x1243740 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
    " 3: 0x1243a17 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
    " 4: 0x1472925  [node]",
    " 5: 0x148c1b9 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]",
    " 6: 0x14608b8 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
    " 7: 0x14617e5 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
    " 8: 0x1439b0e v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]",
    " 9: 0x1428944 v8::internal::FactoryBase<v8::internal::Factory>::AllocateRawWithImmortalMap(int, v8::internal::AllocationType, v8::internal::Tagged<v8::internal::Map>, v8::internal::AllocationAlignment) [node]",
    "10: 0x1429e0e v8::internal::FactoryBase<v8::internal::Factory>::NewRawOneByteString(int, v8::internal::AllocationType) [node]",
    "11: 0x178001d v8::internal::String::SlowFlatten(v8::internal::Isolate*, v8::internal::Handle<v8::internal::ConsString>, v8::internal::AllocationType) [node]",
    "12: 0x143d1eb v8::internal::Factory::NewProperSubString(v8::internal::Handle<v8::internal::String>, int, int) [node]",
    "13: 0x18bd5ea v8::internal::Runtime_StringSubstring(int, unsigned long*, v8::internal::Isolate*) [node]",
    "14: 0x1dfcaf6  [node]",
    "timeout: the monitored command dumped core",
];

fn feed_stderr(totals: &mut RunTotals, lines: &[&str]) {
    for line in lines {
        totals.record_stderr_line(line);
    }
}

/// The expected first-8 shape both fixtures share (their machinery prefix).
const HEAP_OOM_SHARED_SHAPE: &str = "node_oom_handler>v8_report_oom>v8_fatal_process_oom>anon>\
         v8_heap>v8_heap_allocator>v8_heap_allocator>v8_factory";

#[test]
fn heap_oom_fixture_a_yields_class_scoped_shape_and_evidence() {
    // PRE-FIX pin (mandatory non-vacuity): the generic tail path over the
    // shipped last-8 lines is exactly the observed HQ-DESKTOP-55 output —
    // all_redacted / unknown / redacted == depth — so the improvement is real.
    let last_eight: Vec<String> = HEAP_OOM_FIXTURE_A
        .iter()
        .rev()
        .take(RUNNER_STACK_FRAME_CAP)
        .rev()
        .map(|line| line.to_string())
        .collect();
    let generic = runner_stack_shape(&last_eight);
    assert_eq!(generic.shape, "all_redacted");
    assert_eq!(generic.signature, "unknown");
    assert_eq!(generic.redacted_frames, generic.depth);

    let mut totals = RunTotals::default();
    feed_stderr(&mut totals, HEAP_OOM_FIXTURE_A);

    assert_eq!(totals.runner_heap_oom_banner(), Some("reached_heap_limit"));
    assert_eq!(totals.runner_heap_used_total_mb(), Some((48, 81)));
    assert_eq!(totals.runner_heap_oom_frame_count(), Some(16));

    let stack = totals.runner_heap_oom_stack().expect("class-scoped shape");
    assert_eq!(stack.shape, HEAP_OOM_SHARED_SHAPE);
    assert_eq!(stack.depth, 8);
    assert_eq!(stack.redacted_frames, 1);
    assert_eq!(stack.signature.len(), 16);
    assert_ne!(stack.signature, "unknown");
    assert!(stack.signature.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(stack
        .shape
        .split('>')
        .all(|token| RUNNER_STACK_TOKENS.contains(&token)));

    // The selection helper prefers the class-scoped shape over the tail.
    assert_eq!(runner_stack_shape_for_exit(&totals, &last_eight), stack);
}

#[test]
fn heap_oom_fixtures_discriminate_allocation_sites() {
    let mut a = RunTotals::default();
    feed_stderr(&mut a, HEAP_OOM_FIXTURE_A);
    let mut b = RunTotals::default();
    feed_stderr(&mut b, HEAP_OOM_FIXTURE_B);

    let stack_a = a.runner_heap_oom_stack().expect("a shape");
    let stack_b = b.runner_heap_oom_stack().expect("b shape");

    // Identical first-8 machinery shape …
    assert_eq!(stack_a.shape, HEAP_OOM_SHARED_SHAPE);
    assert_eq!(stack_b.shape, HEAP_OOM_SHARED_SHAPE);
    // … but DIFFERENT full-section signatures (the review's required test).
    assert_ne!(stack_a.signature, stack_b.signature);
    assert_eq!(a.runner_heap_oom_frame_count(), Some(16));
    assert_eq!(b.runner_heap_oom_frame_count(), Some(14));
    assert_eq!(b.runner_heap_used_total_mb(), Some((47, 81)));

    // Determinism: re-feeding reproduces the identical signature (addresses,
    // pids, and module suffixes provably excluded from the digest).
    let mut a2 = RunTotals::default();
    feed_stderr(&mut a2, HEAP_OOM_FIXTURE_A);
    assert_eq!(
        a2.runner_heap_oom_stack().unwrap().signature,
        stack_a.signature
    );
}

#[test]
fn heap_oom_signature_changes_when_only_the_allocating_frame_differs() {
    let mut original = RunTotals::default();
    feed_stderr(&mut original, HEAP_OOM_FIXTURE_A);
    let original_sig = original.runner_heap_oom_stack().unwrap().signature;

    // Fixture A with ONLY the allocating frame's symbol swapped — the
    // allocating site sits inside the digested full section, so the digest
    // must change even though every other frame is byte-identical.
    let mut swapped = RunTotals::default();
    for line in HEAP_OOM_FIXTURE_A {
        swapped.record_stderr_line(&line.replace("Runtime_NewArray", "Runtime_StringSubstring"));
    }
    assert_ne!(
        swapped.runner_heap_oom_stack().unwrap().signature,
        original_sig
    );
}

#[test]
fn heap_oom_evidence_banners_rounding_and_both_or_neither() {
    // Round-half-away-from-zero on the raw GC parser.
    assert_eq!(
        parse_gc_heap_candidate("x -> 47.7 (80.5) MB, tail")
            .map(|(u, t)| (round_mb(u), round_mb(t))),
        Some((48, 81))
    );
    assert_eq!(round_mb(47.4), 47);
    assert_eq!(round_mb(47.5), 48);
    assert_eq!(round_mb(80.5), 81);

    // Malformed / out-of-bounds GC lines degrade to absent, never wrong.
    assert_eq!(parse_gc_heap_candidate("prose with no arrow"), None);
    assert_eq!(parse_gc_heap_candidate("x -> 10.0 (20.0) kB"), None);
    assert_eq!(parse_gc_heap_candidate("x -> 2000000.0 (5.0) MB"), None);

    // Ineffective-mark-compacts banner arm.
    let mut ineffective = RunTotals::default();
    ineffective.record_stderr_line(
        "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
    );
    assert_eq!(
        ineffective.runner_heap_oom_banner(),
        Some("ineffective_mark_compacts")
    );

    // Banner with no preceding GC line → banner + zero frames, no MB (both-
    // or-neither), and the stack falls back (None) because there are no frames.
    let mut banner_only = RunTotals::default();
    banner_only.record_stderr_line(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    );
    assert_eq!(
        banner_only.runner_heap_oom_banner(),
        Some("reached_heap_limit")
    );
    assert_eq!(banner_only.runner_heap_used_total_mb(), None);
    assert_eq!(banner_only.runner_heap_oom_frame_count(), Some(0));
    assert_eq!(banner_only.runner_heap_oom_stack(), None);
}

#[test]
fn heap_oom_gc_candidate_keeps_last_reading_and_freezes_peak_at_banner() {
    let mut totals = RunTotals::default();
    totals.record_stderr_line("x 10.0 (20.0) -> 10.0 (20.0) MB, tail");
    totals.record_stderr_line("x 30.4 (40.6) -> 30.4 (40.6) MB, tail");
    // The GC value can fall after its peak. The existing used/total fields
    // intentionally retain this final reading; the peak accessor must not.
    totals.record_stderr_line("x 20.1 (40.6) -> 20.1 (40.6) MB, tail");
    totals.record_stderr_line(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    );
    assert_eq!(totals.runner_heap_used_total_mb(), Some((20, 41)));
    assert_eq!(totals.runner_heap_peak_used_mb(), Some(30));
    // A GC-shaped line AFTER the banner never moves the frozen value.
    totals.record_stderr_line("x 99.9 (99.9) -> 99.9 (99.9) MB, tail");
    assert_eq!(totals.runner_heap_used_total_mb(), Some((20, 41)));
    assert_eq!(totals.runner_heap_peak_used_mb(), Some(30));
}

#[test]
fn heap_oom_capture_boundaries_and_cap() {
    // Full fixture: the marker + blank preamble is tolerated, all 16 frames
    // captured, and the `timeout: … dumped core` trailer ends the capture.
    let mut totals = RunTotals::default();
    feed_stderr(&mut totals, HEAP_OOM_FIXTURE_A);
    assert_eq!(totals.runner_heap_oom_frame_count(), Some(16));

    // Cap: a banner followed by more than the cap of address-only frames caps.
    let mut capped = RunTotals::default();
    capped.record_stderr_line(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    );
    for index in 1..=40 {
        capped.record_stderr_line(&format!("{index}: 0x{index:x} v8::internal::Thing [node]"));
    }
    assert_eq!(
        capped.runner_heap_oom_frame_count(),
        Some(HEAP_OOM_FRAME_CAP as u32)
    );
}

#[test]
fn heap_oom_all_anon_stack_still_beats_all_redacted() {
    // An unsymbolized build prints address-only frames: every frame normalizes
    // to `anon`, but a banner, frame count, and an honest shape + signature
    // still attach — strictly better than today's all_redacted/unknown.
    let mut totals = RunTotals::default();
    totals.record_stderr_line(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    );
    for index in 1..=5 {
        totals.record_stderr_line(&format!("{index}: 0x{index:x}  [node]"));
    }
    let stack = totals.runner_heap_oom_stack().expect("shape");
    assert_eq!(stack.shape, "anon>anon>anon>anon>anon");
    assert_eq!(stack.redacted_frames, 5);
    assert_eq!(stack.depth, 5);
    assert_ne!(stack.signature, "unknown");
    assert_eq!(stack.signature.len(), 16);
}

#[test]
fn heap_oom_never_emits_paths_symbols_or_secrets() {
    let mut totals = RunTotals::default();
    totals.record_stderr_line(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    );
    // Hostile frames: a /Users path in the bracket suffix, a secret-looking
    // symbol, and an over-long symbol. Only fixed tokens + a 16-hex digest
    // may escape; the raw bytes never do.
    totals.record_stderr_line(
        " 1: 0xdead v8::internal::Runtime_Secret_sk_live_ABCDEF [/Users/alice/secret-plan.md]",
    );
    totals.record_stderr_line(&format!(" 2: 0xbeef node::{} [node]", "A".repeat(4096)));
    let stack = totals.runner_heap_oom_stack().expect("shape");
    assert_eq!(stack.shape, "v8_runtime>node_native");
    for token in stack.shape.split('>') {
        assert!(RUNNER_STACK_TOKENS.contains(&token), "leaked token {token}");
    }
    assert_eq!(stack.signature.len(), 16);
    for needle in ["/Users", "sk_live", "secret-plan", "AAAA"] {
        assert!(!stack.shape.contains(needle), "shape leaked {needle}");
        assert!(
            !stack.signature.contains(needle),
            "signature leaked {needle}"
        );
    }
}

#[test]
fn heap_oom_reset_clears_all_state() {
    let mut totals = RunTotals::default();
    feed_stderr(&mut totals, HEAP_OOM_FIXTURE_A);
    assert!(totals.runner_heap_oom_stack().is_some());
    // The per-pass reset (AllComplete / fresh run) clears every heap field.
    totals = RunTotals::default();
    assert_eq!(totals.runner_heap_oom_banner(), None);
    assert_eq!(totals.runner_heap_used_total_mb(), None);
    assert_eq!(totals.runner_heap_oom_frame_count(), None);
    assert_eq!(totals.runner_heap_oom_stack(), None);
}

#[test]
fn non_heap_oom_stderr_leaves_generic_path_untouched() {
    let mut totals = RunTotals::default();
    totals.record_stderr_line(
        r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 76",
    );
    totals.record_stderr_line(r#"{"type":"error","code":"X","message":"nope"}"#);
    assert_eq!(totals.runner_heap_oom_banner(), None);
    assert_eq!(totals.runner_heap_oom_stack(), None);
    // The selection helper returns the generic tail shape byte-identically.
    let tail = vec!["at node:fs:1:1".to_string()];
    assert_eq!(
        runner_stack_shape_for_exit(&totals, &tail),
        runner_stack_shape(&tail)
    );
}

#[test]
fn shared_runner_phase_vocabulary_matches_the_watcher_contract() {
    let push: SyncEvent = serde_json::from_str(
        r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"up"}"#,
    )
    .expect("progress event");
    let pull: SyncEvent = serde_json::from_str(
        r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"down"}"#,
    )
    .expect("progress event");

    assert_eq!(runner_phase_from_event(&push), Some("push"));
    assert_eq!(runner_phase_from_event(&pull), Some("pull"));
    assert_eq!(
        runner_phase_elapsed_bucket(Duration::from_secs(59)),
        "under_1m"
    );
    assert_eq!(
        runner_phase_elapsed_bucket(Duration::from_secs(60)),
        "1m_to_5m"
    );
    assert_eq!(
        runner_phase_elapsed_bucket(Duration::from_secs(2 * 60 * 60)),
        "over_2h"
    );
}

#[test]
fn two_distinct_libuv_async_assertions_yield_distinct_identity_same_shape() {
    // HQ-DESKTOP-50: two DIFFERENT assertions in the same libuv source today
    // collapse to byte-identical telemetry (shape-hash signature only). The
    // assertion parser recovers the discriminating identity: same source
    // token, DIFFERENT expression signature, and each line's own integer.
    let a = parse_runner_assertion(
        r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76",
    )
    .expect("assertion a parses");
    let b = parse_runner_assertion(
        r"Assertion failed: handle->async_sent == 0, file src\win\async.c, line 112",
    )
    .expect("assertion b parses");

    assert_eq!(a.source, "libuv_win_async");
    assert_eq!(b.source, "libuv_win_async");
    assert_eq!(a.line, Some(76));
    assert_eq!(b.line, Some(112));
    assert_ne!(
        a.signature, b.signature,
        "distinct expressions must produce distinct signatures"
    );
    // 16-hex digest shape, and never the expression text.
    for assertion in [&a, &b] {
        assert_eq!(assertion.signature.len(), 16);
        assert!(assertion
            .signature
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
    }
    assert!(!a.signature.contains("UV_HANDLE_CLOSING"));

    // Routed through the same RunTotals seam both telemetry routes read: the
    // two lines produce distinct stored signatures while keeping the class.
    let mut totals_a = RunTotals::default();
    totals_a.record_stderr_line(
        r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76",
    );
    let mut totals_b = RunTotals::default();
    totals_b.record_stderr_line(
        r"Assertion failed: handle->async_sent == 0, file src\win\async.c, line 112",
    );
    assert_eq!(totals_a.runner_fatal_class, RunnerFatalClass::LibuvAssert);
    assert_eq!(totals_b.runner_fatal_class, RunnerFatalClass::LibuvAssert);
    assert_eq!(totals_a.runner_assert_source(), Some("libuv_win_async"));
    assert_ne!(
        totals_a.runner_assert_signature(),
        totals_b.runner_assert_signature()
    );
    assert_eq!(totals_a.runner_assert_line(), Some(76));
}

#[test]
fn runner_assertion_never_copies_input_bytes() {
    // The canonical live line with a private Windows path appended after the
    // line number (the fixture shape used elsewhere in this file). No field
    // may carry any part of the expression, the path, or the username.
    let private = r"C:\Users\Ada\companies\personal\secret-plan.md";
    let line = format!(
        "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76: {private}"
    );
    let assertion = parse_runner_assertion(&line).expect("assertion parses");
    assert_eq!(assertion.source, "libuv_win_async");
    assert_eq!(assertion.line, Some(76));
    let rendered = format!(
        "{}|{}|{:?}",
        assertion.source, assertion.signature, assertion.line
    );
    for forbidden in [
        "Ada",
        "secret-plan",
        "personal",
        "async.c",
        "UV_HANDLE_CLOSING",
        "handle",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "assertion identity leaked {forbidden}"
        );
    }
}

#[test]
fn non_assertion_and_malformed_lines_carry_no_wrong_identity() {
    // A non-assertion line yields no assertion at all — no sentinel spam.
    assert_eq!(
        parse_runner_assertion("ReadDirectoryChangesW: (5) Access is denied."),
        None
    );
    assert_eq!(parse_runner_assertion(""), None);

    // A malformed `line` field degrades to absent, never a wrong integer;
    // an unrecognised source degrades to the `other` sentinel.
    let malformed =
        parse_runner_assertion("Assertion failed: cond, file src/vendor/thing.c, line notanumber")
            .expect("expression present");
    assert_eq!(malformed.source, "other");
    assert_eq!(malformed.line, None);
    assert!(!malformed.signature.is_empty());

    // Non-assertion fatal classes leave the assertion fields untouched.
    let mut totals = RunTotals::default();
    totals.record_stderr_line("ReadDirectoryChangesW: (5) Access is denied.");
    assert_eq!(
        totals.runner_fatal_class,
        RunnerFatalClass::LibuvFatalSyscall
    );
    assert_eq!(totals.runner_assert_source(), None);
    assert_eq!(totals.runner_assert_line(), None);
    assert_eq!(totals.runner_assert_signature(), None);
}

#[test]
fn runner_phase_vocabulary_distinguishes_pre_protocol_from_unknown() {
    // The never-observed sentinel is a real, distinct member; a directionless
    // Progress still maps to `unknown`, so the two states are separable.
    assert_eq!(
        RUNNER_PHASE_VOCABULARY,
        &["scan", "push", "pull", "idle", "unknown", "pre_protocol"]
    );
    assert!(RUNNER_PHASE_VOCABULARY.contains(&RUNNER_PHASE_PRE_PROTOCOL));
    assert_ne!(RUNNER_PHASE_PRE_PROTOCOL, "unknown");

    let directionless: SyncEvent = serde_json::from_str(
        r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1}"#,
    )
    .expect("progress event");
    assert_eq!(runner_phase_from_event(&directionless), Some("unknown"));
}

// ── disk-exhaustion terminal-exit misreport (HQ-DESKTOP-5D) ──────────────

fn rollup_of(enospc: u32, eperm: u32, other: u32) -> RunnerErrorRollup {
    RunnerErrorRollup {
        enospc,
        eperm,
        other,
        ..Default::default()
    }
}

/// Reconstruct the exact HQ-DESKTOP-5D run shape from its content-safe axes:
/// an ordinary stderr line, the hq-cloud ndjson ENOSPC protocol error
/// (per-file path, no company), and an npm companion line whose own
/// `npm error ` prefix wins the last-non-None fatal attribution — plus the
/// parsed ENOSPC error record that drives the rollup.
fn hq_desktop_5d_run_totals() -> RunTotals {
    let mut totals = RunTotals::default();
    // #1 ordinary line → (other;none)
    totals.record_stderr_line("[hq-cloud] starting pull for 3 companies");
    // #2 the hq-cloud ndjson ENOSPC error line → (enospc;disk_full after fix)
    let enospc_line = r#"{"type":"error","path":"companies/acme/big.bin","message":"ENOSPC: no space left on device, open 'companies/acme/big.bin'"}"#;
    totals.record_stderr_line(enospc_line);
    // #3 the npm companion line → (other;npm_install_relay), the messenger
    totals.record_stderr_line(
        "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-log.log",
    );
    // The parsed ENOSPC error record — what record_error increments.
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "companies/acme/big.bin".to_string(),
        message: "ENOSPC: no space left on device, open 'companies/acme/big.bin'".to_string(),
    });
    totals
}

#[test]
fn hq_desktop_5d_disk_full_exit_is_diskfull_not_alert() {
    let totals = hq_desktop_5d_run_totals();
    // The rollup — immune to the last-wins fatal-class flap — proves disk-full,
    // even though the retained fatal class is the npm messenger.
    assert!(totals.runner_error_rollup.is_exclusively_disk_full());
    assert_eq!(totals.runner_fatal_class, RunnerFatalClass::NpmInstallRelay);
    assert!(!totals.saw_genuine_crash_fatal);
    assert!(totals.saw_alertable_error);
    assert!(runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        totals.saw_genuine_crash_fatal,
        &totals.runner_error_rollup
    ));
    // Exit code 1, no signal, no cancellation → DiskFull (was Alert pre-fix).
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(1),
            None,
            None,
            false,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup,
        ),
        RunnerExitDisposition::DiskFull
    );
    assert!(!should_alert_on_nonzero_exit_with_fault(
        Some(1),
        None,
        totals.saw_error,
        totals.saw_alertable_error,
        totals.saw_node_too_old,
        totals.saw_genuine_crash_fatal,
        &totals.runner_error_rollup,
    ));
    // Base (pre-fix) direction is genuinely red: the same inputs Alert today.
    assert_eq!(
        classify_runner_exit_disposition(
            Some(1),
            None,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old
        ),
        RunnerExitDisposition::Alert
    );
    assert!(should_alert_on_nonzero_exit(
        Some(1),
        None,
        totals.saw_error,
        totals.saw_alertable_error,
        totals.saw_node_too_old
    ));
}

#[test]
fn disk_full_arm_precedes_npm_relay_but_yields_to_genuine_crashes() {
    // npm's own ENOSPC code → disk_full, not npm_install_relay (arm ordering).
    assert_eq!(
        classify_runner_fatal_class("npm error code ENOSPC"),
        RunnerFatalClass::DiskFull
    );
    assert_eq!(
        classify_runner_fatal_class("npm ERR! code ENOSPC"),
        RunnerFatalClass::DiskFull
    );
    // hq-cloud errno phrase → disk_full.
    assert_eq!(
        classify_runner_fatal_class("ENOSPC: no space left on device, open '/x/y'"),
        RunnerFatalClass::DiskFull
    );
    // A heap-OOM banner that merely also mentions ENOSPC stays HeapOom.
    assert_eq!(
        classify_runner_fatal_class(
            "FATAL ERROR: Reached heap limit — JavaScript heap out of memory (near ENOSPC)"
        ),
        RunnerFatalClass::HeapOom
    );
    // A Rust panic whose text mentions ENOSPC stays RustPanic.
    assert_eq!(
        classify_runner_fatal_class("thread 'main' panicked at 'ENOSPC: no space left on device'"),
        RunnerFatalClass::RustPanic
    );
    // Token + membership + non-crash classification.
    assert_eq!(RunnerFatalClass::DiskFull.as_str(), "disk_full");
    assert!(RunnerFatalClass::ALL.contains(&RunnerFatalClass::DiskFull));
    assert!(!RunnerFatalClass::DiskFull.is_genuine_crash());
}

#[test]
fn npm_lifecycle_disk_failure_stays_npm_relay_and_alerts() {
    // A third-party build script that ran out of space: npm reports a lifecycle
    // failure (not its own top-level ENOSPC), so is_disk_exhaustion_failure
    // excludes it and the fatal class stays npm_install_relay — mirroring the
    // exclusion hq_cli_update already proves. Both spellings.
    for block in [
        "npm error code ELIFECYCLE\n\
             npm error errno 1\n\
             npm error some-pkg@1.0.0 build: `node-gyp rebuild`\n\
             npm error gyp ERR! ENOSPC: no space left on device\n\
             npm error Failed at the some-pkg@1.0.0 build script.\n\
             npm error A complete log of this run can be found in: /x/.npm/_logs/y.log",
        "npm ERR! code ELIFECYCLE\n\
             npm ERR! errno 1\n\
             npm ERR! gyp ERR! ENOSPC: no space left on device\n\
             npm ERR! command failed\n\
             npm ERR! A complete log of this run can be found in: /x/.npm/_logs/y.log",
    ] {
        assert_eq!(
            classify_runner_fatal_class(block),
            RunnerFatalClass::NpmInstallRelay,
            "npm lifecycle disk failure must stay npm_install_relay"
        );
    }
    // At the disposition level it keeps alerting: no exclusively-ENOSPC rollup.
    let empty = RunnerErrorRollup::default();
    assert!(!runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        false,
        &empty
    ));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(1),
            None,
            None,
            false,
            false,
            false,
            false,
            false,
            &empty,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn is_exclusively_disk_full_requires_enospc_and_nothing_else() {
    assert!(!RunnerErrorRollup::default().is_exclusively_disk_full());
    assert!(rollup_of(1, 0, 0).is_exclusively_disk_full());
    assert!(rollup_of(5, 0, 0).is_exclusively_disk_full());
    assert!(!rollup_of(1, 0, 1).is_exclusively_disk_full());
    assert!(!rollup_of(1, 1, 0).is_exclusively_disk_full());
    assert!(!rollup_of(0, 0, 1).is_exclusively_disk_full());
    assert!(rollup_of(1, 1, 0).has_non_disk_full_error());
    assert!(!rollup_of(1, 0, 0).has_non_disk_full_error());
}

#[test]
fn mixed_rollup_with_enospc_still_alerts() {
    // Presence of ENOSPC is not enough; a co-occurring EPERM keeps it alerting.
    let mixed = rollup_of(1, 1, 0);
    assert!(!runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        false,
        &mixed
    ));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(1),
            None,
            None,
            false,
            true,
            true,
            false,
            false,
            &mixed,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn crash_class_membership_is_pinned() {
    // The six genuine-crash classes drive the sticky flag; everything else
    // (including the disk-full and npm-relay messengers) does not.
    for crash in [
        RunnerFatalClass::LibuvAssert,
        RunnerFatalClass::LibuvFatalSyscall,
        RunnerFatalClass::NodeCheckAbort,
        RunnerFatalClass::NodeFatal,
        RunnerFatalClass::HeapOom,
        RunnerFatalClass::RustPanic,
    ] {
        assert!(
            crash.is_genuine_crash(),
            "{crash:?} must be a genuine crash"
        );
    }
    for non_crash in [
        RunnerFatalClass::ExecPermissionDenied,
        RunnerFatalClass::ExecNotFound,
        RunnerFatalClass::NodeTooOld,
        RunnerFatalClass::DiskFull,
        RunnerFatalClass::NpmInstallRelay,
        RunnerFatalClass::None,
    ] {
        assert!(
            !non_crash.is_genuine_crash(),
            "{non_crash:?} is not a crash"
        );
    }
}

#[test]
fn a_seen_crash_keeps_an_enospc_rollup_alerting() {
    // The sticky crash flag blocks disk-full suppression even with an
    // exclusively-ENOSPC rollup.
    let enospc = rollup_of(1, 0, 0);
    assert!(!runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        true,
        &enospc
    ));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(1),
            None,
            None,
            false,
            true,
            true,
            false,
            true,
            &enospc,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn a_genuine_crash_before_an_npm_companion_line_still_alerts() {
    // Finding 1: an ENOSPC protocol error, then a crash banner, then an npm
    // companion line. Last-non-None-wins buries the crash class under the npm
    // messenger, but the sticky flag preserves the crash so the exit stays
    // alertable rather than being suppressed as disk-full.
    let mut totals = RunTotals::default();
    totals.record_stderr_line("thread 'main' panicked at 'boom', crates/x/src/lib.rs:1:1");
    totals.record_stderr_line(
        "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/z.log",
    );
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "companies/acme/f.bin".to_string(),
        message: "ENOSPC: no space left on device, write 'companies/acme/f.bin'".to_string(),
    });
    // The retained class is the npm messenger …
    assert_eq!(totals.runner_fatal_class, RunnerFatalClass::NpmInstallRelay);
    // … but the sticky flag remembers the crash, and the rollup is ENOSPC-only.
    assert!(totals.saw_genuine_crash_fatal);
    assert!(totals.runner_error_rollup.is_exclusively_disk_full());
    assert!(!runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        totals.saw_genuine_crash_fatal,
        &totals.runner_error_rollup
    ));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(1),
            None,
            None,
            false,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn crash_signal_with_enospc_rollup_still_alerts() {
    let enospc = rollup_of(1, 0, 0);
    for signal in [
        SIGSEGV_SIGNAL,
        SIGBUS_SIGNAL_MACOS,
        SIGBUS_SIGNAL_LINUX,
        SIGABRT_SIGNAL,
        SIGKILL_SIGNAL,
        SIGILL_SIGNAL,
    ] {
        assert!(is_crash_signal(Some(signal)), "signal {signal} is a crash");
        assert!(!runner_exit_is_disk_exhaustion(
            None,
            Some(signal),
            false,
            &enospc
        ));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                None,
                Some(signal),
                None,
                false,
                true,
                true,
                false,
                false,
                &enospc,
            ),
            RunnerExitDisposition::Alert,
            "crash signal {signal} with ENOSPC must still Alert"
        );
    }
    // SIGTERM is the app's cancellation signal, never a crash.
    assert!(!is_crash_signal(Some(SIGTERM_SIGNAL)));
}

#[test]
fn npm_own_enospc_without_a_protocol_error_is_not_suppressed() {
    // Findings 2 & 3: an npm-own ENOSPC (or a per-line lifecycle phrase) that
    // emits NO parsed protocol error leaves the rollup empty. Suppression
    // requires the exclusively-ENOSPC rollup, so this startup shape keeps
    // alerting rather than routing to the HQ-folder free-space message (the
    // full volume may be the npx cache/home drive, and per-line classification
    // cannot see npm's multi-line lifecycle markers).
    let empty = RunnerErrorRollup::default();
    assert!(!runner_fault_is_disk_exhaustion_content(false, &empty));
    assert!(!runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        false,
        &empty
    ));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(1),
            None,
            None,
            false,
            false,
            false,
            false,
            false,
            &empty,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn windows_native_fault_code_with_enospc_rollup_still_alerts() {
    // Finding 0: on Windows a native fault is reported in `code` with
    // signal=None. It must never be suppressed as disk-full, even alongside an
    // exclusively-ENOSPC rollup.
    let enospc = rollup_of(1, 0, 0);
    for fault in [0xC000_0005u32, 0xC000_0409u32] {
        let code = Some(fault as i32);
        assert!(
            is_windows_fault_exit(code),
            "0x{fault:08X} is a windows fault"
        );
        assert!(!runner_exit_is_disk_exhaustion(code, None, false, &enospc));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                code, None, None, false, true, true, false, false, &enospc,
            ),
            RunnerExitDisposition::Alert,
            "windows fault 0x{fault:08X} with ENOSPC must still Alert"
        );
    }
    // A conventional small exit code is Ordinary, not a fault → suppressible.
    assert!(!is_windows_fault_exit(Some(1)));
    assert!(runner_exit_is_disk_exhaustion(
        Some(1),
        None,
        false,
        &enospc
    ));
}

#[test]
fn app_cancellation_still_wins_over_disk_full() {
    // A genuine app-owned Stop that races a disk-full line stays CancelledByApp
    // (no alertable error), preserving the existing cancellation precedence.
    // The app-owned termination exit shape is host-specific, so pick the shape
    // this host's classifier recognises (Posix: SIGTERM/SIGKILL with no code;
    // Windows: exit code 1 with no signal).
    let enospc = rollup_of(1, 0, 0);
    let (code, signal) = match current_termination_host() {
        TerminationHost::Posix => (None, Some(SIGTERM_SIGNAL)),
        TerminationHost::Windows => (Some(1), None),
    };
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            code,
            signal,
            Some(SyncCancelCause::UserStop),
            true,
            false,
            false,
            false,
            false,
            &enospc,
        ),
        RunnerExitDisposition::CancelledByApp(SyncCancelCause::UserStop)
    );
}

#[test]
fn fault_layer_only_ever_adds_diskfull_never_moves_an_existing_verdict() {
    // Full-input-lattice invariance: every input that is not a disk-full
    // verdict returns the byte-identical pre-fix disposition, and the only
    // change the fault layer can make is converting a base Alert to DiskFull.
    let rollups = [
        RunnerErrorRollup::default(),
        rollup_of(1, 0, 0), // exclusively disk full
        rollup_of(1, 1, 0), // mixed
        rollup_of(0, 0, 3), // other-only
    ];
    let codes = [
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(RUNNER_OPERATION_LOCKED_EXIT),
        Some(RUNNER_TRANSIENT_RETRY_EXIT),
        Some(127),
        Some(0xC000_0005u32 as i32), // a Windows native fault
    ];
    let signals = [
        None,
        Some(SIGTERM_SIGNAL),
        Some(SIGABRT_SIGNAL),
        Some(SIGSEGV_SIGNAL),
        Some(SIGKILL_SIGNAL),
    ];
    let causes = [None, Some(SyncCancelCause::UserStop)];
    for &code in &codes {
        for &signal in &signals {
            for &cause in &causes {
                for &effected in &[false, true] {
                    for &saw_error in &[false, true] {
                        for &saw_alertable in &[false, true] {
                            for &node_old in &[false, true] {
                                for &saw_crash in &[false, true] {
                                    for rollup in &rollups {
                                        let base =
                                            classify_runner_exit_disposition_with_cancellation(
                                                code,
                                                signal,
                                                cause,
                                                effected,
                                                saw_error,
                                                saw_alertable,
                                                node_old,
                                            );
                                        let fault = classify_runner_exit_disposition_with_fault(
                                            code,
                                            signal,
                                            cause,
                                            effected,
                                            saw_error,
                                            saw_alertable,
                                            node_old,
                                            saw_crash,
                                            rollup,
                                        );
                                        if fault == RunnerExitDisposition::DiskFull {
                                            assert_eq!(
                                                base,
                                                RunnerExitDisposition::Alert,
                                                "DiskFull may only replace a base Alert"
                                            );
                                            assert!(runner_exit_is_disk_exhaustion(
                                                code, signal, saw_crash, rollup
                                            ));
                                        } else {
                                            assert_eq!(
                                                fault, base,
                                                "fault layer moved a non-disk-full verdict"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn sync_disk_full_detail_is_fixed_and_content_safe() {
    // Names the condition, the one action, and the retry; never a path, an
    // exit code, the ENOSPC token, a digit, or a specific volume name.
    let m = SYNC_DISK_FULL_DETAIL;
    assert!(m.contains("HQ Sync"));
    assert!(m.to_lowercase().contains("space"));
    assert!(m.contains("Sync again"));
    assert!(!m.contains("ENOSPC"));
    assert!(!m.contains('/'));
    assert!(!m.chars().any(|c| c.is_ascii_digit()));
}

// ── transient file-lock terminal-exit misreport (HQ-DESKTOP-5R) ──────────

/// A rollup carrying `ebusy` plus optional non-file-lock classes, to exercise
/// the file-lock exclusivity gate without disturbing the disk-full helper.
fn rollup_ebusy(ebusy: u32, eperm: u32, other: u32) -> RunnerErrorRollup {
    RunnerErrorRollup {
        ebusy,
        eperm,
        other,
        ..Default::default()
    }
}

/// Reconstruct the exact HQ-DESKTOP-5R run shape from its content-safe axes: an
/// ordinary stderr line and the single hq-cloud ndjson EBUSY read error
/// (company-level), with no crash class and no fatal signature — the reported
/// runner_error_rollup=EBUSY:1 / runner_error_causes=ebusy:1 /
/// runner_fatal_class=none event.
fn hq_desktop_5r_run_totals() -> RunTotals {
    let mut totals = RunTotals::default();
    totals.record_stderr_line("[hq-cloud] starting pull for 1 company");
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(company)".to_string(),
        message: "EBUSY: resource busy or locked, read".to_string(),
    });
    totals
}

#[test]
fn hq_desktop_5r_file_lock_exit_is_filelocked_not_alert() {
    let totals = hq_desktop_5r_run_totals();
    // The parsed rollup is exactly one EBUSY, with no crash class.
    assert!(totals.runner_error_rollup.is_exclusively_file_locked());
    assert!(!totals.saw_genuine_crash_fatal);
    assert!(totals.saw_alertable_error);
    assert_eq!(totals.runner_fatal_class, RunnerFatalClass::None);
    assert!(runner_exit_is_file_lock(
        Some(2),
        None,
        totals.saw_genuine_crash_fatal,
        &totals.runner_error_rollup
    ));
    // Exit code 2, no signal, no cancellation → FileLocked (was Alert pre-fix).
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(2),
            None,
            None,
            false,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup,
        ),
        RunnerExitDisposition::FileLocked
    );
    assert!(!should_alert_on_nonzero_exit_with_fault(
        Some(2),
        None,
        totals.saw_error,
        totals.saw_alertable_error,
        totals.saw_node_too_old,
        totals.saw_genuine_crash_fatal,
        &totals.runner_error_rollup,
    ));
    // Base (pre-fix) direction is genuinely red: the same inputs Alert today.
    assert_eq!(
        classify_runner_exit_disposition(
            Some(2),
            None,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old
        ),
        RunnerExitDisposition::Alert
    );
    assert!(should_alert_on_nonzero_exit(
        Some(2),
        None,
        totals.saw_error,
        totals.saw_alertable_error,
        totals.saw_node_too_old
    ));
}

#[test]
fn is_exclusively_file_locked_requires_ebusy_and_nothing_else() {
    assert!(!RunnerErrorRollup::default().is_exclusively_file_locked());
    assert!(rollup_ebusy(1, 0, 0).is_exclusively_file_locked());
    assert!(rollup_ebusy(5, 0, 0).is_exclusively_file_locked());
    assert!(!rollup_ebusy(1, 0, 1).is_exclusively_file_locked()); // + other
    assert!(!rollup_ebusy(1, 1, 0).is_exclusively_file_locked()); // + eperm
    assert!(!rollup_ebusy(0, 0, 1).is_exclusively_file_locked()); // no ebusy
    assert!(rollup_ebusy(1, 1, 0).has_non_file_lock_error());
    assert!(!rollup_ebusy(1, 0, 0).has_non_file_lock_error());
}

#[test]
fn file_lock_and_disk_full_recognizers_are_disjoint() {
    // An exclusively-EBUSY rollup is never disk-full, and an exclusively-ENOSPC
    // rollup is never file-lock — so the two rewrites can never both fire.
    let ebusy = rollup_ebusy(1, 0, 0);
    assert!(ebusy.is_exclusively_file_locked());
    assert!(!ebusy.is_exclusively_disk_full());
    let enospc = rollup_of(1, 0, 0);
    assert!(enospc.is_exclusively_disk_full());
    assert!(!enospc.is_exclusively_file_locked());
    // EBUSS + ENOSPC together is exclusive to neither.
    let both = rollup_of_ebusy_enospc();
    assert!(!both.is_exclusively_file_locked());
    assert!(!both.is_exclusively_disk_full());
    assert!(both.has_non_file_lock_error());
    assert!(both.has_non_disk_full_error());
}

fn rollup_of_ebusy_enospc() -> RunnerErrorRollup {
    RunnerErrorRollup {
        ebusy: 1,
        enospc: 1,
        ..Default::default()
    }
}

#[test]
fn mixed_rollup_with_ebusy_still_alerts() {
    // Presence of EBUSY is not enough; a co-occurring EPERM keeps it alerting.
    let mixed = rollup_ebusy(1, 1, 0);
    assert!(!runner_exit_is_file_lock(Some(2), None, false, &mixed));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(2),
            None,
            None,
            false,
            true,
            true,
            false,
            false,
            &mixed,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn a_seen_crash_keeps_an_ebusy_rollup_alerting() {
    // The sticky crash flag blocks file-lock suppression even with an
    // exclusively-EBUSY rollup.
    let ebusy = rollup_ebusy(1, 0, 0);
    assert!(!runner_exit_is_file_lock(Some(2), None, true, &ebusy));
    assert_eq!(
        classify_runner_exit_disposition_with_fault(
            Some(2),
            None,
            None,
            false,
            true,
            true,
            false,
            true,
            &ebusy,
        ),
        RunnerExitDisposition::Alert
    );
}

#[test]
fn crash_signal_with_ebusy_rollup_still_alerts() {
    let ebusy = rollup_ebusy(1, 0, 0);
    for signal in [
        SIGSEGV_SIGNAL,
        SIGBUS_SIGNAL_MACOS,
        SIGBUS_SIGNAL_LINUX,
        SIGABRT_SIGNAL,
        SIGKILL_SIGNAL,
        SIGILL_SIGNAL,
    ] {
        assert!(is_crash_signal(Some(signal)), "signal {signal} is a crash");
        assert!(!runner_exit_is_file_lock(None, Some(signal), false, &ebusy));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                None,
                Some(signal),
                None,
                false,
                true,
                true,
                false,
                false,
                &ebusy,
            ),
            RunnerExitDisposition::Alert,
            "crash signal {signal} with EBUSY must still Alert"
        );
    }
}

#[test]
fn a_non_crash_fatal_signal_with_ebusy_rollup_still_alerts() {
    // HQ-DESKTOP-5R review (Codex P1): is_crash_signal does not enumerate every
    // fatal signal (e.g. SIGQUIT=3, SIGFPE=8, SIGSYS=12/31). Because the
    // recognizer requires signal.is_none(), an exclusively-EBUSY run terminated
    // by ANY signal — a listed crash or not — stays alertable and is never
    // suppressed as a file lock. Under the pre-review `!is_crash_signal` gate
    // these would have classified FileLocked.
    let ebusy = rollup_ebusy(1, 0, 0);
    for signal in [3, 8, 12, 31] {
        assert!(
            !is_crash_signal(Some(signal)),
            "signal {signal} is deliberately outside the crash list"
        );
        assert!(!runner_exit_is_file_lock(None, Some(signal), false, &ebusy));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                None,
                Some(signal),
                None,
                false,
                true,
                true,
                false,
                false,
                &ebusy,
            ),
            RunnerExitDisposition::Alert,
            "non-crash fatal signal {signal} with EBUSY must still Alert"
        );
    }
}

#[test]
fn windows_native_fault_code_with_ebusy_rollup_still_alerts() {
    // On Windows a native fault is reported in `code` with signal=None. It must
    // never be suppressed as file-lock, even alongside an exclusively-EBUSY rollup.
    let ebusy = rollup_ebusy(1, 0, 0);
    for fault in [0xC000_0005u32, 0xC000_0409u32] {
        let code = Some(fault as i32);
        assert!(
            is_windows_fault_exit(code),
            "0x{fault:08X} is a windows fault"
        );
        assert!(!runner_exit_is_file_lock(code, None, false, &ebusy));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                code, None, None, false, true, true, false, false, &ebusy,
            ),
            RunnerExitDisposition::Alert,
            "windows fault 0x{fault:08X} with EBUSY must still Alert"
        );
    }
    // A conventional small exit code is Ordinary, not a fault → suppressible.
    assert!(!is_windows_fault_exit(Some(2)));
    assert!(runner_exit_is_file_lock(Some(2), None, false, &ebusy));
}

#[test]
fn a_pass_with_plan_limit_skips_is_recorded_for_the_uploads_pause() {
    use crate::events::{SyncPlanLimitEvent, SyncProgressEvent};
    let mut totals = RunTotals::default();
    totals.accumulate(&SyncEvent::PlanLimit(SyncPlanLimitEvent {
        company: "Acme".to_string(),
        upgrade_url: "https://hq.computer/companies/acme/billing?upgrade=1".to_string(),
    }));
    totals.accumulate(&SyncEvent::PlanLimit(SyncPlanLimitEvent {
        company: "Beta".to_string(),
        upgrade_url: "https://app.indigo-hq.com/billing/upgrade".to_string(),
    }));
    let progress = |company: &str, direction: &str, deleted: Option<bool>| {
        SyncEvent::Progress(SyncProgressEvent {
            company: company.to_string(),
            path: "a.md".to_string(),
            bytes: 1,
            message: None,
            direction: Some(direction.to_string()),
            deleted,
            author: None,
        })
    };
    totals.accumulate(&progress("Gamma", "up", None));
    totals.accumulate(&progress("Delta", "down", None));
    totals.accumulate(&progress("Epsilon", "up", Some(true)));
    for company in ["Acme", "Gamma"] {
        totals.accumulate(&SyncEvent::Complete(SyncCompleteEvent {
            company: company.to_string(),
            files_downloaded: 0,
            bytes_downloaded: 0,
            files_skipped: 3,
            conflicts: 0,
            aborted: false,
            files_tombstoned: None,
            files_refused_stale: None,
        }));
    }

    let pass = &totals.uploads_pass;
    assert_eq!(
        pass.plan_limited.get("Acme").cloned().flatten().as_deref(),
        Some("https://hq.computer/companies/acme/billing?upgrade=1")
    );
    assert_eq!(pass.plan_limited.get("Beta"), Some(&None));
    assert_eq!(
        pass.uploaded.iter().map(String::as_str).collect::<Vec<_>>(),
        vec!["Gamma"]
    );
    assert_eq!(
        pass.completed
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["Acme", "Gamma"]
    );
    // A plan-limit notice is not an error: the pass stays clean.
    assert!(!totals.saw_error);
    assert!(!totals.saw_alertable_error);
}

#[test]
fn plan_limit_refusals_are_not_alertable() {
    // hard-stop-readiness US-018: hq-cloud `describeError` output for a
    // hard-stop 402, before and after US-004 adds `code` to the body.
    for message in [
        "VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 New files are paused while Acme is over its Starter limits.",
        "VaultClientError http=402 New files are paused while Acme is over its Starter limits.",
        "VaultClientError code=PLAN_LIMIT_REACHED New files are paused while your personal HQ is over its limits.",
    ] {
        for path in ["(company)", "knowledge/notes.md"] {
            let err = SyncErrorEvent {
                company: Some("acme".to_string()),
                path: path.to_string(),
                message: message.to_string(),
            };
            assert!(!is_alertable_error(&err), "{path}: {message}");
        }
    }
    // A plain 403 is still a defect.
    let forbidden = SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message: "VaultClientError http=403 Forbidden".to_string(),
    };
    assert!(is_alertable_error(&forbidden));

    // A run whose only errors were plan-limit refusals never alerts.
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "knowledge/notes.md".to_string(),
        message: "VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 New files are paused while Acme is over its Starter limits.".to_string(),
    });
    assert!(totals.saw_error);
    assert!(!totals.saw_alertable_error);
}

#[test]
fn is_alertable_error_still_true_for_ebusy() {
    // The fix was made at the exit-disposition layer, NOT by widening the
    // per-error benign list: an EBUSY error is still an alertable error, so any
    // run that also produces a non-file-lock fault keeps surfacing.
    let ebusy = SyncErrorEvent {
        company: None,
        path: "(company)".to_string(),
        message: "EBUSY: resource busy or locked, read".to_string(),
    };
    assert!(is_alertable_error(&ebusy));
}

#[test]
fn fault_layer_filelocked_only_replaces_a_base_alert() {
    // Full-input-lattice invariance with an EBUSY rollup in the set: the fault
    // layer may only convert a base Alert into DiskFull or FileLocked; every
    // other verdict is returned byte-identical, and each rewrite is gated by its
    // own recognizer.
    let rollups = [
        RunnerErrorRollup::default(),
        rollup_ebusy(1, 0, 0),    // exclusively file-locked
        rollup_ebusy(1, 1, 0),    // ebusy + eperm (mixed)
        rollup_of(1, 0, 0),       // exclusively disk-full
        rollup_of_ebusy_enospc(), // ebusy + enospc (neither exclusive)
        rollup_of(0, 0, 3),       // other-only
    ];
    let codes = [
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(RUNNER_OPERATION_LOCKED_EXIT),
        Some(RUNNER_TRANSIENT_RETRY_EXIT),
        Some(243),
        Some(0xC000_0005u32 as i32),
    ];
    let signals = [
        None,
        Some(SIGTERM_SIGNAL),
        Some(SIGSEGV_SIGNAL),
        Some(SIGKILL_SIGNAL),
    ];
    for &code in &codes {
        for &signal in &signals {
            for &saw_error in &[false, true] {
                for &saw_alertable in &[false, true] {
                    for &node_old in &[false, true] {
                        for &saw_crash in &[false, true] {
                            for rollup in &rollups {
                                let base = classify_runner_exit_disposition_with_cancellation(
                                    code,
                                    signal,
                                    None,
                                    false,
                                    saw_error,
                                    saw_alertable,
                                    node_old,
                                );
                                let fault = classify_runner_exit_disposition_with_fault(
                                    code,
                                    signal,
                                    None,
                                    false,
                                    saw_error,
                                    saw_alertable,
                                    node_old,
                                    saw_crash,
                                    rollup,
                                );
                                match fault {
                                    RunnerExitDisposition::DiskFull => {
                                        assert_eq!(base, RunnerExitDisposition::Alert);
                                        assert!(runner_exit_is_disk_exhaustion(
                                            code, signal, saw_crash, rollup
                                        ));
                                    }
                                    RunnerExitDisposition::FileLocked => {
                                        assert_eq!(base, RunnerExitDisposition::Alert);
                                        assert!(runner_exit_is_file_lock(
                                            code, signal, saw_crash, rollup
                                        ));
                                    }
                                    other => assert_eq!(
                                        other, base,
                                        "fault layer moved a non-fault verdict"
                                    ),
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn sync_file_locked_detail_is_fixed_and_content_safe() {
    // Names the condition, the one action, and the retry; never a path, an exit
    // code, the EBUSY token, a digit, or a specific file name.
    let m = SYNC_FILE_LOCKED_DETAIL;
    assert!(m.contains("HQ Sync"));
    assert!(m.contains("Sync again"));
    assert!(!m.contains("EBUSY"));
    assert!(!m.contains('/'));
    assert!(!m.chars().any(|c| c.is_ascii_digit()));
}

// ── Runner error SITE routing + attribution (HQ-DESKTOP-5M) ──────────────

#[test]
fn record_error_routes_every_producer_sentinel_to_its_own_site_never_the_file_arm() {
    // Each of the six hq-cloud error-event sentinels increments ONLY its own
    // site counter, is never given a path root, and never lands in the per-file
    // scope — the misrouting that made every unknown sentinel read
    // company:0,file:1 with path_roots=other:1.
    for (sentinel, token, scope_segment) in [
        ("(company)", "company:1", "company:1,file:0"),
        ("(discovery)", "discovery:1", "company:0,file:0,discovery:1"),
        (
            "(local-state)",
            "local_state:1",
            "company:0,file:0,local_state:1",
        ),
        ("(runner)", "runner:1", "company:0,file:0,runner:1"),
        ("(scope)", "scope:1", "company:0,file:0,scope:1"),
        // The (auth) site renders `identity` (denylist-safe), never `auth`.
        ("(auth)", "identity:1", "company:0,file:0,identity:1"),
    ] {
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: sentinel.to_string(),
            message: "state store preflight failed".to_string(),
        });
        assert_eq!(
            totals.runner_error_sites.tag_value().as_deref(),
            Some(token),
            "site token for {sentinel}"
        );
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some(scope_segment),
            "scope split for {sentinel}"
        );
        assert_eq!(
            totals.runner_error_path_roots.tag_value(),
            None,
            "sentinel {sentinel} must never be given a path root"
        );
    }
    // A genuine relative path still lands in the per-file arm with its path root.
    let mut file_totals = RunTotals::default();
    file_totals.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "knowledge/secret.md".to_string(),
        message: "download skipped: local parent escaped the sync root".to_string(),
    });
    assert_eq!(
        file_totals.runner_error_sites.tag_value().as_deref(),
        Some("file:1")
    );
    assert_eq!(
        file_totals.runner_error_scope().as_deref(),
        Some("company:0,file:1")
    );
    assert_eq!(
        file_totals.runner_error_path_roots.tag_value().as_deref(),
        Some("knowledge:1")
    );
}

#[test]
fn runner_error_scope_prefix_is_byte_identical_for_company_and_file_only() {
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: Some("a".to_string()),
        path: "(company)".to_string(),
        message: "x".to_string(),
    });
    for path in ["knowledge/a.md", "repos/b"] {
        totals.record_error(&SyncErrorEvent {
            company: Some("a".to_string()),
            path: path.to_string(),
            message: "y".to_string(),
        });
    }
    // Exactly the pre-change rendering — no new segment appears when only company
    // and file errors were recorded, so any dashboard/alert parsing the prefix is
    // unaffected.
    assert_eq!(
        totals.runner_error_scope().as_deref(),
        Some("company:1,file:2")
    );
}

#[test]
fn the_observed_hq_desktop_5m_local_state_exit_is_now_fully_attributed() {
    // The reported population: exactly ONE error event per run, a (local-state)
    // preflight failure shipping a bare err.message. On base every axis read
    // unknown/other and the scope split lied company:0,file:1. Now the site names
    // it and nothing is misrouted to the file/path-root arm.
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(local-state)".to_string(),
        message: "journal state store is unreadable".to_string(),
    });
    assert_eq!(
        totals.runner_error_sites.tag_value().as_deref(),
        Some("local_state:1")
    );
    assert_eq!(totals.runner_error_sites.fingerprint_token(), "local_state");
    assert_eq!(
        totals.runner_error_scope().as_deref(),
        Some("company:0,file:0,local_state:1")
    );
    // The sentinel is never fed to classify_runner_path_root: the `other:1`
    // pollution is gone.
    assert_eq!(totals.runner_error_path_roots.tag_value(), None);
    // A bare err.message carries no leading CamelCase identity, so it stays an
    // honest unknown_unnamed with no signature — the message really is nameless.
    assert_eq!(
        totals.runner_error_causes.tag_value().as_deref(),
        Some("unknown_unnamed:1")
    );
    assert_eq!(totals.runner_error_cause_signature.tag_value(), None);
}

#[test]
fn runner_stack_shape_for_exit_prefers_the_embedded_runner_stack_over_an_all_redacted_tail() {
    use crate::runner_error_shape::{classify_runner_stack_input, RunnerStackInput};
    // A (runner) uncaught rejection embeds its err.stack INSIDE the message; the
    // stderr tail is a flood of ndjson records (all_redacted). The exit now
    // reports the shaped embedded stack instead of all_redacted, while
    // runner_stack_input still reports what the TAIL was.
    let stack_message = "VaultShardError: shard 7 unreadable\n    at loadShard (node:internal/modules/cjs/loader:120:5)\n    at Module._compile (node:internal/modules/cjs/loader:1560:14)";
    let mut totals = RunTotals::default();
    totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(runner)".to_string(),
        message: stack_message.to_string(),
    });
    let tail = vec![
        r#"{"type":"error","path":"(runner)","message":"boom"}"#.to_string(),
        "some plain trailing line".to_string(),
    ];
    // The tail on its own is honestly all_redacted and mixed.
    assert_eq!(runner_stack_shape(&tail).shape, "all_redacted");
    assert_eq!(classify_runner_stack_input(&tail), RunnerStackInput::Mixed);
    let shape = runner_stack_shape_for_exit(&totals, &tail);
    assert_ne!(
        shape.shape, "all_redacted",
        "embedded (runner) stack must be preferred"
    );
    assert!(
        shape.redacted_frames < shape.depth,
        "a recognised stack has fewer redacted frames than its depth"
    );
    assert!(
        shape.shape.contains("node_cjs_loader"),
        "recognised node frames shape it: {}",
        shape.shape
    );
    // Content safety: the shape/signature never carry a message byte.
    for forbidden in ["VaultShardError", "loadShard", "shard"] {
        assert!(
            !shape.shape.contains(forbidden) && !shape.signature.contains(forbidden),
            "embedded shape leaked {forbidden:?}"
        );
    }

    // A (local-state) message with no frames stays honestly all_redacted: no
    // embedded shape is stored, so the tail's all_redacted is authoritative.
    let mut ls_totals = RunTotals::default();
    ls_totals.record_error(&SyncErrorEvent {
        company: None,
        path: "(local-state)".to_string(),
        message: "state store preflight failed".to_string(),
    });
    assert_eq!(ls_totals.runner_embedded_stack_shape(), None);
    assert_eq!(
        runner_stack_shape_for_exit(&ls_totals, &tail).shape,
        "all_redacted"
    );
}

#[test]
fn re_scoping_the_auth_sentinel_leaves_the_alert_and_reauth_signals_unchanged() {
    // Moving the (auth) error-event sentinel out of the per-file arm must not
    // change alerting, suppression, or the re-authentication signal: those read
    // the message (and the auth-error protocol event), never err.path.
    let auth_err = SyncErrorEvent {
        company: None,
        path: "(auth)".to_string(),
        message: "AccessDenied http=403 forbidden".to_string(),
    };
    let file_auth = SyncErrorEvent {
        company: None,
        path: "knowledge/x.md".to_string(),
        message: "AccessDenied http=403 forbidden".to_string(),
    };
    // is_alertable_error reads only the message, so the verdict is identical
    // whether the path is the (auth) sentinel or a plain file path.
    assert_eq!(
        is_alertable_error(&auth_err),
        is_alertable_error(&file_auth)
    );
    assert!(is_alertable_error(&auth_err));

    let mut totals = RunTotals::default();
    totals.record_error(&auth_err);
    // The AUTH class rollup still names it from the message, independent of scope,
    assert_eq!(totals.runner_error_rollup.fingerprint_token(), "auth");
    // the alertable flag is set from the message,
    assert!(totals.saw_alertable_error);
    // and record_error never sets the reauth signal (that is the AuthError
    // protocol event's job), so it stays false.
    assert!(!totals.saw_auth_error);
    // The site is attributed to the auth sentinel, spelled `identity` (never the
    // `auth` substring Sentry's @password:filter eats), and never `file`.
    assert_eq!(
        totals.runner_error_sites.tag_value().as_deref(),
        Some("identity:1")
    );
    assert_eq!(
        totals.runner_error_scope().as_deref(),
        Some("company:0,file:0,identity:1")
    );
}

// ── pre-runner (first-push phase) attribution (HQ-DESKTOP-64) ────────────────

#[test]
fn record_pre_runner_failure_feeds_only_dedicated_rollups_and_http() {
    let mut totals = RunTotals::default();
    totals.record_pre_runner_failure(
        PreRunnerSite::FirstPush,
        Some(403),
        PreRunnerCause::ScopeExceedsParent,
    );

    // The two DEDICATED axes carry the evidence...
    assert_eq!(
        totals.pre_runner_failures.tag_value().as_deref(),
        Some("first_push:1")
    );
    assert_eq!(
        totals.pre_runner_causes.tag_value().as_deref(),
        Some("scope_exceeds_parent:1")
    );
    // ...and the typed status folds into the shared, fingerprint-SAFE http axis.
    assert_eq!(
        totals.runner_error_http.tag_value().as_deref(),
        Some("http_403:1")
    );

    // It must NOT flip any disposition flag (so the exit disposition is unchanged).
    assert!(!totals.saw_error);
    assert!(!totals.saw_alertable_error);
    assert!(!totals.saw_node_too_old);
    assert!(!totals.saw_genuine_crash_fatal);

    // It must NOT write any of the three exit-FINGERPRINT rollups (elements 4/5/6),
    // so they stay at their empty `none`/absent state. This is the review blocker's
    // ground truth, enforced here.
    assert_eq!(totals.runner_error_rollup.fingerprint_token(), "none");
    assert_eq!(totals.runner_error_causes.fingerprint_token(), "none");
    assert_eq!(totals.runner_error_sites.fingerprint_token(), "none");
    assert_eq!(totals.runner_error_rollup.tag_value(), None);
    assert_eq!(totals.runner_error_causes.tag_value(), None);
    assert_eq!(totals.runner_error_sites.tag_value(), None);
}

#[test]
fn record_pre_runner_failure_never_moves_the_exit_fingerprint_inputs() {
    // A run that ALSO saw a genuine runner error, so the three fingerprint tokens
    // are non-trivial — the case where accidental interference would actually
    // regroup an issue.
    let mut base = RunTotals::default();
    base.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message: "AccessDenied code=AccessDenied http=403 denied".to_string(),
    });

    let mut with_pre = base.clone();
    with_pre.record_pre_runner_failure(
        PreRunnerSite::FirstPush,
        Some(403),
        PreRunnerCause::ScopeExceedsParent,
    );

    // The exit fingerprint reads exactly these three tokens (elements 4/5/6). They
    // must be byte-identical with and without pre-runner evidence, so the exit's
    // six-element fingerprint is equal for an otherwise-identical run.
    assert_eq!(
        base.runner_error_rollup.fingerprint_token(),
        with_pre.runner_error_rollup.fingerprint_token()
    );
    assert_eq!(
        base.runner_error_causes.fingerprint_token(),
        with_pre.runner_error_causes.fingerprint_token()
    );
    assert_eq!(
        base.runner_error_sites.fingerprint_token(),
        with_pre.runner_error_sites.fingerprint_token()
    );
    // The disposition flags are equally untouched.
    assert_eq!(base.saw_error, with_pre.saw_error);
    assert_eq!(base.saw_alertable_error, with_pre.saw_alertable_error);
    assert_eq!(base.saw_node_too_old, with_pre.saw_node_too_old);
}

#[test]
fn record_pre_runner_failure_leaves_exit_disposition_unchanged() {
    let base = RunTotals::default();
    let mut with_pre = RunTotals::default();
    with_pre.record_pre_runner_failure(
        PreRunnerSite::FirstPush,
        Some(403),
        PreRunnerCause::ScopeExceedsParent,
    );

    // Drive the full code/signal/cancellation lattice through BOTH the
    // cancellation- and fault-aware classifiers (the fault seam sync.rs actually
    // calls), asserting an identical verdict with and without pre-runner evidence.
    for &code in &[None, Some(0), Some(1), Some(2), Some(17), Some(75)] {
        for &signal in &[None, Some(15), Some(9), Some(11), Some(6)] {
            for &cause in &[
                None,
                Some(SyncCancelCause::UserStop),
                Some(SyncCancelCause::TimeoutWatchdog),
            ] {
                for &effected in &[false, true] {
                    let base_c = classify_runner_exit_disposition_with_cancellation(
                        code,
                        signal,
                        cause,
                        effected,
                        base.saw_error,
                        base.saw_alertable_error,
                        base.saw_node_too_old,
                    );
                    let pre_c = classify_runner_exit_disposition_with_cancellation(
                        code,
                        signal,
                        cause,
                        effected,
                        with_pre.saw_error,
                        with_pre.saw_alertable_error,
                        with_pre.saw_node_too_old,
                    );
                    assert_eq!(
                        base_c, pre_c,
                        "cancellation verdict changed at {code:?}/{signal:?}"
                    );

                    let base_f = classify_runner_exit_disposition_with_fault(
                        code,
                        signal,
                        cause,
                        effected,
                        base.saw_error,
                        base.saw_alertable_error,
                        base.saw_node_too_old,
                        base.saw_genuine_crash_fatal,
                        &base.runner_error_rollup,
                    );
                    let pre_f = classify_runner_exit_disposition_with_fault(
                        code,
                        signal,
                        cause,
                        effected,
                        with_pre.saw_error,
                        with_pre.saw_alertable_error,
                        with_pre.saw_node_too_old,
                        with_pre.saw_genuine_crash_fatal,
                        &with_pre.runner_error_rollup,
                    );
                    assert_eq!(
                        base_f, pre_f,
                        "fault verdict changed at {code:?}/{signal:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn pre_runner_typed_http_status_matches_the_prose_path() {
    // A typed 403 recorded through record_status(from_status(..)) renders the SAME
    // token and count as the prose classifier parsing a `describeError` ` http=403`.
    let mut typed = RunTotals::default();
    typed.record_pre_runner_failure(
        PreRunnerSite::FirstPush,
        Some(403),
        PreRunnerCause::VendHttp,
    );

    let mut prose = RunTotals::default();
    prose.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message: "SomeError code=Foo http=403 denied".to_string(),
    });

    assert_eq!(
        typed.runner_error_http.tag_value(),
        prose.runner_error_http.tag_value()
    );
    assert_eq!(
        typed.runner_error_http.tag_value().as_deref(),
        Some("http_403:1")
    );

    // A None status records nothing on the http axis (absent axis stays absent).
    let mut no_status = RunTotals::default();
    no_status.record_pre_runner_failure(
        PreRunnerSite::FirstPushPersonal,
        None,
        PreRunnerCause::Unknown,
    );
    assert_eq!(no_status.runner_error_http.tag_value(), None);
    assert_eq!(
        no_status.pre_runner_failures.tag_value().as_deref(),
        Some("first_push_personal:1")
    );
    assert_eq!(
        no_status.pre_runner_causes.tag_value().as_deref(),
        Some("unknown:1")
    );
}

#[test]
fn pre_runner_rollups_render_bounded_and_ordered() {
    let mut totals = RunTotals::default();
    // Two first_push failures, one personal — dominant-by-count ordering, `token:count`.
    totals.record_pre_runner_failure(
        PreRunnerSite::FirstPush,
        Some(403),
        PreRunnerCause::ScopeExceedsParent,
    );
    totals.record_pre_runner_failure(
        PreRunnerSite::FirstPush,
        Some(500),
        PreRunnerCause::VendHttp,
    );
    totals.record_pre_runner_failure(
        PreRunnerSite::FirstPushPersonal,
        None,
        PreRunnerCause::Unknown,
    );

    assert_eq!(
        totals.pre_runner_failures.tag_value().as_deref(),
        Some("first_push:2,first_push_personal:1")
    );
    assert_eq!(
        totals.pre_runner_failures.count(PreRunnerSite::FirstPush),
        2
    );
    assert_eq!(
        totals
            .pre_runner_causes
            .count(PreRunnerCause::ScopeExceedsParent),
        1
    );
    // Empty rollups render nothing, so a clean run stays byte-identical.
    assert_eq!(PreRunnerSiteRollup::default().tag_value(), None);
    assert_eq!(PreRunnerCauseRollup::default().tag_value(), None);
}

// ── unknown_unnamed residual instrumentation (HQ-DESKTOP-61/62) ──────────────

#[test]
fn record_error_feeds_residual_axes_only_for_unknown_unnamed() {
    // An UnknownUnnamed residual (leading key=value, unlisted errno) feeds BOTH
    // dedicated residual rollups from the SAME message.
    let mut unnamed = RunTotals::default();
    unnamed.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message: "code=EWEIRD syscall=open unrecognised errno".to_string(),
    });
    assert_eq!(
        unnamed.runner_error_unknown_profiles.tag_value().as_deref(),
        Some("key_value_led:1")
    );
    assert_eq!(
        unnamed
            .runner_error_residual_signature
            .tag_value()
            .as_deref(),
        Some("ea4e65576be5:1")
    );
    // The residual feed did NOT perturb the cause axis: it still reads
    // `unknown_unnamed` and carries no cause-signature — the dead end this closes.
    assert_eq!(
        unnamed.runner_error_causes.tag_value().as_deref(),
        Some("unknown_unnamed:1")
    );
    assert_eq!(unnamed.runner_error_cause_signature.tag_value(), None);

    // A vocabulary-MATCHED cause and an UnknownNamed residual feed NEITHER new axis.
    for message in [
        "AccessDenied code=AccessDenied http=403 denied", // matched cause
        "MysteryFleetError boom on the company leg",      // unknown_NAMED (has identity)
    ] {
        let mut other = RunTotals::default();
        other.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: "(company)".to_string(),
            message: message.to_string(),
        });
        assert_eq!(
            other.runner_error_unknown_profiles.tag_value(),
            None,
            "profile axis must stay empty for {message:?}"
        );
        assert_eq!(
            other.runner_error_residual_signature.tag_value(),
            None,
            "residual signature must stay empty for {message:?}"
        );
    }
}

#[test]
fn residual_evidence_never_moves_the_exit_fingerprint_or_disposition() {
    // A run that saw a genuine UnknownUnnamed runner error, so the residual axes
    // ARE populated and the three fingerprint tokens are non-trivial.
    let mut with_residual = RunTotals::default();
    with_residual.record_error(&SyncErrorEvent {
        company: Some("acme".to_string()),
        path: "(company)".to_string(),
        message: "code=EWEIRD syscall=open unrecognised errno".to_string(),
    });
    assert!(with_residual
        .runner_error_unknown_profiles
        .tag_value()
        .is_some());
    assert!(with_residual
        .runner_error_residual_signature
        .tag_value()
        .is_some());

    // A control identical EXCEPT the residual rollups are cleared. The exit
    // fingerprint (elements 4/5/6) and every disposition flag must be byte-identical
    // to it, proving the residual rollups are neither fingerprint nor disposition
    // inputs — the same invariance the pre-runner axes already satisfy.
    let mut without_residual = with_residual.clone();
    without_residual.runner_error_unknown_profiles = RunnerErrorUnknownProfileRollup::default();
    without_residual.runner_error_residual_signature =
        RunnerErrorResidualSignatureRollup::default();

    assert_eq!(
        with_residual.runner_error_rollup.fingerprint_token(),
        without_residual.runner_error_rollup.fingerprint_token()
    );
    assert_eq!(
        with_residual.runner_error_causes.fingerprint_token(),
        without_residual.runner_error_causes.fingerprint_token()
    );
    assert_eq!(
        with_residual.runner_error_sites.fingerprint_token(),
        without_residual.runner_error_sites.fingerprint_token()
    );
    assert_eq!(with_residual.saw_error, without_residual.saw_error);
    assert_eq!(
        with_residual.saw_alertable_error,
        without_residual.saw_alertable_error
    );
    assert_eq!(
        with_residual.saw_node_too_old,
        without_residual.saw_node_too_old
    );
    assert_eq!(
        with_residual.saw_genuine_crash_fatal,
        without_residual.saw_genuine_crash_fatal
    );

    // Drive the full disposition lattice through BOTH the cancellation- and
    // fault-aware classifiers with and without residual evidence; identical verdict.
    for &code in &[None, Some(0), Some(1), Some(2), Some(17)] {
        for &signal in &[None, Some(15), Some(9), Some(11), Some(6)] {
            for &cause in &[
                None,
                Some(SyncCancelCause::UserStop),
                Some(SyncCancelCause::TimeoutWatchdog),
            ] {
                for &effected in &[false, true] {
                    let base_c = classify_runner_exit_disposition_with_cancellation(
                        code,
                        signal,
                        cause,
                        effected,
                        without_residual.saw_error,
                        without_residual.saw_alertable_error,
                        without_residual.saw_node_too_old,
                    );
                    let res_c = classify_runner_exit_disposition_with_cancellation(
                        code,
                        signal,
                        cause,
                        effected,
                        with_residual.saw_error,
                        with_residual.saw_alertable_error,
                        with_residual.saw_node_too_old,
                    );
                    assert_eq!(
                        base_c, res_c,
                        "cancellation verdict changed at {code:?}/{signal:?}"
                    );

                    let base_f = classify_runner_exit_disposition_with_fault(
                        code,
                        signal,
                        cause,
                        effected,
                        without_residual.saw_error,
                        without_residual.saw_alertable_error,
                        without_residual.saw_node_too_old,
                        without_residual.saw_genuine_crash_fatal,
                        &without_residual.runner_error_rollup,
                    );
                    let res_f = classify_runner_exit_disposition_with_fault(
                        code,
                        signal,
                        cause,
                        effected,
                        with_residual.saw_error,
                        with_residual.saw_alertable_error,
                        with_residual.saw_node_too_old,
                        with_residual.saw_genuine_crash_fatal,
                        &with_residual.runner_error_rollup,
                    );
                    assert_eq!(
                        base_f, res_f,
                        "fault verdict changed at {code:?}/{signal:?}"
                    );
                }
            }
        }
    }
}
