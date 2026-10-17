//! signals-local-meetings-v1 US-007 — the only tools the extraction model may call.
//!
//! `ontology.list`, `ontology.inspect`, and `ontology.search_alias` follow the
//! hq-pro US-004 contract in `src/ontology/member-projection-index.ts`: same
//! argument names, limits (list ≤ 100, search ≤ 20, query ≤ 200 chars), entity
//! id pattern, unknown-argument rejection, and status semantics (`missing`,
//! `stale`, `disabled` return empty results with `provisionalCandidates: true`).
//! They read the member's pulled projection (`manifest.json` + `entities.jsonl`
//! from `ontology/projections/members/{memberUid}/v1/`) held in memory.
//!
//! `queue_entity_candidate` records a minimal provisional candidate in the
//! personal store. Nothing here reads or writes `ontology/entities/**`.
//!
//! Every call goes through [`ToolHost::call`], which keeps the same-run ledger
//! of entity ids the model has actually seen and candidates it has queued.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use super::store::{company_root, valid_segment, write_atomic};

pub const PROJECTION_SCHEMA: &str = "hq-member-identity-projection.v1";
pub const LIST_MAX_LIMIT: usize = 100;
pub const LIST_DEFAULT_LIMIT: usize = 50;
pub const SEARCH_MAX_LIMIT: usize = 20;
pub const SEARCH_DEFAULT_LIMIT: usize = 10;
pub const MAX_QUERY_CHARS: usize = 200;
/// hq-pro MEMBER_PROJECTION_MAX_AGE_MS * 2.
pub const STALE_AFTER_MS: i64 = 2 * 15 * 60 * 1000;
pub const MAX_CANDIDATES_PER_RUN: usize = 256;

pub const TOOL_NAMES: [&str; 4] = [
    "ontology.list",
    "ontology.inspect",
    "ontology.search_alias",
    "queue_entity_candidate",
];

pub const ENTITY_TYPES: [&str; 9] = [
    "person", "company", "project", "concept", "product", "tool", "platform", "contact", "other",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEntity {
    pub entity_id: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    pub canonical_name: String,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: String,
    company_uid: String,
    member_uid: String,
    generated_at: String,
    watermark: Option<String>,
    state: String,
    digest: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionState {
    Ready,
    Stale,
    Disabled,
    Missing,
}

impl ProjectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectionState::Ready => "ready",
            ProjectionState::Stale => "stale",
            ProjectionState::Disabled => "disabled",
            ProjectionState::Missing => "missing",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionStatus {
    pub state: ProjectionState,
    pub watermark: Option<String>,
    pub provisional_candidates: bool,
}

/// The member's pulled projection, or `None` entities when it is missing.
#[derive(Clone, Debug)]
pub struct Projection {
    state: ProjectionState,
    watermark: Option<String>,
    generated_at_ms: Option<i64>,
    entities: BTreeMap<String, ProjectedEntity>,
}

pub fn valid_entity_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

fn fold_latin(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'ç' | 'ć' | 'č' => "c",
        'ď' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' => "i",
        'ñ' | 'ń' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
        'ř' => "r",
        'ś' | 'š' | 'ş' => "s",
        'ť' => "t",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => "u",
        'ý' | 'ÿ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        'ß' => "ss",
        'æ' => "ae",
        'œ' => "oe",
        _ => return None,
    })
}

/// Port of hq-pro `normalizeName`: lowercase, strip diacritics, punctuation to
/// spaces, collapse whitespace. Diacritic folding covers combining marks and
/// precomposed Latin letters (no Unicode normalization crate is linked).
pub fn normalize_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        if ('\u{0300}'..='\u{036f}').contains(&c) {
            continue;
        }
        if let Some(f) = fold_latin(c) {
            out.push_str(f);
        } else if c.is_alphanumeric() {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

impl Projection {
    pub fn missing() -> Self {
        Projection {
            state: ProjectionState::Missing,
            watermark: None,
            generated_at_ms: None,
            entities: BTreeMap::new(),
        }
    }

    /// Load a pulled projection for exactly this company and member. Anything
    /// unreadable, mismatched, or tampered loads as `missing`.
    pub fn load(dir: &Path, company_uid: &str, member_uid: &str) -> Self {
        Self::from_pulled(
            std::fs::read_to_string(dir.join("manifest.json"))
                .ok()
                .as_deref(),
            std::fs::read_to_string(dir.join("entities.jsonl"))
                .ok()
                .as_deref(),
            company_uid,
            member_uid,
        )
    }

    pub fn from_pulled(
        manifest: Option<&str>,
        entities: Option<&str>,
        company_uid: &str,
        member_uid: &str,
    ) -> Self {
        let (Some(manifest), Some(body)) = (manifest, entities) else {
            return Self::missing();
        };
        let Ok(m) = serde_json::from_str::<Manifest>(manifest) else {
            return Self::missing();
        };
        if m.schema_version != PROJECTION_SCHEMA
            || m.company_uid != company_uid
            || m.member_uid != member_uid
        {
            return Self::missing();
        }
        let digest: String = Sha256::digest(body.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest != m.digest {
            return Self::missing();
        }
        let state = match m.state.as_str() {
            "ready" => ProjectionState::Ready,
            "stale" => ProjectionState::Stale,
            "disabled" => ProjectionState::Disabled,
            _ => return Self::missing(),
        };
        let mut entities = BTreeMap::new();
        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let (Some(id), Some(name)) = (v["entityId"].as_str(), v["canonicalName"].as_str())
            else {
                continue;
            };
            if !valid_entity_id(id) || name.trim().is_empty() {
                continue;
            }
            let t = v["type"]
                .as_str()
                .filter(|t| ENTITY_TYPES.contains(t))
                .unwrap_or("other");
            let aliases = v["aliases"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            entities.insert(
                id.to_string(),
                ProjectedEntity {
                    entity_id: id.into(),
                    entity_type: t.into(),
                    canonical_name: name.into(),
                    aliases,
                },
            );
        }
        Projection {
            state,
            watermark: m.watermark,
            generated_at_ms: parse_ms(&m.generated_at),
            entities,
        }
    }

    pub fn status(&self, now_ms: i64) -> ProjectionStatus {
        let mut state = self.state;
        if state == ProjectionState::Ready
            && self
                .generated_at_ms
                .is_none_or(|g| now_ms - g > STALE_AFTER_MS)
        {
            state = ProjectionState::Stale;
        }
        ProjectionStatus {
            state,
            watermark: self.watermark.clone(),
            provisional_candidates: state != ProjectionState::Ready,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityCandidate {
    pub candidate_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    pub job_id: String,
    pub source_ref: String,
}

/// Same-run evidence: what the model looked up and what it queued.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolLedger {
    pub seen_entity_ids: BTreeSet<String>,
    pub candidates: BTreeMap<String, EntityCandidate>,
    pub calls: u32,
}

pub struct ToolHost {
    projection: Projection,
    now_ms: i64,
    job_id: String,
    source_ref: String,
    candidates_path: PathBuf,
    pub ledger: ToolLedger,
}

#[derive(Debug, PartialEq)]
pub enum ToolError {
    /// Not one of the four registered tools.
    UnknownTool(String),
    InvalidInput(String),
    Storage(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::UnknownTool(t) => write!(f, "tool not available: {t}"),
            ToolError::InvalidInput(m) => write!(f, "invalid input: {m}"),
            ToolError::Storage(m) => write!(f, "storage: {m}"),
        }
    }
}

fn args(v: &Value, allowed: &[&str]) -> Result<Map<String, Value>, ToolError> {
    let m = match v {
        Value::Null => Map::new(),
        Value::Object(m) => m.clone(),
        _ => {
            return Err(ToolError::InvalidInput(
                "arguments must be an object".into(),
            ))
        }
    };
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(ToolError::InvalidInput(format!(
                "unsupported argument: {k}"
            )));
        }
    }
    Ok(m)
}

fn limit(v: Option<&Value>, def: usize, max: usize) -> Result<usize, ToolError> {
    match v {
        None | Some(Value::Null) => Ok(def),
        Some(x) => match x.as_u64() {
            Some(n) if n >= 1 => Ok((n as usize).min(max)),
            _ => Err(ToolError::InvalidInput(
                "limit must be a positive integer".into(),
            )),
        },
    }
}

fn entity_type(v: Option<&Value>) -> Result<Option<String>, ToolError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(t)) if ENTITY_TYPES.contains(&t.as_str()) => Ok(Some(t.clone())),
        _ => Err(ToolError::InvalidInput("unknown entity type".into())),
    }
}

impl ToolHost {
    pub fn new(
        hq_root: &Path,
        company_uid: &str,
        job_id: &str,
        source_ref: &str,
        projection: Projection,
        now_ms: i64,
    ) -> Result<Self, String> {
        if !valid_segment(job_id) {
            return Err("Invalid job id".into());
        }
        let candidates_path = company_root(hq_root, company_uid)?
            .join("meetings")
            .join("_candidates")
            .join(format!("{job_id}.json"));
        Ok(ToolHost {
            projection,
            now_ms,
            job_id: job_id.into(),
            source_ref: source_ref.into(),
            candidates_path,
            ledger: ToolLedger::default(),
        })
    }

    pub fn status(&self) -> ProjectionStatus {
        self.projection.status(self.now_ms)
    }

    /// The single dispatch point the session bridge uses.
    pub fn call(&mut self, tool: &str, input: &Value) -> Result<Value, ToolError> {
        if !TOOL_NAMES.contains(&tool) {
            return Err(ToolError::UnknownTool(tool.chars().take(64).collect()));
        }
        self.ledger.calls += 1;
        match tool {
            "ontology.list" => self.list(input),
            "ontology.inspect" => self.inspect(input),
            "ontology.search_alias" => self.search_alias(input),
            _ => self.queue_candidate(input),
        }
    }

    fn with_status(&self, mut v: Value) -> Value {
        let s = self.status();
        v["state"] = json!(s.state);
        v["watermark"] = json!(s.watermark);
        v["provisionalCandidates"] = json!(s.provisional_candidates);
        v
    }

    fn see(&mut self, e: &ProjectedEntity) {
        self.ledger.seen_entity_ids.insert(e.entity_id.clone());
    }

    fn list(&mut self, input: &Value) -> Result<Value, ToolError> {
        let a = args(input, &["type", "cursor", "limit"])?;
        let t = entity_type(a.get("type"))?;
        let n = limit(a.get("limit"), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)?;
        let after = match a.get("cursor") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(c)) => {
                use base64::Engine;
                let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(c)
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                    .filter(|s| valid_entity_id(s))
                    .ok_or_else(|| ToolError::InvalidInput("invalid cursor".into()))?;
                raw
            }
            _ => return Err(ToolError::InvalidInput("cursor must be a string".into())),
        };
        if self.status().provisional_candidates {
            return Ok(self.with_status(json!({ "entities": [], "nextCursor": null })));
        }
        let rows: Vec<ProjectedEntity> = self
            .projection
            .entities
            .range::<String, _>((
                std::ops::Bound::Excluded(&after),
                std::ops::Bound::Unbounded,
            ))
            .map(|(_, e)| e)
            .filter(|e| t.as_ref().is_none_or(|t| &e.entity_type == t))
            .take(n + 1)
            .cloned()
            .collect();
        let page: Vec<ProjectedEntity> = rows.iter().take(n).cloned().collect();
        let next = if rows.len() > n {
            use base64::Engine;
            Some(
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(&page[page.len() - 1].entity_id),
            )
        } else {
            None
        };
        for e in &page {
            self.see(e);
        }
        Ok(self.with_status(json!({ "entities": page, "nextCursor": next })))
    }

    fn inspect(&mut self, input: &Value) -> Result<Value, ToolError> {
        let a = args(input, &["entityId"])?;
        let id = a
            .get("entityId")
            .and_then(Value::as_str)
            .filter(|s| valid_entity_id(s))
            .ok_or_else(|| {
                ToolError::InvalidInput("entityId must be a projected entity id".into())
            })?;
        if self.status().provisional_candidates {
            return Ok(self.with_status(json!({ "found": false, "error": "not_found" })));
        }
        match self.projection.entities.get(id).cloned() {
            Some(e) => {
                self.see(&e);
                Ok(self.with_status(json!({ "found": true, "entity": e })))
            }
            None => Ok(self.with_status(json!({ "found": false, "error": "not_found" }))),
        }
    }

    fn search_alias(&mut self, input: &Value) -> Result<Value, ToolError> {
        let a = args(input, &["query", "type", "limit"])?;
        let q = a
            .get("query")
            .and_then(Value::as_str)
            .filter(|q| q.chars().count() <= MAX_QUERY_CHARS)
            .ok_or_else(|| {
                ToolError::InvalidInput("query must be a string of at most 200 characters".into())
            })?;
        let t = entity_type(a.get("type"))?;
        let n = limit(a.get("limit"), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)?;
        let q = normalize_name(q);
        if q.is_empty() || self.status().provisional_candidates {
            return Ok(self.with_status(json!({ "query": q, "matches": [] })));
        }
        // (exact, canonical, name length, id) ordering, as in hq-pro.
        let mut hits: Vec<(bool, bool, usize, String, ProjectedEntity)> = Vec::new();
        for e in self.projection.entities.values() {
            if t.as_ref().is_some_and(|t| &e.entity_type != t) {
                continue;
            }
            let names = std::iter::once((normalize_name(&e.canonical_name), true))
                .chain(e.aliases.iter().map(|a| (normalize_name(a), false)));
            let best = names
                .filter(|(n, _)| !n.is_empty() && n.starts_with(&q))
                .map(|(n, canon)| (n == q, canon, n.len()))
                .max_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(b.2.cmp(&a.2)));
            if let Some((exact, canon, len)) = best {
                hits.push((exact, canon, len, e.entity_id.clone(), e.clone()));
            }
        }
        hits.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.cmp(&a.1))
                .then(a.2.cmp(&b.2))
                .then(a.3.cmp(&b.3))
        });
        let matches: Vec<Value> = hits
            .into_iter()
            .take(n)
            .map(|(exact, canon, _, _, e)| {
                self.ledger.seen_entity_ids.insert(e.entity_id.clone());
                json!({ "entity": e, "matchedOn": if canon { "canonical" } else { "alias" }, "exact": exact })
            })
            .collect();
        Ok(self.with_status(json!({ "query": q, "matches": matches })))
    }

    fn queue_candidate(&mut self, input: &Value) -> Result<Value, ToolError> {
        let a = args(input, &["name", "type"])?;
        let name = a
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| {
                !n.is_empty() && n.chars().count() <= 120 && !n.chars().any(char::is_control)
            })
            .ok_or_else(|| ToolError::InvalidInput("name must be 1-120 characters".into()))?
            .to_string();
        let t = entity_type(a.get("type"))?.unwrap_or_else(|| "other".into());
        let norm = normalize_name(&name);
        if norm.is_empty() {
            return Err(ToolError::InvalidInput(
                "name has no letters or digits".into(),
            ));
        }
        let id_hash: String =
            Sha256::digest(format!("{}\0{}\0{}", self.job_id, t, norm).as_bytes())
                .iter()
                .take(12)
                .map(|b| format!("{b:02x}"))
                .collect();
        let candidate_id = format!("cand_{id_hash}");
        if !self.ledger.candidates.contains_key(&candidate_id) {
            if self.ledger.candidates.len() >= MAX_CANDIDATES_PER_RUN {
                return Err(ToolError::InvalidInput(
                    "too many candidates in this run".into(),
                ));
            }
            self.ledger.candidates.insert(
                candidate_id.clone(),
                EntityCandidate {
                    candidate_id: candidate_id.clone(),
                    name,
                    entity_type: t,
                    job_id: self.job_id.clone(),
                    source_ref: self.source_ref.clone(),
                },
            );
            let all: Vec<&EntityCandidate> = self.ledger.candidates.values().collect();
            let bytes =
                serde_json::to_vec_pretty(&all).map_err(|e| ToolError::Storage(e.to_string()))?;
            write_atomic(&self.candidates_path, &bytes).map_err(ToolError::Storage)?;
        }
        Ok(json!({ "candidateId": candidate_id, "provisional": true }))
    }

    /// Path of the persisted same-run ledger, so separate tool calls share it.
    pub fn ledger_path(hq_root: &Path, company_uid: &str, job_id: &str) -> Result<PathBuf, String> {
        Ok(
            super::store::run_record_path(&company_root(hq_root, company_uid)?, job_id)?
                .with_extension("tools.json"),
        )
    }

    pub fn load_ledger(&mut self, path: &Path) -> Result<(), String> {
        match std::fs::read(path) {
            Ok(b) => {
                self.ledger = serde_json::from_slice(&b).map_err(|_| "Corrupt tool ledger")?;
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Cannot read tool ledger".into()),
        }
    }

    pub fn save_ledger(&self, path: &Path) -> Result<(), String> {
        let bytes =
            serde_json::to_vec_pretty(&self.ledger).map_err(|_| "Cannot encode tool ledger")?;
        write_atomic(path, &bytes)
    }

    /// Canonical name of an entity a lookup returned in this run.
    pub fn seen_entity(&self, id: &str) -> Option<String> {
        if !self.ledger.seen_entity_ids.contains(id) {
            return None;
        }
        self.projection
            .entities
            .get(id)
            .map(|e| e.canonical_name.clone())
    }

    pub fn candidates_path(&self) -> &Path {
        &self.candidates_path
    }
}
