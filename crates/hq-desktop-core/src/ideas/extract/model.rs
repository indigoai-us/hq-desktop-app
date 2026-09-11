//! Opt-in model extraction (US-008): a *refinement* of the US-007 local
//! result, run only when the user has switched `ideas.extraction_mode` to
//! `model`.
//!
//! Design rules honoured:
//! - **Opt-in, default off.** [`ExtractionMode::Local`] is the default and
//!   anything we cannot parse falls back to it ([`parse_mode`]). This is a
//!   user *preference*, not a feature flag (policy
//!   `indigo-a-user-preference-is-not-a-feature-flag`).
//! - **Stated plainly.** [`MODEL_DISCLOSURE`] is the settings copy: the image
//!   leaves the device and each capture costs money.
//! - **Never worse than local.** A model verdict replaces the local one only
//!   when it is *strictly* more confident ([`merge_verdict`]).
//! - **Background enrichment never shouts.** Every failure is a log line; the
//!   caller keeps the local result.
//! - **Never log the payload.** Neither the image, the OCR text, nor the
//!   extracted fields are logged at any level.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

use super::{Extraction, MAX_TAGS};
use crate::ideas::record::CaptureKind;

/// Settings key backing the extraction mode.
pub const EXTRACTION_MODE_SETTING: &str = "ideas.extraction_mode";

/// Per-request budget for a model extraction call.
pub const DEFAULT_MODEL_TIMEOUT: Duration = Duration::from_secs(10);

/// Path on the HQ API that performs the vision extraction.
pub const MODEL_EXTRACT_PATH: &str = "/v1/ideas/extract";

/// User-facing settings copy. States the two things that actually matter to
/// someone deciding: the picture leaves this machine, and it costs money.
pub const MODEL_DISCLOSURE: &str = "Model extraction sends each capture's image \
and its recognized text to a vision model through HQ. The image leaves this \
device, and every capture processed this way adds a small per-capture cost to \
your account. Leave this off to keep extraction entirely on this device.";

/// The JSON shape requested of the model. Sent with every request so the
/// contract lives in exactly one place.
pub const SCHEMA_HINT: &str = concat!(
    "Reply with ONLY a JSON object: ",
    r#"{"kind":"x_post|article|image|quote|product|color|unknown",""#,
    r#"confidence":0.0-1.0,"extracted":{},"tags":["lowercase"]}. "#,
    "extracted matches kind: ",
    r#"x_post {author, handle, body}; article {title, source}; "#,
    r##"product {name, source}; quote {text}; color {palette:["#rrggbb"]}; "##,
    "otherwise {}."
);

/// How a capture is extracted. `Local` is the default and the fallback for
/// every unrecognized value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionMode {
    #[default]
    Local,
    Model,
}

impl ExtractionMode {
    /// The on-disk / on-the-wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ExtractionMode::Local => "local",
            ExtractionMode::Model => "model",
        }
    }
}

impl FromStr for ExtractionMode {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(parse_mode(s))
    }
}

/// Map a stored setting value onto a mode.
///
/// Only a trimmed, case-insensitive `"model"` opts in. Everything else —
/// absent, empty, `"local"`, or garbage — is [`ExtractionMode::Local`], so a
/// corrupt preferences file can never silently start shipping images.
pub fn parse_mode(value: &str) -> ExtractionMode {
    if value.trim().eq_ignore_ascii_case("model") {
        ExtractionMode::Model
    } else {
        ExtractionMode::Local
    }
}

/// What we send the model: the (already downsampled) capture image, the local
/// OCR text, the provenance, and what local extraction concluded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelRequest {
    pub image_png_base64: String,
    pub image_width: u32,
    pub image_height: u32,
    pub ocr_text: Option<String>,
    pub app: String,
    pub window_title: String,
    pub url: Option<String>,
    pub local_kind: CaptureKind,
    pub local_confidence: f32,
    pub schema_hint: String,
}

/// What the model replied with. Token/cost fields are optional telemetry the
/// server may attach; they are never required for the result to be usable.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelExtraction {
    pub kind: CaptureKind,
    pub confidence: f32,
    #[serde(default)]
    pub extracted: serde_json::Value,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

impl From<ModelExtraction> for Extraction {
    fn from(m: ModelExtraction) -> Self {
        let confidence = if m.confidence.is_nan() {
            0.0
        } else {
            m.confidence.clamp(0.0, 1.0)
        };
        let extracted = if m.extracted.is_object() {
            m.extracted
        } else {
            serde_json::json!({})
        };
        let tags = m
            .tags
            .into_iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .take(MAX_TAGS)
            .collect();
        Extraction {
            kind: m.kind,
            confidence,
            extracted,
            tags,
        }
    }
}

/// Why a model extraction did not produce a verdict. Never contains the
/// request payload.
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("model extraction timed out")]
    Timeout,
    #[error("model extraction returned http {status}")]
    Http { status: u16 },
    #[error("model extraction network error: {0}")]
    Network(String),
    #[error("model extraction returned a malformed response: {0}")]
    Malformed(String),
}

/// The injection seam: production uses [`HttpModelExtractor`], tests a stub.
pub trait ModelExtractor: Send + Sync {
    fn extract<'a>(
        &'a self,
        req: &'a ModelRequest,
    ) -> BoxFuture<'a, Result<ModelExtraction, ModelError>>;
}

/// Supplies a fresh bearer token per call (the app wires this to Cognito).
pub type TokenProvider = Arc<dyn Fn() -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

/// Build the extraction endpoint from the vault API base.
pub fn model_extract_url(vault_base: &str) -> String {
    format!(
        "{}{}",
        vault_base.trim().trim_end_matches('/'),
        MODEL_EXTRACT_PATH
    )
}

/// Authenticated HTTP extractor: the app's existing HQ API path, never a bare
/// fetch. The bearer is fetched per request and never logged.
pub struct HttpModelExtractor {
    client: reqwest::Client,
    endpoint: String,
    token: TokenProvider,
    timeout: Duration,
}

impl HttpModelExtractor {
    pub fn new(client: reqwest::Client, endpoint: impl Into<String>, token: TokenProvider) -> Self {
        HttpModelExtractor {
            client,
            endpoint: endpoint.into(),
            token,
            timeout: DEFAULT_MODEL_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl ModelExtractor for HttpModelExtractor {
    fn extract<'a>(
        &'a self,
        req: &'a ModelRequest,
    ) -> BoxFuture<'a, Result<ModelExtraction, ModelError>> {
        Box::pin(async move {
            let token = (self.token)()
                .await
                .map_err(|e| ModelError::Network(format!("auth unavailable: {e}")))?;
            let response = self
                .client
                .post(&self.endpoint)
                .timeout(self.timeout)
                .header("authorization", format!("Bearer {token}"))
                .header("accept", "application/json")
                .json(req)
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        ModelError::Timeout
                    } else {
                        ModelError::Network(e.to_string())
                    }
                })?;
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                return Err(ModelError::Http { status });
            }
            response
                .json::<ModelExtraction>()
                .await
                .map_err(|e| ModelError::Malformed(e.to_string()))
        })
    }
}

/// Should the model verdict replace the local one?
///
/// Strictly greater: a tie keeps the local result, which is free, private, and
/// already on the record. A NaN model confidence never wins.
pub fn merge_verdict(local_confidence: Option<f32>, model: &Extraction) -> bool {
    if model.confidence.is_nan() {
        return false;
    }
    let local = local_confidence.filter(|c| !c.is_nan()).unwrap_or(0.0);
    model.confidence > local
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn token_provider(token: &'static str) -> TokenProvider {
        Arc::new(move || Box::pin(async move { Ok(token.to_string()) }))
    }

    fn request() -> ModelRequest {
        ModelRequest {
            image_png_base64: "aGk=".to_string(),
            image_width: 10,
            image_height: 20,
            ocr_text: Some("hello".to_string()),
            app: "Safari".to_string(),
            window_title: "X".to_string(),
            url: None,
            local_kind: CaptureKind::Unknown,
            local_confidence: 0.2,
            schema_hint: SCHEMA_HINT.to_string(),
        }
    }

    #[test]
    fn hq_idea_board_parse_mode_defaults_to_local() {
        assert_eq!(parse_mode(""), ExtractionMode::Local);
        assert_eq!(parse_mode("local"), ExtractionMode::Local);
        assert_eq!(parse_mode("LOCAL"), ExtractionMode::Local);
        assert_eq!(parse_mode("modell"), ExtractionMode::Local);
        assert_eq!(parse_mode("¯\\_(ツ)_/¯"), ExtractionMode::Local);
        assert_eq!(ExtractionMode::default(), ExtractionMode::Local);
    }

    #[test]
    fn hq_idea_board_parse_mode_opts_in_only_on_model() {
        assert_eq!(parse_mode("model"), ExtractionMode::Model);
        assert_eq!(parse_mode(" Model "), ExtractionMode::Model);
        assert_eq!(
            "model".parse::<ExtractionMode>().unwrap(),
            ExtractionMode::Model
        );
        assert_eq!(ExtractionMode::Model.as_str(), "model");
        assert_eq!(ExtractionMode::Local.as_str(), "local");
    }

    #[test]
    fn hq_idea_board_disclosure_states_cost_and_egress() {
        let copy = MODEL_DISCLOSURE.to_lowercase();
        assert!(copy.contains("leaves this device"), "{MODEL_DISCLOSURE}");
        assert!(copy.contains("cost"), "{MODEL_DISCLOSURE}");
        assert!(copy.contains("vision model"), "{MODEL_DISCLOSURE}");
    }

    fn ex(confidence: f32) -> Extraction {
        Extraction {
            kind: CaptureKind::Article,
            confidence,
            extracted: serde_json::json!({}),
            tags: Vec::new(),
        }
    }

    #[test]
    fn hq_idea_board_merge_verdict_is_strictly_greater() {
        assert!(merge_verdict(Some(0.4), &ex(0.5)));
        assert!(!merge_verdict(Some(0.5), &ex(0.5)));
        assert!(!merge_verdict(Some(0.6), &ex(0.5)));
        // No local confidence at all: anything above zero wins.
        assert!(merge_verdict(None, &ex(0.01)));
        assert!(!merge_verdict(None, &ex(0.0)));
        // A NaN model verdict never wins; a NaN local reading is ignored.
        assert!(!merge_verdict(Some(0.1), &ex(f32::NAN)));
        assert!(merge_verdict(Some(f32::NAN), &ex(0.1)));
    }

    #[test]
    fn hq_idea_board_model_extraction_converts_and_clamps() {
        let m = ModelExtraction {
            kind: CaptureKind::Quote,
            confidence: 4.2,
            extracted: serde_json::json!(["not", "an", "object"]),
            tags: vec![
                "  Design ".into(),
                "AI".into(),
                "".into(),
                "c".into(),
                "d".into(),
                "e".into(),
                "f".into(),
                "g".into(),
            ],
            input_tokens: Some(10),
            output_tokens: None,
            cost_usd: Some(0.004),
        };
        let e: Extraction = m.into();
        assert_eq!(e.kind, CaptureKind::Quote);
        assert_eq!(e.confidence, 1.0);
        assert_eq!(e.extracted, serde_json::json!({}));
        assert_eq!(e.tags.len(), MAX_TAGS);
        assert_eq!(e.tags[0], "design");
        assert_eq!(e.tags[1], "ai");

        let nan = ModelExtraction {
            kind: CaptureKind::Unknown,
            confidence: f32::NAN,
            extracted: serde_json::json!({"a": 1}),
            tags: Vec::new(),
            input_tokens: None,
            output_tokens: None,
            cost_usd: None,
        };
        let e: Extraction = nan.into();
        assert_eq!(e.confidence, 0.0);
        assert_eq!(e.extracted, serde_json::json!({"a": 1}));

        let low: Extraction = ModelExtraction {
            kind: CaptureKind::Image,
            confidence: -3.0,
            extracted: serde_json::Value::Null,
            tags: Vec::new(),
            input_tokens: None,
            output_tokens: None,
            cost_usd: None,
        }
        .into();
        assert_eq!(low.confidence, 0.0);
    }

    #[test]
    fn hq_idea_board_model_extract_url_normalizes_base() {
        assert_eq!(
            model_extract_url("https://hqapi.hq.computer"),
            "https://hqapi.hq.computer/v1/ideas/extract"
        );
        assert_eq!(
            model_extract_url("  https://hqapi.hq.computer///  "),
            "https://hqapi.hq.computer/v1/ideas/extract"
        );
    }

    #[tokio::test]
    async fn hq_idea_board_http_extractor_sends_bearer_and_parses_result() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(MODEL_EXTRACT_PATH))
            .and(header("authorization", "Bearer tok-123"))
            .and(header("accept", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "kind": "article",
                "confidence": 0.9,
                "extracted": { "title": "T", "source": "example.com" },
                "tags": ["news"]
            })))
            .mount(&server)
            .await;

        let extractor = HttpModelExtractor::new(
            reqwest::Client::new(),
            model_extract_url(&server.uri()),
            token_provider("tok-123"),
        );
        let out = extractor.extract(&request()).await.expect("200 parses");
        assert_eq!(out.kind, CaptureKind::Article);
        assert!((out.confidence - 0.9).abs() < 1e-6);
        assert_eq!(out.tags, vec!["news".to_string()]);

        // The body actually carried the image + local verdict.
        let received = &server.received_requests().await.unwrap()[0];
        let body: serde_json::Value = serde_json::from_slice(&received.body).unwrap();
        assert_eq!(body["image_png_base64"], "aGk=");
        assert_eq!(body["local_kind"], "unknown");
        assert!(body["schema_hint"].as_str().unwrap().contains("x_post"));
    }

    #[tokio::test]
    async fn hq_idea_board_http_extractor_times_out() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)))
            .mount(&server)
            .await;

        let extractor = HttpModelExtractor::new(
            reqwest::Client::new(),
            model_extract_url(&server.uri()),
            token_provider("tok"),
        )
        .with_timeout(Duration::from_millis(200));
        let err = extractor.extract(&request()).await.unwrap_err();
        assert!(matches!(err, ModelError::Timeout), "got {err:?}");
    }

    #[tokio::test]
    async fn hq_idea_board_http_extractor_maps_status_and_garbage() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/boom"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/garbage"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;

        let boom = HttpModelExtractor::new(
            reqwest::Client::new(),
            format!("{}/boom", server.uri()),
            token_provider("tok"),
        );
        assert!(
            matches!(
                boom.extract(&request()).await.unwrap_err(),
                ModelError::Http { status: 500 }
            ),
            "500 should map to Http"
        );

        let garbage = HttpModelExtractor::new(
            reqwest::Client::new(),
            format!("{}/garbage", server.uri()),
            token_provider("tok"),
        );
        assert!(matches!(
            garbage.extract(&request()).await.unwrap_err(),
            ModelError::Malformed(_)
        ));
    }

    #[tokio::test]
    async fn hq_idea_board_http_extractor_reports_auth_failure_as_network() {
        let provider: TokenProvider =
            Arc::new(|| Box::pin(async { Err("not signed in".to_string()) }));
        let extractor = HttpModelExtractor::new(
            reqwest::Client::new(),
            "https://example.invalid/x",
            provider,
        );
        let err = extractor.extract(&request()).await.unwrap_err();
        assert!(matches!(err, ModelError::Network(ref m) if m.contains("auth unavailable")));
    }
}
