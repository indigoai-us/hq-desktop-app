//! US-008: opt-in model extraction, seen from outside the crate.
//!
//! Two acceptance paths from the PRD:
//!   1. `extraction_mode = local` must never touch the network. Proved with a
//!      real `HttpModelExtractor` aimed at a wiremock server that asserts it
//!      received nothing at all.
//!   2. `extraction_mode = model` with a hanging endpoint must keep the local
//!      result and surface nothing to the user — the stage returns `Ok`.
//!
//! Plus the merge rules through the stage, and the model-path bench that
//! writes `extraction.model` into `apps/sync/e2e/idea-board/bench-results.json`.
//!
//! The bench deliberately fabricates **no** model output: the `/v1/ideas/extract`
//! endpoint is not deployed yet, so live accuracy is unmeasurable. What *is*
//! measurable — the exact request the stage builds, its size, the image it
//! carries, and the resulting token/cost estimate — is measured for real.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{TimeZone, Utc};
use futures_util::future::BoxFuture;
use hq_desktop_core::ideas::{
    create_record, load_record, model_extract_url, run_extraction_stage, run_model_stage,
    save_record, CaptureImage, CaptureKind, CaptureRecord, CaptureStatus, ExtractLine,
    ExtractionMode, ExtractionSource, HttpModelExtractor, LineBox, ModelError, ModelExtraction,
    ModelExtractor, ModelRequest, NewCapture, Provenance, TokenProvider, MODEL_EXTRACT_PATH,
};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::Deserialize;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ----------------------------------------------------------------------------
// Fixture loading (copied from the US-007 suite: integration tests cannot
// import one another).
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct Manifest {
    fixtures: Vec<ManifestEntry>,
}

#[derive(Deserialize)]
struct ManifestEntry {
    path: String,
}

#[derive(Deserialize)]
struct FixtureProvenance {
    app: String,
    window_title: String,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize)]
struct FixtureBox {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Deserialize)]
struct FixtureLine {
    text: String,
    bbox: FixtureBox,
    confidence: f32,
}

#[derive(Deserialize)]
struct FlatColor {
    hex: String,
    fraction: f32,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    expected_kind: CaptureKind,
    provenance: FixtureProvenance,
    lines: Vec<FixtureLine>,
    #[serde(default)]
    flat_colors: Vec<FlatColor>,
}

fn idea_board_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/sync/e2e/idea-board")
}

fn fixtures_dir() -> PathBuf {
    idea_board_dir().join("fixtures")
}

fn load_manifest() -> Manifest {
    let path = fixtures_dir().join("manifest.json");
    let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&raw).unwrap()
}

fn load_fixture(entry: &ManifestEntry) -> Fixture {
    let path = fixtures_dir().join(&entry.path);
    let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn provenance(p: &FixtureProvenance) -> Provenance {
    Provenance {
        app: p.app.clone(),
        window_title: p.window_title.clone(),
        url: p.url.clone(),
        captured_at: Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0).unwrap(),
        display_id: 1,
    }
}

fn to_lines(lines: &[FixtureLine]) -> Vec<ExtractLine> {
    lines
        .iter()
        .map(|l| ExtractLine {
            text: l.text.clone(),
            bbox: LineBox {
                x: l.bbox.x,
                y: l.bbox.y,
                width: l.bbox.width,
                height: l.bbox.height,
            },
            confidence: l.confidence,
        })
        .collect()
}

fn parse_hex(hex: &str) -> Rgba<u8> {
    let digits: Vec<char> = hex.trim_start_matches('#').chars().collect();
    let channel = |i: usize| {
        let s: String = digits[i..i + 2].iter().collect();
        u8::from_str_radix(&s, 16).unwrap()
    };
    Rgba([channel(0), channel(2), channel(4), 255])
}

fn render_flat_png(colors: &[FlatColor]) -> Vec<u8> {
    let width = 200u32;
    let height = 40u32;
    let mut img = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    let mut x0 = 0u32;
    for c in colors {
        let w = ((c.fraction * width as f32).round() as u32).min(width - x0);
        for x in x0..x0 + w {
            for y in 0..height {
                img.put_pixel(x, y, parse_hex(&c.hex));
            }
        }
        x0 += w;
    }
    encode_png(DynamicImage::ImageRgba8(img))
}

fn encode_png(image: DynamicImage) -> Vec<u8> {
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    png
}

fn white_png() -> Vec<u8> {
    encode_png(DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        32,
        32,
        Rgba([255, 255, 255, 255]),
    )))
}

fn pending_record_with_png(root: &Path, png: Vec<u8>, prov: Provenance) -> CaptureRecord {
    create_record(
        root,
        NewCapture::pending("indigo", CaptureImage::Png(png), prov),
    )
    .unwrap()
}

/// A capture that has been through OCR and local extraction — the exact state
/// the model stage is supposed to refine.
async fn locally_extracted(root: &Path, fixture: &Fixture) -> CaptureRecord {
    let png = if fixture.flat_colors.is_empty() {
        white_png()
    } else {
        render_flat_png(&fixture.flat_colors)
    };
    let mut record = pending_record_with_png(root, png, provenance(&fixture.provenance));
    if !fixture.lines.is_empty() {
        record.ocr_text = Some(
            fixture
                .lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        record.status = CaptureStatus::Plain;
        save_record(root, &mut record).unwrap();
    }
    run_extraction_stage(root, "indigo", &record.id, to_lines(&fixture.lines))
        .await
        .unwrap()
}

fn token_provider() -> TokenProvider {
    Arc::new(|| Box::pin(async { Ok("tok".to_string()) }))
}

// ----------------------------------------------------------------------------
// Stub extractors
// ----------------------------------------------------------------------------

/// Returns a fixed verdict and counts every call.
struct CountingStub {
    result: Mutex<Option<Result<ModelExtraction, ModelError>>>,
    calls: Arc<Mutex<usize>>,
}

impl CountingStub {
    fn ok(m: ModelExtraction) -> (Self, Arc<Mutex<usize>>) {
        Self::new(Ok(m))
    }

    fn err(e: ModelError) -> (Self, Arc<Mutex<usize>>) {
        Self::new(Err(e))
    }

    fn new(result: Result<ModelExtraction, ModelError>) -> (Self, Arc<Mutex<usize>>) {
        let calls = Arc::new(Mutex::new(0usize));
        (
            CountingStub {
                result: Mutex::new(Some(result)),
                calls: Arc::clone(&calls),
            },
            calls,
        )
    }
}

impl ModelExtractor for CountingStub {
    fn extract<'a>(
        &'a self,
        _req: &'a ModelRequest,
    ) -> BoxFuture<'a, Result<ModelExtraction, ModelError>> {
        *self.calls.lock().unwrap() += 1;
        let taken = self.result.lock().unwrap().take();
        Box::pin(async move {
            match taken {
                Some(Ok(m)) => Ok(m),
                Some(Err(e)) => Err(e),
                None => Err(ModelError::Network("stub already consumed".into())),
            }
        })
    }
}

/// Records the request the stage built, then fails — so the record is never
/// modified and nothing about the model's *output* is invented.
struct RecordingStub {
    seen: Arc<Mutex<Vec<ModelRequest>>>,
}

impl ModelExtractor for RecordingStub {
    fn extract<'a>(
        &'a self,
        req: &'a ModelRequest,
    ) -> BoxFuture<'a, Result<ModelExtraction, ModelError>> {
        self.seen.lock().unwrap().push(req.clone());
        Box::pin(async { Err(ModelError::Network("bench: no live endpoint".into())) })
    }
}

fn model_extraction(kind: CaptureKind, confidence: f32) -> ModelExtraction {
    ModelExtraction {
        kind,
        confidence,
        extracted: serde_json::json!({ "title": "from the model", "source": "example.com" }),
        tags: vec!["model-tag".to_string()],
        input_tokens: Some(1200),
        output_tokens: Some(260),
        cost_usd: Some(0.0024),
    }
}

fn first_fixture_with_lines() -> Fixture {
    let manifest = load_manifest();
    manifest
        .fixtures
        .iter()
        .map(load_fixture)
        .find(|f| !f.lines.is_empty())
        .expect("at least one fixture with OCR lines")
}

// ----------------------------------------------------------------------------
// e2e #1 — local mode never reaches the network
// ----------------------------------------------------------------------------

#[tokio::test]
async fn hq_idea_board_local_mode_makes_no_request_to_the_model_endpoint() {
    let fixture = first_fixture_with_lines();
    let root = tempfile::tempdir().unwrap();
    let before = locally_extracted(root.path(), &fixture).await;

    let server = MockServer::start().await;
    // `expect(0)` is verified when the server drops; the explicit assertion
    // below fails first with a clearer message.
    Mock::given(method("POST"))
        .and(path(MODEL_EXTRACT_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "kind": "article",
            "confidence": 0.99,
            "extracted": {},
            "tags": []
        })))
        .expect(0)
        .mount(&server)
        .await;

    let extractor = HttpModelExtractor::new(
        reqwest::Client::new(),
        model_extract_url(&server.uri()),
        token_provider(),
    );

    let out = run_model_stage(
        root.path(),
        "indigo",
        &before.id,
        ExtractionMode::Local,
        &extractor,
    )
    .await
    .expect("local mode is never an error");

    assert!(
        server.received_requests().await.unwrap().is_empty(),
        "local mode must not send anything to the model endpoint"
    );
    assert_eq!(
        out, before,
        "local mode must return the stored record untouched"
    );
    assert_eq!(
        load_record(root.path(), "indigo", &before.id).unwrap(),
        before,
        "local mode must not rewrite the record on disk"
    );
    assert_eq!(
        before.extraction_source,
        Some(ExtractionSource::Local),
        "the local stage owns the source"
    );
}

#[tokio::test]
async fn hq_idea_board_local_mode_never_invokes_the_extractor_at_all() {
    let fixture = first_fixture_with_lines();
    let root = tempfile::tempdir().unwrap();
    let before = locally_extracted(root.path(), &fixture).await;

    let (stub, calls) = CountingStub::ok(model_extraction(CaptureKind::Article, 0.99));
    let out = run_model_stage(
        root.path(),
        "indigo",
        &before.id,
        ExtractionMode::Local,
        &stub,
    )
    .await
    .unwrap();

    assert_eq!(*calls.lock().unwrap(), 0, "extractor must not be called");
    assert_eq!(out, before);
}

// ----------------------------------------------------------------------------
// e2e #2 — model mode + a timing-out endpoint keeps the local result silently
// ----------------------------------------------------------------------------

#[tokio::test]
async fn hq_idea_board_model_timeout_keeps_local_extraction_and_shows_no_error() {
    let fixture = first_fixture_with_lines();
    let root = tempfile::tempdir().unwrap();
    let before = locally_extracted(root.path(), &fixture).await;

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(MODEL_EXTRACT_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(600))
                .set_body_json(serde_json::json!({
                    "kind": "quote",
                    "confidence": 0.99,
                    "extracted": {"text": "too late"},
                    "tags": ["late"]
                })),
        )
        .mount(&server)
        .await;

    let extractor = HttpModelExtractor::new(
        reqwest::Client::new(),
        model_extract_url(&server.uri()),
        token_provider(),
    )
    .with_timeout(Duration::from_millis(150));

    let result = run_model_stage(
        root.path(),
        "indigo",
        &before.id,
        ExtractionMode::Model,
        &extractor,
    )
    .await;

    let out = result.expect(
        "a model timeout is background-enrichment failure: the stage must return Ok(record), \
         never an Err the user would be shown",
    );

    // The request really was attempted — this is a timeout, not a skip.
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "model mode must actually call the endpoint"
    );

    assert_eq!(out.kind, before.kind, "kind must survive the timeout");
    assert_eq!(out.status, before.status, "status must survive the timeout");
    assert_eq!(out.confidence, before.confidence);
    assert_eq!(out.extracted, before.extracted);
    assert_eq!(out.tags, before.tags);
    assert_eq!(out.extraction_source, Some(ExtractionSource::Local));
    assert_eq!(out, before, "the whole record must be unchanged");
    assert_eq!(
        load_record(root.path(), "indigo", &before.id).unwrap(),
        before,
        "the on-disk record must be unchanged"
    );
}

// ----------------------------------------------------------------------------
// Merge rules, driven through the stage rather than the pure function
// ----------------------------------------------------------------------------

#[tokio::test]
async fn hq_idea_board_more_confident_model_verdict_replaces_the_local_one() {
    let fixture = first_fixture_with_lines();
    let root = tempfile::tempdir().unwrap();
    let before = locally_extracted(root.path(), &fixture).await;
    let local_confidence = before.confidence.expect("local stage stores a confidence");
    let higher = (local_confidence + 0.05).min(1.0);
    assert!(higher > local_confidence, "test needs headroom above local");

    let (stub, calls) = CountingStub::ok(model_extraction(CaptureKind::Article, higher));
    let out = run_model_stage(
        root.path(),
        "indigo",
        &before.id,
        ExtractionMode::Model,
        &stub,
    )
    .await
    .unwrap();

    assert_eq!(*calls.lock().unwrap(), 1);
    assert_eq!(out.kind, CaptureKind::Article);
    assert_eq!(out.status, CaptureStatus::Extracted);
    assert_eq!(out.extraction_source, Some(ExtractionSource::Model));
    assert_eq!(
        out.extracted.as_ref().unwrap()["title"],
        "from the model",
        "model fields must land on the record"
    );
    assert_eq!(out.tags, vec!["model-tag".to_string()]);
    assert_eq!(load_record(root.path(), "indigo", &before.id).unwrap(), out);
}

#[tokio::test]
async fn hq_idea_board_equal_or_lower_model_confidence_keeps_the_local_verdict() {
    let fixture = first_fixture_with_lines();
    let root = tempfile::tempdir().unwrap();

    for delta in [0.0f32, -0.1] {
        let before = locally_extracted(root.path(), &fixture).await;
        let local_confidence = before.confidence.unwrap();
        let (stub, calls) = CountingStub::ok(model_extraction(
            CaptureKind::Quote,
            (local_confidence + delta).max(0.0),
        ));
        let out = run_model_stage(
            root.path(),
            "indigo",
            &before.id,
            ExtractionMode::Model,
            &stub,
        )
        .await
        .unwrap();

        assert_eq!(*calls.lock().unwrap(), 1, "the model was still consulted");
        assert_eq!(out, before, "delta {delta}: local verdict must survive");
        assert_eq!(out.extraction_source, Some(ExtractionSource::Local));
        assert_eq!(load_record(root.path(), "indigo", &before.id).unwrap(), before);
    }
}

#[tokio::test]
async fn hq_idea_board_model_http_failure_leaves_the_record_alone() {
    let fixture = first_fixture_with_lines();
    let root = tempfile::tempdir().unwrap();
    let before = locally_extracted(root.path(), &fixture).await;

    let (stub, calls) = CountingStub::err(ModelError::Http { status: 500 });
    let out = run_model_stage(
        root.path(),
        "indigo",
        &before.id,
        ExtractionMode::Model,
        &stub,
    )
    .await
    .expect("an http 500 must not surface as an error");

    assert_eq!(*calls.lock().unwrap(), 1);
    assert_eq!(out, before);
    assert_eq!(
        load_record(root.path(), "indigo", &before.id).unwrap(),
        before
    );
}

// ----------------------------------------------------------------------------
// Model-path bench: writes `extraction.model` into bench-results.json
// ----------------------------------------------------------------------------

/// Anthropic vision rule of thumb: an image costs roughly `(w * h) / 750`
/// tokens, and text roughly one token per four characters.
fn estimate_input_tokens(req: &ModelRequest) -> u64 {
    let image = (u64::from(req.image_width) * u64::from(req.image_height)) / 750;
    let text_chars: usize = req.ocr_text.as_deref().unwrap_or("").chars().count()
        + req.schema_hint.chars().count()
        + req.app.chars().count()
        + req.window_title.chars().count()
        + req.url.as_deref().unwrap_or("").chars().count();
    image + text_chars.div_ceil(4) as u64
}

/// Claude Haiku 4.5 list price at the time of the US-008 brainstorm. These are
/// *estimates*: the live endpoint does not exist yet, so no invoice has ever
/// confirmed them. Recorded in the results file as such.
const ESTIMATED_INPUT_USD_PER_MTOK: f64 = 1.0;
const ESTIMATED_OUTPUT_USD_PER_MTOK: f64 = 5.0;
const ASSUMED_OUTPUT_TOKENS: f64 = 300.0;

fn estimate_cost_usd(input_tokens: u64) -> f64 {
    (input_tokens as f64) / 1e6 * ESTIMATED_INPUT_USD_PER_MTOK
        + ASSUMED_OUTPUT_TOKENS / 1e6 * ESTIMATED_OUTPUT_USD_PER_MTOK
}

fn stats(values: &[f64]) -> serde_json::Value {
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    serde_json::json!({ "mean": mean, "min": min, "max": max })
}

#[tokio::test]
async fn hq_idea_board_model_path_bench_writes_extraction_model() {
    let manifest = load_manifest();
    let root = tempfile::tempdir().unwrap();
    let seen: Arc<Mutex<Vec<ModelRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let stub = RecordingStub {
        seen: Arc::clone(&seen),
    };

    let mut local_correct = 0usize;
    let mut local_confident_wrong = 0usize;

    for entry in &manifest.fixtures {
        let fixture = load_fixture(entry);
        let before = locally_extracted(root.path(), &fixture).await;

        if before.kind == fixture.expected_kind {
            local_correct += 1;
        } else if before.status == CaptureStatus::Extracted {
            local_confident_wrong += 1;
        }

        let after = run_model_stage(
            root.path(),
            "indigo",
            &before.id,
            ExtractionMode::Model,
            &stub,
        )
        .await
        .expect("a failing extractor must not error the stage");
        assert_eq!(
            after, before,
            "{}: a failed model call must leave the record untouched",
            fixture.name
        );
        assert_eq!(
            load_record(root.path(), "indigo", &before.id).unwrap(),
            before,
            "{}: on-disk record must be untouched",
            fixture.name
        );

        let requests = seen.lock().unwrap();
        let req = requests.last().expect("the stage built a request");
        assert!(
            !req.image_png_base64.is_empty(),
            "{}: request must carry the image",
            fixture.name
        );
        assert!(
            req.image_width > 0 && req.image_height > 0,
            "{}: image dimensions must be known",
            fixture.name
        );
        if fixture.lines.is_empty() {
            assert!(req.ocr_text.is_none(), "{}: no lines, no ocr", fixture.name);
        } else {
            let ocr = req
                .ocr_text
                .as_deref()
                .unwrap_or_else(|| panic!("{}: ocr_text must be forwarded", fixture.name));
            assert!(!ocr.trim().is_empty(), "{}: ocr must not be blank", fixture.name);
        }
        assert_eq!(
            req.local_kind, before.kind,
            "{}: local kind must be forwarded",
            fixture.name
        );
        assert_eq!(
            req.local_confidence,
            before.confidence.unwrap_or(0.0),
            "{}: local confidence must be forwarded",
            fixture.name
        );
        assert_eq!(req.app, fixture.provenance.app, "{}", fixture.name);
        assert!(
            req.schema_hint.contains("x_post"),
            "{}: schema hint must travel with the request",
            fixture.name
        );
    }

    let requests = seen.lock().unwrap();
    let total = manifest.fixtures.len();
    assert_eq!(
        requests.len(),
        total,
        "model mode must send exactly one request per capture"
    );

    let mut bytes: Vec<f64> = Vec::new();
    let mut tokens: Vec<f64> = Vec::new();
    let mut costs: Vec<f64> = Vec::new();
    for req in requests.iter() {
        bytes.push(serde_json::to_vec(req).unwrap().len() as f64);
        let t = estimate_input_tokens(req);
        tokens.push(t as f64);
        let cost = estimate_cost_usd(t);
        assert!(cost > 0.0, "estimated per-capture cost must be positive");
        assert!(
            cost < 0.05,
            "estimated per-capture cost {cost} is implausibly high"
        );
        costs.push(cost);
    }

    let local_accuracy = local_correct as f64 / total as f64;
    let section = serde_json::json!({
        "measuredAt": Utc::now().to_rfc3339(),
        "live": false,
        "endpoint": MODEL_EXTRACT_PATH,
        "fixtures": total,
        "requests_sent_to_mock": requests.len(),
        "kind_accuracy": serde_json::Value::Null,
        "confident_wrong": serde_json::Value::Null,
        "accuracy_note": "live accuracy requires the hq-pro /v1/ideas/extract endpoint; not yet \
deployed — mechanics measured with a recording extractor, zero fabricated model outputs",
        "per_capture_cost_usd_estimate": stats(&costs),
        "estimated_input_tokens": stats(&tokens),
        "request_bytes": stats(&bytes),
        "pricing_source": "estimate — verify live",
        "pricing_assumptions": {
            "input_usd_per_mtok": ESTIMATED_INPUT_USD_PER_MTOK,
            "output_usd_per_mtok": ESTIMATED_OUTPUT_USD_PER_MTOK,
            "assumed_output_tokens": ASSUMED_OUTPUT_TOKENS,
            "image_tokens_formula": "(width * height) / 750",
        },
        "local_baseline": {
            "kind_accuracy": local_accuracy,
            "confident_wrong": local_confident_wrong,
        },
    });

    let out_path = idea_board_dir().join("bench-results.json");
    let mut doc: serde_json::Value = std::fs::read(&out_path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    let obj = doc.as_object_mut().expect("results file is an object");
    let extraction = obj
        .entry("extraction")
        .or_insert_with(|| serde_json::json!({}));
    if !extraction.is_object() {
        *extraction = serde_json::json!({});
    }
    extraction
        .as_object_mut()
        .unwrap()
        .insert("model".to_string(), section);

    std::fs::write(
        &out_path,
        format!("{}\n", serde_json::to_string_pretty(&doc).unwrap()),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", out_path.display()));

    eprintln!(
        "MEASURED model-path bench: fixtures={total} mean_cost_usd={:.6} mean_tokens={:.0} \
mean_request_bytes={:.0} local_kind_accuracy={local_accuracy:.3}",
        costs.iter().sum::<f64>() / total as f64,
        tokens.iter().sum::<f64>() / total as f64,
        bytes.iter().sum::<f64>() / total as f64,
    );

    // The file we just wrote must still parse and still hold the latency keys.
    let reread: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&out_path).unwrap()).unwrap();
    assert_eq!(reread["extraction"]["model"]["fixtures"], total);
    assert_eq!(reread["extraction"]["model"]["live"], false);
    assert!(
        reread.get("chordToOverlay").is_some(),
        "the latency section must survive the extraction write"
    );
}
