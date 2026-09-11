//! Heuristic, fully on-device classifier (US-007).
//!
//! Each [`CaptureKind`] collects *independent* cues (text shape, layout,
//! provenance, colour). Cue weights are combined noisy-OR style
//! (`1 - Π(1 - w)`), so one weak cue never reaches the assertion bar on its
//! own and confidence only climbs when several unrelated signals agree.
//! When the runner-up kind scores close to the winner the cues are in
//! conflict and confidence is capped below [`EXTRACTED_THRESHOLD`]: it is
//! always better to be `low_confidence` than confidently wrong.
//!
//! No byte slicing anywhere: text is walked with `chars()` / `split`.

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Value};

use super::{
    ColorSample, ExtractLine, Extraction, ExtractionInput, EXTRACTED_THRESHOLD,
    LOW_CONFIDENCE_THRESHOLD, MAX_PALETTE, MAX_TAGS,
};
use crate::ideas::record::CaptureKind;

/// Confidence ceiling applied when two kinds compete for the capture.
const CONFLICT_CAP: f32 = 0.7;
/// A runner-up within this ratio of the winner counts as a conflict.
const CONFLICT_RATIO: f32 = 0.72;

const MONTHS: [&str; 25] = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

const STOPWORDS: &[&str] = &[
    "this",
    "that",
    "with",
    "from",
    "have",
    "your",
    "they",
    "their",
    "will",
    "would",
    "about",
    "there",
    "which",
    "when",
    "what",
    "were",
    "been",
    "more",
    "also",
    "into",
    "than",
    "then",
    "them",
    "some",
    "just",
    "like",
    "over",
    "only",
    "very",
    "here",
    "most",
    "much",
    "make",
    "made",
    "does",
    "each",
    "other",
    "these",
    "those",
    "such",
    "even",
    "after",
    "before",
    "because",
    "could",
    "should",
    "where",
    "while",
    "being",
    "through",
    "reply",
    "repost",
    "like",
    "likes",
    "views",
    "share",
    "bookmark",
    "read",
    "min",
    "http",
    "https",
    "www",
    "com",
    "posted",
    "follow",
    "following",
    "followers",
    "home",
    "search",
    "menu",
    "sign",
    "subscribe",
    "cart",
    "stock",
    "shipping",
    "free",
    "delivery",
    "amazon",
    "figma",
    "slack",
    "message",
    "thread",
    "replies",
    "today",
    "yesterday",
    "show",
    "more",
];

/// Per-kind evidence: independent cue weights plus the lines that fed them.
#[derive(Default, Debug)]
struct Evidence {
    weights: Vec<f32>,
}

impl Evidence {
    fn add(&mut self, w: f32) {
        if w > 0.0 {
            self.weights.push(w.min(0.95));
        }
    }
    fn score(&self) -> f32 {
        1.0 - self.weights.iter().fold(1.0, |acc, w| acc * (1.0 - w))
    }
    fn cue_count(&self) -> usize {
        self.weights.len()
    }
}

// ----------------------------------------------------------------------------
// text helpers (char-safe)
// ----------------------------------------------------------------------------

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

fn is_count_token(tok: &str) -> bool {
    let t: String = tok.chars().filter(|c| !matches!(c, ',' | '.')).collect();
    let mut chars = t.chars().peekable();
    let mut digits = 0;
    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() {
            digits += 1;
            chars.next();
        } else {
            break;
        }
    }
    if digits == 0 {
        return false;
    }
    let rest: String = chars.collect();
    matches!(rest.as_str(), "" | "K" | "k" | "M" | "m" | "B")
}

fn strip_punct(tok: &str) -> &str {
    tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '#' && c != '_')
}

/// `@handle` — `@` followed by 2..=30 `[A-Za-z0-9_]` chars, as a whole token.
fn find_handle(line: &str) -> Option<String> {
    for raw in line.split_whitespace() {
        let tok = raw.trim_matches(|c: char| {
            matches!(c, '(' | ')' | ',' | ':' | ';' | '.' | '"' | '“' | '”')
        });
        let mut chars = tok.chars();
        if chars.next() != Some('@') {
            continue;
        }
        let body: String = chars.collect();
        let len = body.chars().count();
        if (2..=30).contains(&len) && body.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Some(format!("@{body}"));
        }
    }
    None
}

fn is_engagement_row(line: &str) -> bool {
    let toks: Vec<&str> = line.split_whitespace().collect();
    if toks.is_empty() || toks.len() > 12 {
        return false;
    }
    const WORDS: [&str; 8] = [
        "reply", "repost", "retweet", "like", "view", "bookmark", "quote", "share",
    ];
    let is_word = |t: &str| {
        let t = lower(strip_punct(t));
        WORDS.iter().any(|w| t == *w || t == format!("{w}s"))
    };
    let counts = toks
        .iter()
        .filter(|t| is_count_token(strip_punct(t)))
        .count();
    let words = toks.iter().filter(|t| is_word(t)).count();
    let other = toks
        .iter()
        .filter(|t| {
            !is_count_token(strip_punct(t)) && !is_word(t) && !matches!(**t, "·" | "•" | "|")
        })
        .count();
    // A date (`Sept. 9, 2026`) is two numbers too; a real engagement row
    // is *only* numbers and reaction words.
    other == 0 && (counts >= 3 || (counts >= 2 && words >= 1) || words >= 2)
}

fn has_month(l: &str) -> bool {
    l.split_whitespace()
        .map(|t| strip_punct(t).to_lowercase())
        .any(|t| MONTHS.contains(&t.as_str()))
}

fn has_year(l: &str) -> bool {
    l.split_whitespace().any(|t| {
        let t = strip_punct(t);
        t.chars().count() == 4
            && t.chars().all(|c| c.is_ascii_digit())
            && (t.starts_with("19") || t.starts_with("20"))
    })
}

fn has_clock_time(l: &str) -> bool {
    let toks: Vec<&str> = l.split_whitespace().collect();
    toks.iter().enumerate().any(|(i, t)| {
        let t = strip_punct(t);
        let colon = t.contains(':') && t.chars().all(|c| c.is_ascii_digit() || c == ':');
        colon
            && toks
                .get(i + 1)
                .map(|n| matches!(lower(strip_punct(n)).as_str(), "am" | "pm"))
                .unwrap_or(false)
    })
}

fn is_relative_age(tok: &str) -> bool {
    let t = strip_punct(tok);
    let mut cs = t.chars().peekable();
    let mut digits = 0;
    while cs.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        cs.next();
        digits += 1;
    }
    let rest: String = cs.collect();
    digits > 0 && digits <= 3 && matches!(rest.as_str(), "s" | "m" | "h" | "d" | "w" | "mo" | "y")
}

/// `9:41 AM · Sep 10, 2026`, `· 3h`, `Sep 10`-with-dot.
fn is_x_timestamp(line: &str) -> bool {
    let dot = line.contains('·') || line.contains(" • ");
    let l = lower(line);
    if has_read_time(&l) {
        return false;
    }
    (dot && (has_clock_time(&l) || has_month(&l) || l.split_whitespace().any(is_relative_age)))
        || (has_clock_time(&l) && has_month(&l) && has_year(&l))
}

fn is_date_line(line: &str) -> bool {
    let l = lower(line);
    has_month(&l) && has_year(&l) && word_count(&l) <= 8
}

fn find_price(line: &str) -> Option<String> {
    for raw in line.split_whitespace() {
        let tok = raw.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | '*'));
        let mut cs = tok.chars();
        let Some(first) = cs.next() else { continue };
        if !matches!(first, '$' | '€' | '£' | '¥') {
            continue;
        }
        let rest: String = cs.collect();
        let digits = rest.chars().filter(|c| c.is_ascii_digit()).count();
        if digits >= 1
            && rest
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '.' | ','))
        {
            return Some(tok.to_string());
        }
    }
    let l = lower(line);
    let toks: Vec<&str> = l.split_whitespace().collect();
    for (i, t) in toks.iter().enumerate() {
        if matches!(*t, "usd" | "eur" | "gbp") {
            if let Some(n) = toks.get(i + 1) {
                if n.chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
                {
                    return Some(format!("{} {}", t.to_uppercase(), n));
                }
            }
        }
    }
    None
}

fn is_commerce_cta(l: &str) -> bool {
    [
        "add to cart",
        "add to bag",
        "add to basket",
        "buy now",
        "buy it now",
        "in stock",
        "out of stock",
        "free shipping",
        "free delivery",
        "free returns",
        "ships from",
        "sold by",
        "check out",
        "checkout",
        "quantity",
    ]
    .iter()
    .any(|p| l.contains(p))
}

fn is_rating_line(l: &str) -> bool {
    (l.contains("out of 5") || l.contains("ratings") || l.contains("reviews") || l.contains('★'))
        && l.split_whitespace()
            .any(|t| is_count_token(strip_punct(t)) || t.contains('.'))
}

fn is_byline(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let mut words = trimmed.split_whitespace();
    let first = words.next()?;
    if !matches!(first, "By" | "BY" | "by") {
        return None;
    }
    // `By Nilay Patel, editor-in-chief` — the name ends at the first comma.
    let mut name: Vec<&str> = Vec::new();
    for w in words {
        if matches!(w, "|" | "·" | "•" | "-" | "—" | "and") {
            break;
        }
        let ends_comma = w.ends_with(',');
        name.push(w.trim_end_matches(','));
        if ends_comma {
            break;
        }
    }
    let n = name.len();
    if (1..=5).contains(&n)
        && name
            .iter()
            .all(|w| w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) || w.len() <= 3)
    {
        return Some(name.join(" "));
    }
    None
}

fn has_read_time(l: &str) -> bool {
    l.contains("min read") || l.contains("minute read") || l.contains("-minute read")
}

fn starts_quote(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('“') || t.starts_with('"') || t.starts_with('‘') || t.starts_with('«')
}

fn ends_quote(line: &str) -> bool {
    let t = line.trim_end_matches(['.', ',', '!', '?']);
    t.ends_with('”') || t.ends_with('"') || t.ends_with('’') || t.ends_with('»')
}

fn attribution(line: &str) -> Option<String> {
    let t = line.trim();
    for dash in ["—", "―", "–", "- "] {
        if let Some(rest) = t.strip_prefix(dash) {
            let name = rest.trim().trim_start_matches('-').trim();
            let wc = word_count(name);
            if (1..=8).contains(&wc)
                && name
                    .chars()
                    .next()
                    .map(|c| c.is_alphabetic())
                    .unwrap_or(false)
            {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn hex_codes(line: &str) -> Vec<String> {
    line.split_whitespace()
        .filter_map(|raw| {
            let tok = strip_punct(raw);
            let mut cs = tok.chars();
            if cs.next() != Some('#') {
                return None;
            }
            let body: String = cs.collect();
            if body.chars().count() == 6 && body.chars().all(|c| c.is_ascii_hexdigit()) {
                Some(format!("#{}", body.to_lowercase()))
            } else {
                None
            }
        })
        .collect()
}

fn slack_channel(line: &str) -> bool {
    line.split_whitespace().any(|raw| {
        let tok = strip_punct(raw);
        let mut cs = tok.chars();
        cs.next() == Some('#') && {
            let body: String = cs.collect();
            body.chars().count() >= 3
                && body
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
                && !body.chars().all(|c| c.is_ascii_hexdigit())
        }
    })
}

fn host_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    Some(
        host.strip_prefix("www.")
            .map(str::to_string)
            .unwrap_or(host),
    )
}

fn host_ends(host: &str, suffixes: &[&str]) -> bool {
    suffixes
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn is_saturated(hex: &str) -> bool {
    let v: Vec<u8> = hex
        .trim_start_matches('#')
        .chars()
        .collect::<Vec<_>>()
        .chunks(2)
        .filter_map(|pair| {
            let s: String = pair.iter().collect();
            u8::from_str_radix(&s, 16).ok()
        })
        .collect();
    if v.len() != 3 {
        return false;
    }
    let max = *v.iter().max().unwrap_or(&0) as i32;
    let min = *v.iter().min().unwrap_or(&0) as i32;
    max - min >= 40 && max >= 60
}

// ----------------------------------------------------------------------------
// classification
// ----------------------------------------------------------------------------

struct Lines<'a> {
    all: &'a [ExtractLine],
    lowered: Vec<String>,
}

impl<'a> Lines<'a> {
    fn new(all: &'a [ExtractLine]) -> Self {
        Lines {
            all,
            lowered: all.iter().map(|l| lower(&l.text)).collect(),
        }
    }
    fn iter(&self) -> impl Iterator<Item = (&ExtractLine, &str)> {
        self.all.iter().zip(self.lowered.iter().map(String::as_str))
    }
}

/// Classify a capture. Never panics on any input; never asserts a kind when
/// its cues are contradicted by another kind's cues.
pub fn classify(input: &ExtractionInput) -> Extraction {
    let lines = Lines::new(&input.lines);
    let host = input.url.as_deref().and_then(host_of);
    let app = lower(&input.app);
    let title = lower(&input.window_title);
    let n_lines = input.lines.len();
    let long_lines = lines
        .iter()
        .filter(|(l, _)| word_count(&l.text) >= 8)
        .count();

    let mut ev: BTreeMap<u8, Evidence> = BTreeMap::new();
    let kinds = [
        CaptureKind::XPost,
        CaptureKind::Article,
        CaptureKind::Product,
        CaptureKind::Quote,
        CaptureKind::Color,
        CaptureKind::Image,
    ];
    let idx = |k: CaptureKind| kinds.iter().position(|x| *x == k).unwrap_or(0) as u8;
    for k in kinds {
        ev.insert(idx(k), Evidence::default());
    }
    let mut add = |k: CaptureKind, w: f32| {
        if let Some(e) = ev.get_mut(&idx(k)) {
            e.add(w);
        }
    };

    // ---- x_post ----
    let handle_line = lines
        .iter()
        .position(|(l, _)| find_handle(&l.text).is_some());
    let handle = handle_line.and_then(|i| find_handle(&input.lines[i].text));
    let engagement_line = lines.iter().position(|(l, _)| is_engagement_row(&l.text));
    // The post footer (`9:41 AM · Sep 10, 2026`) is the timestamp that
    // matters; a `· 3h` on the author row is only a weak echo of it.
    let ts_candidates: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (l, _))| is_x_timestamp(&l.text))
        .map(|(i, _)| i)
        .collect();
    let ts_line = ts_candidates
        .iter()
        .copied()
        .find(|i| {
            let l = lower(&input.lines[*i].text);
            has_month(&l) && (has_year(&l) || has_clock_time(&l))
        })
        .or_else(|| {
            ts_candidates
                .iter()
                .copied()
                .find(|i| Some(*i) != handle_line)
        })
        .or_else(|| ts_candidates.first().copied());
    if handle.is_some() {
        add(CaptureKind::XPost, 0.4);
    }
    if engagement_line.is_some() {
        add(CaptureKind::XPost, 0.35);
    }
    // `Name @handle` author row: a display name directly before the handle.
    let author_row = handle_line
        .map(|i| {
            let toks: Vec<&str> = input.lines[i].text.split_whitespace().collect();
            let before = toks
                .iter()
                .take_while(|t| !t.starts_with('@'))
                .filter(|t| !matches!(**t, "✓" | "·"))
                .count();
            (1..=4).contains(&before)
                && toks
                    .first()
                    .and_then(|t| t.chars().next())
                    .map(|c| c.is_uppercase())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    if author_row {
        add(CaptureKind::XPost, 0.2);
    }
    if ts_line.is_some() {
        add(CaptureKind::XPost, 0.25);
    }
    let x_host = host
        .as_deref()
        .map(|h| host_ends(h, &["x.com", "twitter.com"]))
        .unwrap_or(false);
    if x_host {
        add(CaptureKind::XPost, 0.45);
    } else if title.ends_with(" / x")
        || title.contains(" on x:")
        || title.contains("on x \"")
        || app == "x"
    {
        add(CaptureKind::XPost, 0.3);
    }
    if lines.iter().any(|(_, l)| {
        l.contains("show this thread")
            || l.contains("post your reply")
            || l.contains("quote post")
            || l.starts_with("replying to")
    }) {
        add(CaptureKind::XPost, 0.2);
    }

    // ---- article ----
    let byline = lines.iter().find_map(|(l, _)| is_byline(&l.text));
    let read_time = lines.iter().any(|(_, l)| has_read_time(l));
    let date_line = lines
        .iter()
        .any(|(l, _)| is_date_line(&l.text) && !is_x_timestamp(&l.text));
    let title_line = pick_title_line(&input.lines);
    let article_host = host
        .as_deref()
        .map(|h| {
            host_ends(
                h,
                &[
                    "nytimes.com",
                    "theverge.com",
                    "substack.com",
                    "medium.com",
                    "washingtonpost.com",
                    "theatlantic.com",
                    "wired.com",
                    "arstechnica.com",
                    "bbc.com",
                    "bbc.co.uk",
                    "theguardian.com",
                    "bloomberg.com",
                    "techcrunch.com",
                    "newyorker.com",
                    "stratechery.com",
                    "ft.com",
                    "wsj.com",
                    "economist.com",
                    "vox.com",
                ],
            ) || h.contains("blog")
                || h.contains("news")
        })
        .unwrap_or(false);
    if byline.is_some() {
        add(CaptureKind::Article, 0.35);
    }
    if read_time {
        add(CaptureKind::Article, 0.3);
    }
    if date_line {
        add(CaptureKind::Article, 0.2);
    }
    if article_host {
        add(CaptureKind::Article, 0.4);
    }
    if title_line.is_some() && long_lines >= 2 {
        add(CaptureKind::Article, 0.3);
    } else if long_lines >= 4 {
        add(CaptureKind::Article, 0.15);
    }
    if lines.iter().any(|(_, l)| {
        l.contains("continue reading")
            || l.contains("share this article")
            || l.contains("subscribe") && l.contains("newsletter")
    }) {
        add(CaptureKind::Article, 0.15);
    }

    // ---- product ----
    let price_line = lines
        .iter()
        .position(|(l, _)| find_price(&l.text).is_some());
    let price = price_line.and_then(|i| find_price(&input.lines[i].text));
    let cta = lines.iter().any(|(_, l)| is_commerce_cta(l));
    let rating = lines.iter().any(|(_, l)| is_rating_line(l));
    let product_host = host
        .as_deref()
        .map(|h| {
            host_ends(
                h,
                &[
                    "amazon.com",
                    "amazon.co.uk",
                    "amazon.ca",
                    "etsy.com",
                    "ebay.com",
                    "shopify.com",
                    "myshopify.com",
                    "bestbuy.com",
                    "target.com",
                    "walmart.com",
                ],
            ) || h == "apple.com"
                && input
                    .url
                    .as_deref()
                    .map(|u| u.contains("/shop/"))
                    .unwrap_or(false)
                || h.starts_with("shop.")
                || h.starts_with("store.")
        })
        .unwrap_or(false);
    if price.is_some() {
        add(CaptureKind::Product, 0.35);
    }
    if cta {
        add(CaptureKind::Product, 0.35);
    }
    if rating {
        add(CaptureKind::Product, 0.2);
    }
    if product_host {
        add(CaptureKind::Product, 0.45);
    }
    if lines.iter().any(|(_, l)| {
        l.starts_with("size ") || l.starts_with("color: ") || l.starts_with("quantity")
    }) {
        add(CaptureKind::Product, 0.2);
    }

    // ---- quote ----
    let quoted: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (l, _))| starts_quote(&l.text) || ends_quote(&l.text))
        .map(|(i, _)| i)
        .collect();
    let has_open_close = lines.iter().any(|(l, _)| starts_quote(&l.text))
        && lines.iter().any(|(l, _)| ends_quote(&l.text));
    let attr = lines.iter().find_map(|(l, _)| attribution(&l.text));
    let quote_host = host
        .as_deref()
        .map(|h| {
            host_ends(
                h,
                &[
                    "goodreads.com",
                    "brainyquote.com",
                    "quotefancy.com",
                    "azquotes.com",
                ],
            )
        })
        .unwrap_or(false);
    if has_open_close {
        add(CaptureKind::Quote, 0.4);
    } else if !quoted.is_empty() {
        add(CaptureKind::Quote, 0.15);
    }
    if attr.is_some() {
        add(CaptureKind::Quote, 0.35);
    }
    if quote_host {
        add(CaptureKind::Quote, 0.4);
    }
    if n_lines <= 6 && n_lines > 0 && (has_open_close || attr.is_some()) {
        add(CaptureKind::Quote, 0.15);
    }

    // ---- color ----
    let text_hex: Vec<String> = {
        let mut seen = HashSet::new();
        lines
            .iter()
            .flat_map(|(l, _)| hex_codes(&l.text))
            .filter(|h| seen.insert(h.clone()))
            .collect()
    };
    let flat = flat_palette(&input.palette);
    let figma_host = host
        .as_deref()
        .map(|h| host_ends(h, &["figma.com", "coolors.co", "color.adobe.com"]))
        .unwrap_or(false)
        || app == "figma";
    if text_hex.len() >= 4 {
        add(CaptureKind::Color, 0.6);
    } else if text_hex.len() >= 2 {
        add(CaptureKind::Color, 0.45);
    } else if text_hex.len() == 1 {
        add(CaptureKind::Color, 0.2);
    }
    if flat.len() >= 3 {
        add(CaptureKind::Color, if n_lines <= 8 { 0.5 } else { 0.2 });
    } else if flat.len() == 2 && n_lines <= 6 {
        add(CaptureKind::Color, 0.3);
    }
    if figma_host && (text_hex.len() + flat.len()) > 0 {
        add(CaptureKind::Color, 0.25);
    }
    if lines.iter().any(|(_, l)| {
        l.contains("palette")
            || l.contains("color styles")
            || l.contains("colour")
            || l.contains("swatch")
    }) {
        add(CaptureKind::Color, 0.2);
    }

    // ---- image (screens / chat / UI frames) ----
    let slack_app = app.contains("slack") || title.contains("slack");
    let slack_shape = lines.iter().any(|(l, _)| slack_channel(&l.text))
        || lines.iter().any(|(_, l)| {
            l.contains("reply in thread")
                || l.contains("last reply")
                || l.ends_with(" replies")
                || l.contains("was pinned")
                || l.contains("joined the channel")
        });
    // `Maya Chen 10:42 AM` author rows: short, clock-time terminated.
    let chat_rows = lines
        .iter()
        .filter(|(l, low)| {
            has_clock_time(low) && !is_x_timestamp(&l.text) && word_count(&l.text) <= 5
        })
        .count();
    if slack_app {
        add(CaptureKind::Image, 0.5);
    }
    if slack_shape {
        add(CaptureKind::Image, 0.35);
    }
    if chat_rows >= 2 {
        add(CaptureKind::Image, 0.3);
    }
    if figma_host && text_hex.is_empty() && flat.len() < 3 {
        add(CaptureKind::Image, 0.35);
    }
    if lines.iter().any(|(_, l)| {
        l.contains("frame")
            || l.contains("component")
            || l.contains("prototype")
            || l.contains("auto layout")
    }) && figma_host
    {
        add(CaptureKind::Image, 0.25);
    }
    if n_lines <= 3 && !input.palette.is_empty() && flat.len() < 2 {
        add(CaptureKind::Image, 0.3);
    }
    if matches!(app.as_str(), "preview" | "photos" | "finder") {
        add(CaptureKind::Image, 0.4);
    }

    // ---- decide ----
    let mut ranked: Vec<(CaptureKind, f32, usize)> = kinds
        .iter()
        .map(|k| {
            let e = &ev[&idx(*k)];
            (*k, e.score(), e.cue_count())
        })
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let (best_kind, best_score, best_cues) = ranked[0];
    let runner = ranked.get(1).map(|r| r.1).unwrap_or(0.0);

    let mut confidence = best_score;
    if best_cues < 2 {
        confidence = confidence.min(EXTRACTED_THRESHOLD - 0.05);
    }
    if runner >= LOW_CONFIDENCE_THRESHOLD && runner >= best_score * CONFLICT_RATIO {
        confidence = confidence.min(CONFLICT_CAP);
    }
    // Sparse OCR with no geometry/colour evidence: never assert.
    if n_lines == 0 && input.palette.is_empty() {
        confidence = confidence.min(LOW_CONFIDENCE_THRESHOLD - 0.05);
    }
    // Round away float noise so `0.4` is `0.4`, not `0.39999998`.
    let confidence = (confidence.clamp(0.0, 1.0) * 1000.0).round() / 1000.0;

    let tags = auto_tags(input, host.as_deref());

    if confidence < LOW_CONFIDENCE_THRESHOLD {
        return Extraction {
            kind: CaptureKind::Unknown,
            confidence,
            extracted: json!({}),
            tags,
        };
    }

    let source = host.clone().unwrap_or_else(|| input.app.clone());
    let extracted = match best_kind {
        CaptureKind::XPost => {
            let hl = handle_line.unwrap_or(0);
            let handle_text = handle.clone().unwrap_or_default();
            let author = x_author(&input.lines, hl, &handle_text);
            let stop = [engagement_line, ts_line]
                .into_iter()
                .flatten()
                .filter(|i| *i > hl)
                .min()
                .unwrap_or(n_lines);
            let body: Vec<&str> = input
                .lines
                .iter()
                .enumerate()
                .skip(hl + 1)
                .take_while(|(i, _)| *i < stop)
                .map(|(_, l)| l.text.trim())
                .filter(|t| !t.is_empty() && !is_engagement_row(t) && !is_x_timestamp(t))
                .collect();
            let mut v = json!({ "author": author, "handle": handle_text, "body": body.join("\n") });
            if let Some(i) = ts_line {
                v["posted_at"] = Value::String(input.lines[i].text.trim().to_string());
            }
            v
        }
        CaptureKind::Article => {
            let t = title_line
                .map(|i| input.lines[i].text.trim().to_string())
                .unwrap_or_else(|| input.window_title.clone());
            let mut v = json!({ "title": t, "source": source });
            if let Some(b) = byline {
                v["byline"] = Value::String(b);
            }
            v
        }
        CaptureKind::Product => {
            let name = product_name(&input.lines, price_line)
                .unwrap_or_else(|| input.window_title.clone());
            let mut v = json!({ "name": name, "source": source });
            if let Some(p) = price {
                v["price"] = Value::String(p);
            }
            v
        }
        CaptureKind::Quote => {
            let text = quote_text(&input.lines, &quoted);
            let mut v = json!({ "text": text });
            if let Some(a) = attr {
                v["attribution"] = Value::String(a);
            }
            v
        }
        CaptureKind::Color => {
            let mut palette: Vec<String> = text_hex.clone();
            for c in &flat {
                if palette.len() >= MAX_PALETTE {
                    break;
                }
                if !palette.contains(&c.hex) {
                    palette.push(c.hex.clone());
                }
            }
            palette.truncate(MAX_PALETTE);
            json!({ "palette": palette })
        }
        CaptureKind::Image => {
            let mut v = json!({});
            let cap = input.window_title.trim();
            if !cap.is_empty() {
                v["caption"] = Value::String(cap.to_string());
            }
            v
        }
        CaptureKind::Unknown => json!({}),
    };

    Extraction {
        kind: best_kind,
        confidence,
        extracted,
        tags,
    }
}

/// Saturated colours covering a meaningful share of the image. Neutral
/// (white / grey / black) buckets are UI chrome and text, not palette.
fn flat_palette(palette: &[ColorSample]) -> Vec<ColorSample> {
    palette
        .iter()
        .filter(|c| c.fraction >= 0.06 && is_saturated(&c.hex))
        .cloned()
        .collect()
}

/// The most title-shaped line: near the top, tall, several words, not a
/// nav/byline/date line.
fn pick_title_line(lines: &[ExtractLine]) -> Option<usize> {
    let mut heights: Vec<f32> = lines
        .iter()
        .map(|l| l.bbox.height)
        .filter(|h| *h > 0.0)
        .collect();
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = heights.get(heights.len() / 2).copied().unwrap_or(0.0);
    let mut best: Option<(usize, f32)> = None;
    for (i, l) in lines.iter().enumerate() {
        let wc = word_count(&l.text);
        // A headline is set visibly larger than the body; uniform-height
        // text (a tweet, a chat) has no title.
        if !(3..=30).contains(&wc) || l.bbox.y > 0.55 || l.bbox.height < median * 1.4 {
            continue;
        }
        if is_byline(&l.text).is_some() || is_date_line(&l.text) || has_read_time(&lower(&l.text)) {
            continue;
        }
        let score = l.bbox.height * 10.0 + (0.55 - l.bbox.y) + (wc.min(12) as f32) * 0.02;
        if best.map(|(_, s)| score > s).unwrap_or(true) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

fn x_author(lines: &[ExtractLine], handle_line: usize, handle: &str) -> String {
    let line = lines
        .get(handle_line)
        .map(|l| l.text.as_str())
        .unwrap_or("");
    let before: Vec<&str> = line
        .split_whitespace()
        .take_while(|t| strip_punct(t) != handle && !t.starts_with('@'))
        .filter(|t| !matches!(*t, "·" | "•" | "✓"))
        .collect();
    if !before.is_empty() {
        return before.join(" ");
    }
    if handle_line > 0 {
        let prev = lines[handle_line - 1].text.trim();
        if (1..=5).contains(&word_count(prev)) && !is_engagement_row(prev) {
            return prev.to_string();
        }
    }
    handle.to_string()
}

fn product_name(lines: &[ExtractLine], price_line: Option<usize>) -> Option<String> {
    let limit = price_line.unwrap_or(lines.len());
    lines
        .iter()
        .take(limit.max(1))
        .filter(|l| {
            let wc = word_count(&l.text);
            let low = lower(&l.text);
            (3..=25).contains(&wc)
                && find_price(&l.text).is_none()
                && !is_commerce_cta(&low)
                && !is_rating_line(&low)
        })
        .max_by(|a, b| {
            let sa = a.bbox.height * 10.0 + word_count(&a.text) as f32 * 0.05;
            let sb = b.bbox.height * 10.0 + word_count(&b.text) as f32 * 0.05;
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|l| l.text.trim().to_string())
}

fn quote_text(lines: &[ExtractLine], quoted: &[usize]) -> String {
    let (start, end) = match (quoted.first(), quoted.last()) {
        (Some(s), Some(e)) => (*s, *e),
        _ => (0, lines.len().saturating_sub(1)),
    };
    lines
        .iter()
        .enumerate()
        .filter(|(i, l)| *i >= start && *i <= end && attribution(&l.text).is_none())
        .map(|(_, l)| l.text.trim().trim_matches(['“', '”', '"', '«', '»']))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Up to [`MAX_TAGS`] tags: URL host first, then app, then OCR keywords.
fn auto_tags(input: &ExtractionInput, host: Option<&str>) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut push = |t: String| {
        let t = t.trim().to_lowercase();
        if !t.is_empty() && !tags.contains(&t) && tags.len() < MAX_TAGS {
            tags.push(t);
        }
    };
    if let Some(h) = host {
        let label = if host_ends(h, &["x.com", "twitter.com"]) {
            "x".to_string()
        } else {
            h.split('.').next().unwrap_or(h).to_string()
        };
        push(label);
    }
    if !input.app.trim().is_empty() {
        push(
            input
                .app
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string(),
        );
    }
    let mut freq: BTreeMap<String, usize> = BTreeMap::new();
    for l in &input.lines {
        for raw in l.text.split_whitespace() {
            let w = strip_punct(raw).to_lowercase();
            if w.chars().count() >= 4
                && w.chars().all(|c| c.is_alphabetic())
                && !STOPWORDS.contains(&w.as_str())
            {
                *freq.entry(w).or_insert(0) += 1;
            }
        }
    }
    let mut ranked: Vec<(String, usize)> = freq.into_iter().collect();
    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.0.chars().count().cmp(&a.0.chars().count()))
            .then_with(|| a.0.cmp(&b.0))
    });
    for (w, _) in ranked {
        push(w);
    }
    tags.truncate(MAX_TAGS);
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ideas::extract::{status_for, LineBox};
    use crate::ideas::record::CaptureStatus;

    /// Stack lines top-to-bottom; the longest of the first three lines is
    /// set headline-tall, the way a masthead + headline page reads.
    fn lines(texts: &[&str]) -> Vec<ExtractLine> {
        let n = texts.len().max(1) as f32;
        let headline = texts
            .iter()
            .take(3)
            .enumerate()
            .max_by_key(|(_, t)| t.chars().count())
            .map(|(i, _)| i);
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| ExtractLine {
                text: (*t).to_string(),
                bbox: LineBox {
                    x: 0.05,
                    y: i as f32 / n,
                    width: 0.8,
                    height: if Some(i) == headline { 0.07 } else { 0.03 },
                },
                confidence: 0.9,
            })
            .collect()
    }

    fn input(texts: &[&str], app: &str, url: Option<&str>) -> ExtractionInput {
        ExtractionInput {
            lines: lines(texts),
            app: app.to_string(),
            window_title: String::new(),
            url: url.map(str::to_string),
            palette: Vec::new(),
        }
    }

    #[test]
    fn hq_idea_board_x_post_is_extracted_with_at_handle() {
        let out = classify(&input(
            &[
                "Andrej Karpathy @karpathy · 3h",
                "The hottest new programming language is English.",
                "9:41 AM · Sep 10, 2026 · 1.2M Views",
                "1.2K 348 4.5K 210",
            ],
            "Safari",
            Some("https://x.com/karpathy/status/1"),
        ));
        assert_eq!(out.kind, CaptureKind::XPost);
        assert!(out.confidence >= 0.75, "{}", out.confidence);
        assert_eq!(status_for(out.confidence), CaptureStatus::Extracted);
        assert_eq!(out.extracted["handle"], "@karpathy");
        assert!(out.extracted["handle"].as_str().unwrap().starts_with('@'));
        assert_eq!(out.extracted["author"], "Andrej Karpathy");
        assert!(out.extracted["body"].as_str().unwrap().contains("English"));
        assert!(out.extracted["posted_at"]
            .as_str()
            .unwrap()
            .contains("2026"));
        assert!(out.tags.contains(&"x".to_string()));
    }

    #[test]
    fn hq_idea_board_article_gets_title_byline_source() {
        let out = classify(&input(
            &[
                "The Verge",
                "Apple's new laptop chip is the fastest thing we've ever tested in a notebook",
                "By Nilay Patel",
                "Sep 9, 2026, 9:00 AM EDT · 6 min read",
                "The review unit arrived on a Tuesday and by Wednesday we had run every benchmark twice.",
                "It is not close. Nothing in the category comes within a third of its multicore score.",
            ],
            "Google Chrome",
            Some("https://www.theverge.com/reviews/1"),
        ));
        assert_eq!(out.kind, CaptureKind::Article);
        assert!(out.confidence >= 0.75, "{}", out.confidence);
        assert_eq!(out.extracted["byline"], "Nilay Patel");
        assert_eq!(out.extracted["source"], "theverge.com");
        assert!(out.extracted["title"]
            .as_str()
            .unwrap()
            .contains("laptop chip"));
    }

    #[test]
    fn hq_idea_board_product_gets_name_price_source() {
        let out = classify(&input(
            &[
                "Anker 737 Power Bank (PowerCore 24K), 24,000mAh 3-Port Portable Charger",
                "4.6 out of 5 stars 31,204 ratings",
                "$109.99",
                "In Stock",
                "Add to Cart",
            ],
            "Safari",
            Some("https://www.amazon.com/dp/B09VPHVT2Z"),
        ));
        assert_eq!(out.kind, CaptureKind::Product);
        assert!(out.confidence >= 0.75, "{}", out.confidence);
        assert_eq!(out.extracted["price"], "$109.99");
        assert!(out.extracted["name"].as_str().unwrap().contains("Anker"));
        assert_eq!(out.extracted["source"], "amazon.com");
    }

    #[test]
    fn hq_idea_board_quote_gets_text_and_attribution() {
        let out = classify(&input(
            &[
                "“The best way to predict the future is to invent it.”",
                "— Alan Kay",
            ],
            "Safari",
            Some("https://www.goodreads.com/quotes/1"),
        ));
        assert_eq!(out.kind, CaptureKind::Quote);
        assert!(out.confidence >= 0.75, "{}", out.confidence);
        assert_eq!(out.extracted["attribution"], "Alan Kay");
        assert!(out.extracted["text"]
            .as_str()
            .unwrap()
            .starts_with("The best way"));
    }

    #[test]
    fn hq_idea_board_color_palette_from_flat_regions_and_hex() {
        let mut inp = input(
            &["Brand palette", "#1D4ED8 #F97316 #10B981"],
            "Figma",
            Some("https://www.figma.com/file/abc"),
        );
        inp.palette = vec![
            ColorSample {
                hex: "#1848d8".into(),
                fraction: 0.3,
            },
            ColorSample {
                hex: "#f87818".into(),
                fraction: 0.28,
            },
            ColorSample {
                hex: "#18b888".into(),
                fraction: 0.25,
            },
            ColorSample {
                hex: "#f8f8f8".into(),
                fraction: 0.17,
            },
        ];
        let out = classify(&inp);
        assert_eq!(out.kind, CaptureKind::Color);
        assert!(out.confidence >= 0.75, "{}", out.confidence);
        let palette = out.extracted["palette"].as_array().unwrap();
        assert!(palette.len() <= 5 && palette.len() >= 3);
        assert_eq!(palette[0], "#1d4ed8");
        assert!(palette.iter().all(|p| {
            let s = p.as_str().unwrap();
            s.starts_with('#') && s.chars().count() == 7
        }));
    }

    #[test]
    fn hq_idea_board_slack_screenshot_is_image() {
        let out = classify(&input(
            &[
                "#design-reviews",
                "Maya Chen 10:42 AM",
                "Dropped the new onboarding frames in Figma, thoughts before EOD?",
                "Jordan 10:51 AM",
                "Love the second variant. The progress dots feel heavy though.",
                "3 replies Last reply today at 11:02 AM",
            ],
            "Slack",
            None,
        ));
        assert_eq!(out.kind, CaptureKind::Image);
        assert!(out.confidence >= 0.75, "{}", out.confidence);
        assert!(out.tags.contains(&"slack".to_string()));
    }

    #[test]
    fn hq_idea_board_garbage_lines_are_unknown_and_plain() {
        let out = classify(&input(&["|||", "l1 ll", "~~~"], "Unknown", None));
        assert_eq!(out.kind, CaptureKind::Unknown);
        assert!(out.confidence < 0.4);
        assert_eq!(status_for(out.confidence), CaptureStatus::Plain);
        assert!(out.extracted.is_object());
    }

    #[test]
    fn hq_idea_board_conflicting_cues_never_reach_extracted() {
        // A tweet screenshot that also carries a price + cart CTA.
        let out = classify(&input(
            &[
                "Deals Bot @dealsbot · 2h",
                "Anker 737 Power Bank $109.99 — Add to Cart before it sells out",
                "In Stock · Free shipping",
                "42 12 130",
            ],
            "Safari",
            None,
        ));
        assert!(
            out.confidence < 0.75,
            "conflict must cap confidence: {}",
            out.confidence
        );
    }

    #[test]
    fn hq_idea_board_tags_capped_at_five_lowercase_unique() {
        let out = classify(&input(
            &[
                "Design systems tokens spacing typography colour accessibility motion layout Design",
                "Tokens tokens TOKENS spacing",
            ],
            "Google Chrome",
            Some("https://www.figma.com/file/x"),
        ));
        assert!(out.tags.len() <= 5, "{:?}", out.tags);
        assert_eq!(out.tags[0], "figma");
        assert_eq!(out.tags[1], "google");
        let mut d = out.tags.clone();
        d.dedup();
        assert_eq!(d.len(), out.tags.len());
        assert!(out
            .tags
            .iter()
            .all(|t| t == &t.to_lowercase() && t.chars().count() >= 1));
        assert!(out.tags.contains(&"tokens".to_string()));
    }

    #[test]
    fn hq_idea_board_handle_helper_requires_leading_at() {
        assert_eq!(
            find_handle("Name @some_one · 3h").as_deref(),
            Some("@some_one")
        );
        assert_eq!(find_handle("mail me at a@b.com"), None);
        assert_eq!(find_handle("@"), None);
        assert_eq!(find_handle("(@paren)").as_deref(), Some("@paren"));
    }

    #[test]
    fn hq_idea_board_multibyte_text_does_not_panic() {
        let out = classify(&input(
            &[
                "“Ünïcödé — ✓ 日本語 🎉” @héllo €12,50 #ff00aa",
                "— 山田 太郎",
            ],
            "Safari",
            Some("https://例え.jp/x"),
        ));
        assert!(out.confidence <= 1.0);
    }
}
