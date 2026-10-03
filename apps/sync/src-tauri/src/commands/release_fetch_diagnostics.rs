// Pure diagnostic vocabulary shared with the release lookup. Kept independent of Tauri so
// its closed field contract can be checked on hosts without a WebKit development kit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ReleaseFetchOutcome {
    ClientBuild,
    Transport,
    HttpStatus,
    JsonParse,
    EmptyTag,
    Ok,
    #[default]
    NotAttempted,
}

impl ReleaseFetchOutcome {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::ClientBuild => "client_build",
            Self::Transport => "transport",
            Self::HttpStatus => "http_status",
            Self::JsonParse => "json_parse",
            Self::EmptyTag => "empty_tag",
            Self::Ok => "ok",
            Self::NotAttempted => "not_attempted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReleaseFetchTransportClass {
    Timeout,
    Connect,
    Request,
    Body,
    Decode,
    Redirect,
    Other,
}

impl ReleaseFetchTransportClass {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Request => "request",
            Self::Body => "body",
            Self::Decode => "decode",
            Self::Redirect => "redirect",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReleaseFetchDiagnostics {
    pub(crate) outcome: ReleaseFetchOutcome,
    pub(crate) transport_class: Option<ReleaseFetchTransportClass>,
    pub(crate) http_status: Option<u16>,
    pub(crate) rate_limit_header_present: Option<bool>,
}

impl ReleaseFetchDiagnostics {
    pub(crate) const fn client_build() -> Self {
        Self {
            outcome: ReleaseFetchOutcome::ClientBuild,
            transport_class: None,
            http_status: None,
            rate_limit_header_present: None,
        }
    }

    pub(crate) const fn transport(class: ReleaseFetchTransportClass) -> Self {
        Self {
            outcome: ReleaseFetchOutcome::Transport,
            transport_class: Some(class),
            http_status: None,
            rate_limit_header_present: None,
        }
    }

    pub(crate) const fn http_status(status: u16, rate_limit_header_present: bool) -> Self {
        Self {
            outcome: ReleaseFetchOutcome::HttpStatus,
            transport_class: None,
            http_status: Some(status),
            rate_limit_header_present: Some(rate_limit_header_present),
        }
    }

    pub(crate) const fn json_parse() -> Self {
        Self {
            outcome: ReleaseFetchOutcome::JsonParse,
            transport_class: None,
            http_status: None,
            rate_limit_header_present: None,
        }
    }

    pub(crate) const fn empty_tag() -> Self {
        Self {
            outcome: ReleaseFetchOutcome::EmptyTag,
            transport_class: None,
            http_status: None,
            rate_limit_header_present: None,
        }
    }

    pub(crate) const fn ok() -> Self {
        Self {
            outcome: ReleaseFetchOutcome::Ok,
            transport_class: None,
            http_status: None,
            rate_limit_header_present: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_fetch_outcome_and_transport_labels_are_closed() {
        assert_eq!(
            [
                ReleaseFetchOutcome::ClientBuild.label(),
                ReleaseFetchOutcome::Transport.label(),
                ReleaseFetchOutcome::HttpStatus.label(),
                ReleaseFetchOutcome::JsonParse.label(),
                ReleaseFetchOutcome::EmptyTag.label(),
                ReleaseFetchOutcome::Ok.label(),
                ReleaseFetchOutcome::NotAttempted.label(),
            ],
            [
                "client_build",
                "transport",
                "http_status",
                "json_parse",
                "empty_tag",
                "ok",
                "not_attempted",
            ]
        );
        assert_eq!(
            [
                ReleaseFetchTransportClass::Timeout.label(),
                ReleaseFetchTransportClass::Connect.label(),
                ReleaseFetchTransportClass::Request.label(),
                ReleaseFetchTransportClass::Body.label(),
                ReleaseFetchTransportClass::Decode.label(),
                ReleaseFetchTransportClass::Redirect.label(),
                ReleaseFetchTransportClass::Other.label(),
            ],
            ["timeout", "connect", "request", "body", "decode", "redirect", "other"]
        );
    }

    #[test]
    fn release_fetch_status_records_only_numeric_status_and_header_presence() {
        let diagnostics = ReleaseFetchDiagnostics::http_status(403, true);
        assert_eq!(diagnostics.outcome.label(), "http_status");
        assert_eq!(diagnostics.http_status, Some(403));
        assert_eq!(diagnostics.rate_limit_header_present, Some(true));
        assert_eq!(diagnostics.transport_class, None);
    }

    #[test]
    fn default_release_fetch_is_marked_not_attempted() {
        assert_eq!(
            ReleaseFetchDiagnostics::default().outcome.label(),
            "not_attempted"
        );
    }

    #[test]
    fn release_fetch_constructors_keep_fields_scoped_to_their_outcome() {
        assert_eq!(
            ReleaseFetchDiagnostics::client_build().outcome.label(),
            "client_build"
        );
        let transport = ReleaseFetchDiagnostics::transport(ReleaseFetchTransportClass::Timeout);
        assert_eq!(transport.outcome.label(), "transport");
        assert_eq!(
            transport
                .transport_class
                .map(ReleaseFetchTransportClass::label),
            Some("timeout")
        );
        assert_eq!(
            ReleaseFetchDiagnostics::json_parse().outcome.label(),
            "json_parse"
        );
        assert_eq!(
            ReleaseFetchDiagnostics::empty_tag().outcome.label(),
            "empty_tag"
        );
        assert_eq!(ReleaseFetchDiagnostics::ok().outcome.label(), "ok");
    }
}
