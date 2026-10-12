//! Names-only detection of the work apps on this computer, for the first-run
//! "Your apps" view (integration auto-detect MVP).
//!
//! Two kinds of evidence, nothing else:
//!
//! - Installed apps. macOS: the `.app` bundles directly inside
//!   `/Applications`, `/Applications/Utilities` and `~/Applications`, reading
//!   only `CFBundleIdentifier`, `CFBundleName` and `CFBundleDisplayName` from
//!   each `Contents/Info.plist`. Windows: only the `DisplayName` value of each
//!   `...\CurrentVersion\Uninstall\*` key (HKLM, HKLM WOW6432Node, HKCU), plus
//!   the folder names under `%LOCALAPPDATA%\Programs`.
//! - MCP servers configured in Claude Code (`~/.claude.json`), Claude Desktop
//!   (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`) and Codex
//!   (`config.toml`).
//!
//! THE MCP CONFIGS HOLD SECRETS. Tools keep tokens in a server's `env`,
//! `headers`, `http_headers`, `args` and in URL query strings. The parsers below
//! are hand-written serde visitors that name every field they look at:
//!
//! - `type` and `enabled` are read as plain values.
//! - `url` / `serverUrl` is parsed with the URL parser inside the visitor and
//!   only the host is kept; the full string is dropped before the visitor
//!   returns, so no struct ever holds a path, query, port or userinfo.
//! - `command`, `env`, `headers`, `http_headers`, `env_http_headers`,
//!   `bearer_token_env_var` and `bearer_token` are skipped with
//!   [`IgnoredAny`]: the parser steps over the value without turning it into
//!   a string. Only the fact that the field exists is recorded.
//! - Every other field, `args` included, is skipped with [`IgnoredAny`] and
//!   leaves no trace at all.
//! - Claude Code's per-project keys are folder paths; they are skipped with
//!   [`IgnoredAny`] too, never kept.
//!
//! The raw file buffer lives only for the duration of the parse and is never
//! logged or put in an error. The one log line carries counts and outcomes.
//!
//! Nothing here leaves the computer: the result goes to the desktop UI only.

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

/// Bundles (macOS) or uninstall entries (Windows) looked at, at most.
const APP_ENTRY_MAX: usize = 500;
/// Wall-clock budget for the installed-app listing.
const APP_SCAN_BUDGET: Duration = Duration::from_secs(2);
/// Config files larger than this are not read (`~/.claude.json` is usually
/// well under a few MB).
const CONFIG_BYTES_MAX: u64 = 16 * 1024 * 1024;
/// MCP servers kept per config file, at most. Later ones are still skipped
/// over by the parser, never stored.
const SERVERS_PER_FILE_MAX: usize = 200;
/// Longest server or app name kept, in characters.
const NAME_MAX_CHARS: usize = 64;

/// Fields whose presence means the server carries a credential somewhere.
/// Their values are never read.
const CREDENTIAL_FIELDS: [&str; 6] = [
    "env",
    "headers",
    "http_headers",
    "env_http_headers",
    "bearer_token_env_var",
    "bearer_token",
];

// ── what the command returns ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundWorkApps {
    pub platform: &'static str,
    pub scanned_at_ms: u64,
    pub apps: Vec<FoundApp>,
    pub mcp_servers: Vec<FoundMcpServer>,
    pub sources: Vec<SourceOutcome>,
    /// True when an entry or time budget stopped a listing early.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundApp {
    /// macOS `CFBundleIdentifier`; null on Windows.
    pub bundle_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundMcpServer {
    pub tool: &'static str,
    /// The server's key in the config, cleaned and capped.
    pub name: String,
    pub transport: &'static str,
    /// Host only (never a full URL); null for local or unparsable URLs and
    /// for servers without a URL.
    pub host: Option<String>,
    /// The URL points at this computer or a private network.
    pub local: bool,
    /// A credential-bearing field (`env`, `headers`, ...) is present. Its
    /// value was never read.
    pub has_credential_fields: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOutcome {
    pub source: &'static str,
    /// "read" | "missing" | "unreadable" | "invalid" | "unsupported" | "budget"
    pub outcome: &'static str,
    pub count: u32,
}

// ── lenient leaf values ───────────────────────────────────────────────────

/// A string value, or `None` for any other shape. Maps and sequences are
/// stepped over with [`IgnoredAny`], never materialized.
struct LenientString(Option<String>);

impl<'de> Deserialize<'de> for LenientString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer
            .deserialize_any(LeafVisitor::String)
            .map(LenientString::from)
    }
}

/// A bool value, or `None` for any other shape.
struct LenientBool(Option<bool>);

impl<'de> Deserialize<'de> for LenientBool {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match deserializer.deserialize_any(LeafVisitor::Bool)? {
            Leaf::Bool(value) => Ok(LenientBool(Some(value))),
            _ => Ok(LenientBool(None)),
        }
    }
}

/// The host part of a `url` value, worked out inside the visitor so the full
/// URL string never outlives it.
struct UrlHost(Option<HostInfo>);

impl<'de> Deserialize<'de> for UrlHost {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match deserializer.deserialize_any(LeafVisitor::Url)? {
            Leaf::Url(info) => Ok(UrlHost(Some(info))),
            _ => Ok(UrlHost(None)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostInfo {
    host: Option<String>,
    local: bool,
}

enum Leaf {
    None,
    String(String),
    Bool(bool),
    Url(HostInfo),
}

impl From<Leaf> for LenientString {
    fn from(leaf: Leaf) -> Self {
        match leaf {
            Leaf::String(value) => LenientString(Some(value)),
            _ => LenientString(None),
        }
    }
}

#[derive(Clone, Copy)]
enum LeafVisitor {
    String,
    Bool,
    Url,
}

impl<'de> Visitor<'de> for LeafVisitor {
    type Value = Leaf;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any value")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Leaf, E> {
        Ok(match self {
            LeafVisitor::String => Leaf::String(value.to_owned()),
            LeafVisitor::Url => Leaf::Url(host_info(value)),
            LeafVisitor::Bool => Leaf::None,
        })
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Leaf, E> {
        Ok(match self {
            LeafVisitor::Bool => Leaf::Bool(value),
            _ => Leaf::None,
        })
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Leaf, E> {
        Ok(Leaf::None)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Leaf, E> {
        Ok(Leaf::None)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Leaf, E> {
        Ok(Leaf::None)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Leaf, E> {
        Ok(Leaf::None)
    }

    fn visit_none<E: de::Error>(self) -> Result<Leaf, E> {
        Ok(Leaf::None)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Leaf, D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Leaf, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Leaf::None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Leaf, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Leaf::None)
    }
}

/// Step over any value without materializing it; used for non-map shapes
/// where a map was expected.
fn ignore_rest<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<(), A::Error> {
    while seq.next_element::<IgnoredAny>()?.is_some() {}
    Ok(())
}

// ── one MCP server entry ──────────────────────────────────────────────────

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct RawServer {
    kind: Option<String>,
    url: Option<HostInfo>,
    has_command: bool,
    has_credential_fields: bool,
    enabled: Option<bool>,
}

impl<'de> Deserialize<'de> for RawServer {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(RawServerVisitor)
    }
}

struct RawServerVisitor;

impl<'de> Visitor<'de> for RawServerVisitor {
    type Value = RawServer;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an MCP server entry")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawServer, A::Error> {
        let mut server = RawServer::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "type" => server.kind = map.next_value::<LenientString>()?.0,
                "url" | "serverUrl" => {
                    if let Some(info) = map.next_value::<UrlHost>()?.0 {
                        server.url = Some(info);
                    }
                }
                "enabled" => {
                    if let Some(value) = map.next_value::<LenientBool>()?.0 {
                        server.enabled = Some(value);
                    }
                }
                "command" => {
                    map.next_value::<IgnoredAny>()?;
                    server.has_command = true;
                }
                field if CREDENTIAL_FIELDS.contains(&field) => {
                    map.next_value::<IgnoredAny>()?;
                    server.has_credential_fields = true;
                }
                // `args`, `cwd` and everything else: never read.
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(server)
    }

    // Any other shape is not a server entry: step over it.
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<RawServer, A::Error> {
        ignore_rest(seq)?;
        Ok(RawServer::default())
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<RawServer, E> {
        Ok(RawServer::default())
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<RawServer, E> {
        Ok(RawServer::default())
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<RawServer, E> {
        Ok(RawServer::default())
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<RawServer, E> {
        Ok(RawServer::default())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<RawServer, E> {
        Ok(RawServer::default())
    }
    fn visit_unit<E: de::Error>(self) -> Result<RawServer, E> {
        Ok(RawServer::default())
    }
}

// ── a map of servers, and Claude Code's projects ──────────────────────────

/// `{ "<server name>": <entry>, ... }`. Any other shape reads as empty.
#[derive(Debug, Default)]
struct ServerMap {
    servers: Vec<(String, RawServer)>,
    truncated: bool,
}

impl<'de> Deserialize<'de> for ServerMap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ServerMapVisitor)
    }
}

struct ServerMapVisitor;

impl<'de> Visitor<'de> for ServerMapVisitor {
    type Value = ServerMap;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a map of MCP servers")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ServerMap, A::Error> {
        let mut out = ServerMap::default();
        while let Some(name) = map.next_key::<String>()? {
            if out.servers.len() >= SERVERS_PER_FILE_MAX {
                map.next_value::<IgnoredAny>()?;
                out.truncated = true;
                continue;
            }
            let server = map.next_value::<RawServer>()?;
            out.servers.push((name, server));
        }
        Ok(out)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<ServerMap, A::Error> {
        ignore_rest(seq)?;
        Ok(ServerMap::default())
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<ServerMap, E> {
        Ok(ServerMap::default())
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<ServerMap, E> {
        Ok(ServerMap::default())
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<ServerMap, E> {
        Ok(ServerMap::default())
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<ServerMap, E> {
        Ok(ServerMap::default())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<ServerMap, E> {
        Ok(ServerMap::default())
    }
    fn visit_unit<E: de::Error>(self) -> Result<ServerMap, E> {
        Ok(ServerMap::default())
    }
}

/// Claude Code's `projects`: `{ "<folder path>": { "mcpServers": {...}, ... } }`.
/// The folder path keys are skipped, never kept.
#[derive(Debug, Default)]
struct ProjectServers(ServerMap);

impl<'de> Deserialize<'de> for ProjectServers {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ProjectsVisitor)
    }
}

struct ProjectsVisitor;

impl<'de> Visitor<'de> for ProjectsVisitor {
    type Value = ProjectServers;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a map of projects")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ProjectServers, A::Error> {
        let mut out = ServerMap::default();
        while map.next_key::<IgnoredAny>()?.is_some() {
            let project = map.next_value::<OneProject>()?;
            out.truncated |= project.0.truncated;
            for entry in project.0.servers {
                if out.servers.len() >= SERVERS_PER_FILE_MAX {
                    out.truncated = true;
                    break;
                }
                out.servers.push(entry);
            }
        }
        Ok(ProjectServers(out))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<ProjectServers, A::Error> {
        ignore_rest(seq)?;
        Ok(ProjectServers::default())
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<ProjectServers, E> {
        Ok(ProjectServers::default())
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<ProjectServers, E> {
        Ok(ProjectServers::default())
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<ProjectServers, E> {
        Ok(ProjectServers::default())
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<ProjectServers, E> {
        Ok(ProjectServers::default())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<ProjectServers, E> {
        Ok(ProjectServers::default())
    }
    fn visit_unit<E: de::Error>(self) -> Result<ProjectServers, E> {
        Ok(ProjectServers::default())
    }
}

/// One project's settings: only `mcpServers` is read.
#[derive(Debug, Default)]
struct OneProject(ServerMap);

impl<'de> Deserialize<'de> for OneProject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(OneProjectVisitor)
    }
}

struct OneProjectVisitor;

impl<'de> Visitor<'de> for OneProjectVisitor {
    type Value = OneProject;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a project's settings")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OneProject, A::Error> {
        let mut servers = ServerMap::default();
        while let Some(key) = map.next_key::<String>()? {
            if key == "mcpServers" {
                servers = map.next_value::<ServerMap>()?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(OneProject(servers))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<OneProject, A::Error> {
        ignore_rest(seq)?;
        Ok(OneProject::default())
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<OneProject, E> {
        Ok(OneProject::default())
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<OneProject, E> {
        Ok(OneProject::default())
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<OneProject, E> {
        Ok(OneProject::default())
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<OneProject, E> {
        Ok(OneProject::default())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<OneProject, E> {
        Ok(OneProject::default())
    }
    fn visit_unit<E: de::Error>(self) -> Result<OneProject, E> {
        Ok(OneProject::default())
    }
}

// ── the four config files ─────────────────────────────────────────────────

/// Claude Code `~/.claude.json`. Every other top-level key (account, OAuth,
/// history, ...) is skipped by serde's derive with `IgnoredAny`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ClaudeCodeFile {
    #[serde(rename = "mcpServers")]
    mcp_servers: ServerMap,
    projects: ProjectServers,
}

/// Claude Desktop `claude_desktop_config.json` and Cursor `mcp.json`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct McpServersFile {
    #[serde(rename = "mcpServers")]
    mcp_servers: ServerMap,
}

/// Codex `config.toml`: only the `[mcp_servers.*]` tables.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CodexFile {
    mcp_servers: ServerMap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigKind {
    ClaudeCode,
    ClaudeDesktop,
    Cursor,
    Codex,
}

impl ConfigKind {
    fn tool(self) -> &'static str {
        match self {
            ConfigKind::ClaudeCode => "claude_code",
            ConfigKind::ClaudeDesktop => "claude_desktop",
            ConfigKind::Cursor => "cursor",
            ConfigKind::Codex => "codex",
        }
    }
}

/// Read one config file and return its servers, names and hosts only.
fn read_config(
    kind: ConfigKind,
    path: Option<&Path>,
) -> (Vec<FoundMcpServer>, SourceOutcome, bool) {
    let outcome = |outcome: &'static str, count: u32| SourceOutcome {
        source: kind.tool(),
        outcome,
        count,
    };
    let Some(path) = path else {
        return (Vec::new(), outcome("missing", 0), false);
    };
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            if meta.len() > CONFIG_BYTES_MAX {
                return (Vec::new(), outcome("budget", 0), true);
            }
        }
        Ok(_) => return (Vec::new(), outcome("missing", 0), false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), outcome("missing", 0), false)
        }
        Err(_) => return (Vec::new(), outcome("unreadable", 0), false),
    }
    // Bounded read: the file can grow between the size check and the read.
    let Some(bytes) = read_bounded(path, CONFIG_BYTES_MAX) else {
        return (Vec::new(), outcome("unreadable", 0), false);
    };
    if bytes.len() as u64 > CONFIG_BYTES_MAX {
        return (Vec::new(), outcome("budget", 0), true);
    }
    let parsed = parse_config(kind, &bytes);
    // The raw buffer is dropped here; nothing above kept a copy of it.
    drop(bytes);
    let Some(map) = parsed else {
        return (Vec::new(), outcome("invalid", 0), false);
    };
    let truncated = map.truncated;
    let servers = found_servers(kind, map.servers);
    let count = u32::try_from(servers.len()).unwrap_or(u32::MAX);
    (servers, outcome("read", count), truncated)
}

/// Read at most `max + 1` bytes, so a file over the cap is detected without
/// reading the rest of it.
fn read_bounded(path: &Path, max: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// Parse a config's bytes into its server map, or `None` when the file is
/// not valid JSON/TOML. Errors are discarded unread: a parser error can quote
/// the input.
fn parse_config(kind: ConfigKind, bytes: &[u8]) -> Option<ServerMap> {
    match kind {
        ConfigKind::ClaudeCode => {
            let file: ClaudeCodeFile = serde_json::from_slice(bytes).ok()?;
            let mut map = file.mcp_servers;
            map.truncated |= file.projects.0.truncated;
            map.servers.extend(file.projects.0.servers);
            Some(map)
        }
        ConfigKind::ClaudeDesktop | ConfigKind::Cursor => {
            let file: McpServersFile = serde_json::from_slice(bytes).ok()?;
            Some(file.mcp_servers)
        }
        ConfigKind::Codex => {
            let text = std::str::from_utf8(bytes).ok()?;
            let file: CodexFile = toml::from_str(text).ok()?;
            Some(file.mcp_servers)
        }
    }
}

fn found_servers(kind: ConfigKind, raw: Vec<(String, RawServer)>) -> Vec<FoundMcpServer> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (name, server) in raw {
        let Some(name) = clean_name(&name) else {
            continue;
        };
        let transport = transport_of(&server);
        let (host, local) = match &server.url {
            Some(info) => (info.host.clone(), info.local),
            None => (None, false),
        };
        let found = FoundMcpServer {
            tool: kind.tool(),
            name,
            transport,
            host,
            local,
            has_credential_fields: server.has_credential_fields,
            enabled: server.enabled.unwrap_or(true),
        };
        let key = (found.name.clone(), found.host.clone(), found.transport);
        if seen.insert(key) {
            out.push(found);
        }
    }
    out
}

fn transport_of(server: &RawServer) -> &'static str {
    match server
        .kind
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("http")
        | Some("streamable-http")
        | Some("streamable_http")
        | Some("streamablehttp") => "http",
        Some("sse") => "sse",
        Some("stdio") => "stdio",
        _ if server.url.is_some() => "http",
        _ if server.has_command => "stdio",
        _ => "unknown",
    }
}

/// The host of a URL and whether it is local. The scheme, userinfo, port,
/// path, query and fragment are never kept.
fn host_info(raw: &str) -> HostInfo {
    let Ok(parsed) = url::Url::parse(raw.trim()) else {
        return HostInfo {
            host: None,
            local: false,
        };
    };
    match parsed.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            let local = domain == "localhost"
                || domain.ends_with(".localhost")
                || domain.ends_with(".local")
                || domain.ends_with(".internal")
                || !domain.contains('.');
            if local {
                HostInfo {
                    host: None,
                    local: true,
                }
            } else {
                HostInfo {
                    host: Some(domain),
                    local: false,
                }
            }
        }
        Some(url::Host::Ipv4(ip)) => ip_host(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => ip_host(IpAddr::V6(ip)),
        None => HostInfo {
            host: None,
            local: false,
        },
    }
}

fn ip_host(ip: IpAddr) -> HostInfo {
    let local = match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    };
    if local {
        HostInfo {
            host: None,
            local: true,
        }
    } else {
        // A public IP literal names no app; keep only that it is remote.
        HostInfo {
            host: None,
            local: false,
        }
    }
}

/// One line, no control characters, at most [`NAME_MAX_CHARS`] characters.
fn clean_name(raw: &str) -> Option<String> {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        return None;
    }
    Some(flat.chars().take(NAME_MAX_CHARS).collect())
}

// ── where the config files are ────────────────────────────────────────────

/// Every location the scan reads, resolved once so tests can point it at a
/// fixture folder.
#[derive(Debug, Clone, Default)]
pub struct ScanRoots {
    pub app_dirs: Vec<PathBuf>,
    pub claude_code: Option<PathBuf>,
    pub claude_desktop: Option<PathBuf>,
    pub cursor: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    /// Windows only: `%LOCALAPPDATA%\Programs`.
    pub programs_dir: Option<PathBuf>,
}

impl ScanRoots {
    pub fn for_this_computer() -> Self {
        let home = dirs::home_dir();
        let claude_code = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .filter(|dir| dir.join(".claude.json").is_file())
            .map(|dir| dir.join(".claude.json"))
            .or_else(|| home.as_ref().map(|home| home.join(".claude.json")));
        let codex = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(".codex")))
            .map(|dir| dir.join("config.toml"));
        ScanRoots {
            app_dirs: app_dirs(home.as_deref()),
            claude_code,
            claude_desktop: claude_desktop_config_path(home.as_deref()),
            cursor: home
                .as_ref()
                .map(|home| home.join(".cursor").join("mcp.json")),
            codex,
            programs_dir: programs_dir(),
        }
    }
}

#[cfg(target_os = "macos")]
fn app_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
    ];
    if let Some(home) = home {
        dirs.push(home.join("Applications"));
    }
    dirs
}

#[cfg(not(target_os = "macos"))]
fn app_dirs(_home: Option<&Path>) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn claude_desktop_config_path(home: Option<&Path>) -> Option<PathBuf> {
    home.map(|home| home.join("Library/Application Support/Claude/claude_desktop_config.json"))
}

#[cfg(windows)]
fn claude_desktop_config_path(_home: Option<&Path>) -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|app_data| {
        PathBuf::from(app_data)
            .join("Claude")
            .join("claude_desktop_config.json")
    })
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn claude_desktop_config_path(home: Option<&Path>) -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".config")))
        .map(|config| config.join("Claude").join("claude_desktop_config.json"))
}

#[cfg(windows)]
fn programs_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("Programs"))
}

#[cfg(not(windows))]
fn programs_dir() -> Option<PathBuf> {
    None
}

// ── installed apps ────────────────────────────────────────────────────────

/// The three `Info.plist` keys read. Every other key is skipped by serde.
#[derive(Debug, Default, Deserialize)]
struct InfoPlist {
    #[serde(rename = "CFBundleIdentifier", default)]
    bundle_id: Option<String>,
    #[serde(rename = "CFBundleName", default)]
    bundle_name: Option<String>,
    #[serde(rename = "CFBundleDisplayName", default)]
    display_name: Option<String>,
}

struct AppScan {
    apps: Vec<FoundApp>,
    outcome: &'static str,
    truncated: bool,
}

/// List the `.app` bundles directly inside `dirs`, reading three plist keys.
fn scan_bundles(dirs: &[PathBuf], max_entries: usize, budget: Duration) -> AppScan {
    let started = Instant::now();
    let mut apps = BTreeSet::new();
    let mut visited = 0usize;
    let mut any_dir = false;
    let mut truncated = false;
    'dirs: for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        any_dir = true;
        for entry in entries.flatten() {
            if visited >= max_entries || started.elapsed() > budget {
                truncated = true;
                break 'dirs;
            }
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            visited += 1;
            if let Some(app) = read_bundle(&path) {
                apps.insert(app);
            }
        }
    }
    AppScan {
        apps: apps.into_iter().collect(),
        outcome: if !any_dir {
            "missing"
        } else if truncated {
            "budget"
        } else {
            "read"
        },
        truncated,
    }
}

fn read_bundle(path: &Path) -> Option<FoundApp> {
    let info: InfoPlist =
        plist::from_file(path.join("Contents").join("Info.plist")).unwrap_or_default();
    let bundle_id = info.bundle_id.and_then(|id| clean_name(&id));
    if bundle_id
        .as_deref()
        .is_some_and(|id| id.to_ascii_lowercase().starts_with("com.apple."))
    {
        return None;
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_owned);
    let name = info
        .display_name
        .or(info.bundle_name)
        .or(stem)
        .and_then(|name| clean_name(&name))?;
    Some(FoundApp { bundle_id, name })
}

/// Folder names directly under `%LOCALAPPDATA%\Programs` (Windows).
fn scan_program_dirs(dir: Option<&Path>, max_entries: usize) -> Vec<FoundApp> {
    let Some(dir) = dir else { return Vec::new() };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .take(max_entries)
        .filter_map(|entry| entry.file_name().to_str().and_then(clean_name))
        .map(|name| FoundApp {
            bundle_id: None,
            name,
        })
        .collect()
}

#[cfg(windows)]
fn scan_uninstall_registry(max_entries: usize, budget: Duration) -> (Vec<FoundApp>, bool) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const UNINSTALL_WOW64: &str =
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    let roots = [
        (RegKey::predef(HKEY_LOCAL_MACHINE), UNINSTALL),
        (RegKey::predef(HKEY_LOCAL_MACHINE), UNINSTALL_WOW64),
        (RegKey::predef(HKEY_CURRENT_USER), UNINSTALL),
    ];
    let started = Instant::now();
    let mut out = Vec::new();
    let mut visited = 0usize;
    for (hive, path) in roots {
        let Ok(root) = hive.open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        for name in root.enum_keys().flatten() {
            if visited >= max_entries || started.elapsed() > budget {
                return (out, true);
            }
            visited += 1;
            let Ok(entry) = root.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            // Only DisplayName is read from each entry.
            let Ok(display) = entry.get_value::<String, _>("DisplayName") else {
                continue;
            };
            if let Some(name) = clean_name(&display) {
                out.push(FoundApp {
                    bundle_id: None,
                    name,
                });
            }
        }
    }
    (out, false)
}

fn installed_apps(roots: &ScanRoots) -> AppScan {
    let has_registry = cfg!(windows);
    if roots.app_dirs.is_empty() && roots.programs_dir.is_none() && !has_registry {
        return AppScan {
            apps: Vec::new(),
            outcome: "unsupported",
            truncated: false,
        };
    }
    // macOS bundles (empty list elsewhere), then the Windows sources.
    let mut scan = scan_bundles(&roots.app_dirs, APP_ENTRY_MAX, APP_SCAN_BUDGET);
    #[allow(unused_mut)]
    let mut extra = scan_program_dirs(roots.programs_dir.as_deref(), APP_ENTRY_MAX);
    #[cfg(windows)]
    {
        let (registry, cut) = scan_uninstall_registry(APP_ENTRY_MAX, APP_SCAN_BUDGET);
        extra.extend(registry);
        if cut {
            scan.truncated = true;
            scan.outcome = "budget";
        }
    }
    if has_registry && scan.outcome == "missing" {
        scan.outcome = "read";
    }
    if !extra.is_empty() {
        let mut all: BTreeSet<FoundApp> = scan.apps.into_iter().collect();
        all.extend(extra);
        scan.apps = all.into_iter().collect();
        if scan.outcome == "missing" {
            scan.outcome = "read";
        }
    }
    scan
}

// ── the command ───────────────────────────────────────────────────────────

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Run the whole scan against `roots`. Blocking.
pub fn detect_work_apps_in(roots: &ScanRoots) -> FoundWorkApps {
    let app_scan = installed_apps(roots);
    let mut sources = vec![SourceOutcome {
        source: "apps",
        outcome: app_scan.outcome,
        count: u32::try_from(app_scan.apps.len()).unwrap_or(u32::MAX),
    }];
    let mut truncated = app_scan.truncated;
    let mut mcp_servers = Vec::new();
    for (kind, path) in [
        (ConfigKind::ClaudeCode, roots.claude_code.as_deref()),
        (ConfigKind::ClaudeDesktop, roots.claude_desktop.as_deref()),
        (ConfigKind::Cursor, roots.cursor.as_deref()),
        (ConfigKind::Codex, roots.codex.as_deref()),
    ] {
        let (servers, outcome, cut) = read_config(kind, path);
        truncated |= cut;
        mcp_servers.extend(servers);
        sources.push(outcome);
    }
    FoundWorkApps {
        platform: platform(),
        scanned_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0),
        apps: app_scan.apps,
        mcp_servers,
        sources,
        truncated,
    }
}

/// The log line: outcomes and counts only, never a name or a host.
fn log_line(found: &FoundWorkApps) -> String {
    let sources = found
        .sources
        .iter()
        .map(|s| format!("{}={}:{}", s.source, s.outcome, s.count))
        .collect::<Vec<_>>()
        .join(" ");
    format!("detect_work_apps {sources} truncated={}", found.truncated)
}

pub fn detect_work_apps_blocking() -> FoundWorkApps {
    let found = detect_work_apps_in(&ScanRoots::for_this_computer());
    crate::util::logfile::log("work-apps", &log_line(&found));
    found
}

/// Names-only scan of this computer's work apps for the first-run "Your
/// apps" view. Runs on the blocking pool, like `detect_ai_tools`: it reads
/// directories and files and must never hold the main thread.
#[tauri::command]
pub async fn detect_work_apps() -> FoundWorkApps {
    match tokio::task::spawn_blocking(detect_work_apps_blocking).await {
        Ok(found) => found,
        Err(error) => {
            crate::util::logfile::log(
                "work-apps",
                &format!("detect_work_apps blocking task failed ({error}); probing inline"),
            );
            detect_work_apps_blocking()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Secret-shaped values put in every field the detector must never read.
    const SECRETS: [&str; 9] = [
        "SECRET_URL_QUERY_7f3a",
        "SECRET_URL_USER_19c2",
        "SECRET_URL_PATH_88d1",
        "SECRET_HEADER_4b2e",
        "SECRET_ENV_a91f",
        "SECRET_ARG_5c7d",
        "SECRET_COMMAND_e2b0",
        "SECRET_BEARER_VAR_0d6c",
        "SECRET_PROJECT_PATH_33aa",
    ];

    fn write(dir: &Path, rel: &str, body: &str) -> PathBuf {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    fn assert_no_secrets(found: &FoundWorkApps) {
        let out = serde_json::to_string(found).unwrap();
        for secret in SECRETS {
            assert!(!out.contains(secret), "output leaked {secret}: {out}");
        }
        let debug = format!("{found:?}");
        for secret in SECRETS {
            assert!(!debug.contains(secret), "debug output leaked {secret}");
        }
    }

    fn roots_with(dir: &Path) -> ScanRoots {
        ScanRoots {
            app_dirs: Vec::new(),
            claude_code: Some(dir.join(".claude.json")),
            claude_desktop: Some(dir.join("claude_desktop_config.json")),
            cursor: Some(dir.join(".cursor/mcp.json")),
            codex: Some(dir.join(".codex/config.toml")),
            programs_dir: None,
        }
    }

    const CLAUDE_CODE: &str = r#"{
      "oauthAccount": { "emailAddress": "someone@example.test", "accessToken": "SECRET_HEADER_4b2e" },
      "mcpServers": {
        "linear": {
          "type": "http",
          "url": "https://SECRET_URL_USER_19c2:pw@mcp.linear.app/SECRET_URL_PATH_88d1?token=SECRET_URL_QUERY_7f3a",
          "headers": { "Authorization": "Bearer SECRET_HEADER_4b2e" }
        },
        "supabase": {
          "command": "SECRET_COMMAND_e2b0",
          "args": ["-y", "@supabase/mcp-server-supabase", "--access-token", "SECRET_ARG_5c7d"],
          "env": { "SUPABASE_ACCESS_TOKEN": "SECRET_ENV_a91f" }
        },
        "local-tool": { "type": "http", "url": "http://localhost:3845/mcp" }
      },
      "projects": {
        "/Users/someone/SECRET_PROJECT_PATH_33aa": {
          "history": ["SECRET_ARG_5c7d"],
          "mcpServers": {
            "posthog": { "type": "sse", "url": "https://mcp.posthog.com/sse", "env": { "K": "SECRET_ENV_a91f" } }
          }
        }
      }
    }"#;

    const CODEX: &str = r#"
model = "SECRET_ARG_5c7d"

[mcp_servers.supabase]
command = "SECRET_COMMAND_e2b0"
args = ["--access-token", "SECRET_ARG_5c7d"]
env = { SUPABASE_ACCESS_TOKEN = "SECRET_ENV_a91f" }

[mcp_servers.notion]
url = "https://mcp.notion.com/mcp?key=SECRET_URL_QUERY_7f3a"
bearer_token_env_var = "SECRET_BEARER_VAR_0d6c"
http_headers = { "X-Key" = "SECRET_HEADER_4b2e" }
enabled = false

[mcp_servers.plain]
url = "https://api.example-docs.dev/mcp"
startup_timeout_sec = 20
"#;

    #[test]
    fn never_reads_env_headers_args_or_url_secrets() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".claude.json", CLAUDE_CODE);
        write(
            dir.path(),
            "claude_desktop_config.json",
            r#"{"mcpServers":{"github":{"command":"SECRET_COMMAND_e2b0","args":["SECRET_ARG_5c7d"],"env":{"GITHUB_TOKEN":"SECRET_ENV_a91f"}}},"globalShortcut":"x"}"#,
        );
        write(
            dir.path(),
            ".cursor/mcp.json",
            r#"{"mcpServers":{"sentry":{"url":"https://mcp.sentry.dev/mcp/SECRET_URL_PATH_88d1","headers":{"Authorization":"SECRET_HEADER_4b2e"}}}}"#,
        );
        write(dir.path(), ".codex/config.toml", CODEX);

        let found = detect_work_apps_in(&roots_with(dir.path()));
        assert_no_secrets(&found);

        let by = |tool: &str, name: &str| {
            found
                .mcp_servers
                .iter()
                .find(|s| s.tool == tool && s.name == name)
                .unwrap_or_else(|| panic!("{tool}/{name} missing"))
                .clone()
        };
        let linear = by("claude_code", "linear");
        assert_eq!(linear.host.as_deref(), Some("mcp.linear.app"));
        assert_eq!(linear.transport, "http");
        assert!(linear.has_credential_fields);
        let supabase = by("claude_code", "supabase");
        assert_eq!(supabase.transport, "stdio");
        assert_eq!(supabase.host, None);
        assert!(supabase.has_credential_fields);
        let local = by("claude_code", "local-tool");
        assert!(local.local);
        assert_eq!(local.host, None);
        let posthog = by("claude_code", "posthog");
        assert_eq!(posthog.transport, "sse");
        assert_eq!(posthog.host.as_deref(), Some("mcp.posthog.com"));

        assert_eq!(by("claude_desktop", "github").transport, "stdio");
        assert_eq!(
            by("cursor", "sentry").host.as_deref(),
            Some("mcp.sentry.dev")
        );

        let notion = by("codex", "notion");
        assert_eq!(notion.host.as_deref(), Some("mcp.notion.com"));
        assert!(notion.has_credential_fields);
        assert!(!notion.enabled);
        let plain = by("codex", "plain");
        assert!(!plain.has_credential_fields);
        assert!(plain.enabled);
        assert!(by("codex", "supabase").has_credential_fields);

        let outcomes: Vec<_> = found
            .sources
            .iter()
            .map(|s| (s.source, s.outcome, s.count))
            .collect();
        assert!(outcomes.contains(&("claude_code", "read", 4)));
        assert!(outcomes.contains(&("claude_desktop", "read", 1)));
        assert!(outcomes.contains(&("cursor", "read", 1)));
        assert!(outcomes.contains(&("codex", "read", 3)));
        assert!(!log_line(&found).contains("linear"));
    }

    /// The fields that may hold secrets are stepped over, never interpreted:
    /// shapes no string reader would accept still parse, and the server keeps
    /// only the presence flag.
    #[test]
    fn secret_fields_are_skipped_not_interpreted() {
        let entry: RawServer = serde_json::from_str(
            r#"{"env": 42, "headers": [1, {"a": [true, null]}], "args": {"nested": {"deep": "SECRET_ARG_5c7d"}},
                "http_headers": null, "url": "https://mcp.example.com/x"}"#,
        )
        .unwrap();
        assert!(entry.has_credential_fields);
        assert_eq!(
            entry.url,
            Some(HostInfo {
                host: Some("mcp.example.com".into()),
                local: false
            })
        );
        assert!(!format!("{entry:?}").contains("SECRET_ARG_5c7d"));

        let toml_entry: CodexFile = toml::from_str(
            "[mcp_servers.x]\nargs = [[1, 2], { a = 1 }]\nenv = 7\nhttp_headers = [\"SECRET_HEADER_4b2e\"]\n",
        )
        .unwrap();
        let (name, server) = &toml_entry.mcp_servers.servers[0];
        assert_eq!(name, "x");
        assert!(server.has_credential_fields);
        assert!(!format!("{server:?}").contains("SECRET_HEADER_4b2e"));
    }

    #[test]
    fn odd_shapes_read_as_empty_not_as_failures() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".claude.json",
            r#"{"mcpServers": ["not", "a", "map"], "projects": 5}"#,
        );
        write(
            dir.path(),
            "claude_desktop_config.json",
            r#"{"mcpServers": {"bad": "string entry", "ok": {"url": 9}}}"#,
        );
        write(dir.path(), ".cursor/mcp.json", "{ not json");
        let found = detect_work_apps_in(&roots_with(dir.path()));
        let outcome = |source: &str| {
            found
                .sources
                .iter()
                .find(|s| s.source == source)
                .unwrap()
                .clone()
        };
        assert_eq!(outcome("claude_code").outcome, "read");
        assert_eq!(outcome("claude_code").count, 0);
        assert_eq!(outcome("claude_desktop").count, 2);
        assert_eq!(outcome("cursor").outcome, "invalid");
        assert_eq!(outcome("codex").outcome, "missing");
        let ok = found.mcp_servers.iter().find(|s| s.name == "ok").unwrap();
        assert_eq!((ok.host.as_deref(), ok.transport), (None, "unknown"));
    }

    #[test]
    fn invalid_toml_is_invalid_and_quotes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".codex/config.toml",
            "[mcp_servers.x\nenv = \"SECRET_ENV_a91f\"",
        );
        let found = detect_work_apps_in(&roots_with(dir.path()));
        assert_eq!(
            found
                .sources
                .iter()
                .find(|s| s.source == "codex")
                .unwrap()
                .outcome,
            "invalid"
        );
        assert_no_secrets(&found);
    }

    #[test]
    fn oversized_config_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(CONFIG_BYTES_MAX + 1).unwrap();
        let (servers, outcome, truncated) = read_config(ConfigKind::ClaudeCode, Some(&path));
        assert!(servers.is_empty());
        assert_eq!(outcome.outcome, "budget");
        assert!(truncated);
    }

    #[test]
    fn server_count_is_capped_per_file() {
        let mut body = String::from("{\"mcpServers\":{");
        for i in 0..(SERVERS_PER_FILE_MAX + 5) {
            if i > 0 {
                body.push(',');
            }
            body.push_str(&format!(
                "\"s{i}\":{{\"url\":\"https://h{i}.example.com\"}}"
            ));
        }
        body.push_str("}}");
        let map = parse_config(ConfigKind::Cursor, body.as_bytes()).unwrap();
        assert_eq!(map.servers.len(), SERVERS_PER_FILE_MAX);
        assert!(map.truncated);
    }

    #[test]
    fn host_info_keeps_only_public_hosts() {
        assert_eq!(
            host_info("https://u:p@Mcp.Linear.App:8443/a?b=c#d")
                .host
                .as_deref(),
            Some("mcp.linear.app")
        );
        for local in [
            "http://localhost:1/x",
            "http://127.0.0.1/x",
            "http://10.1.2.3/x",
            "http://192.168.0.4/x",
            "http://[::1]/x",
            "http://[fd00::1]/x",
            "http://printer.local/x",
            "http://devbox/x",
        ] {
            let info = host_info(local);
            assert!(info.local, "{local}");
            assert_eq!(info.host, None, "{local}");
        }
        assert_eq!(
            host_info("http://8.8.8.8/x"),
            HostInfo {
                host: None,
                local: false
            }
        );
        assert_eq!(
            host_info("not a url"),
            HostInfo {
                host: None,
                local: false
            }
        );
    }

    #[test]
    fn names_are_one_line_and_capped() {
        assert_eq!(clean_name("  a\tb\n c ").as_deref(), Some("a b c"));
        assert_eq!(clean_name("\u{7}\u{1b}"), None);
        assert_eq!(
            clean_name(&"x".repeat(100)).unwrap().chars().count(),
            NAME_MAX_CHARS
        );
    }

    #[test]
    fn duplicate_servers_in_one_file_are_listed_once() {
        let body = r#"{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}},
            "projects":{"/a":{"mcpServers":{"linear":{"url":"https://mcp.linear.app/sse"}}},
                        "/b":{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}}}"#;
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), ".claude.json", body);
        let (servers, _, _) = read_config(ConfigKind::ClaudeCode, Some(&path));
        assert_eq!(servers.len(), 1);
    }

    fn bundle(dir: &Path, name: &str, plist: Option<&str>) {
        let app = dir.join(format!("{name}.app"));
        fs::create_dir_all(app.join("Contents")).unwrap();
        if let Some(plist) = plist {
            fs::write(app.join("Contents/Info.plist"), plist).unwrap();
        }
    }

    fn plist_xml(id: &str, name: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{id}</string>
<key>CFBundleName</key><string>{name}</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>SECRET_ARG_5c7d</string></array></dict></array>
</dict></plist>"#
        )
    }

    #[test]
    fn bundles_read_three_keys_and_drop_apple_apps() {
        let dir = tempfile::tempdir().unwrap();
        bundle(
            dir.path(),
            "Linear",
            Some(&plist_xml("com.linear", "Linear")),
        );
        bundle(
            dir.path(),
            "Safari",
            Some(&plist_xml("com.apple.Safari", "Safari")),
        );
        bundle(
            dir.path(),
            "Zoom",
            Some(&plist_xml("us.zoom.xos", "zoom.us")),
        );
        bundle(dir.path(), "NoPlist", None);
        fs::create_dir_all(dir.path().join("NotAnApp")).unwrap();
        let scan = scan_bundles(
            &[dir.path().to_path_buf(), dir.path().join("missing")],
            50,
            Duration::from_secs(5),
        );
        assert_eq!(scan.outcome, "read");
        let names: Vec<_> = scan
            .apps
            .iter()
            .map(|a| (a.bundle_id.as_deref(), a.name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                (None, "NoPlist"),
                (Some("com.linear"), "Linear"),
                (Some("us.zoom.xos"), "zoom.us")
            ]
        );
        assert!(!format!("{:?}", scan.apps).contains("SECRET_ARG_5c7d"));
    }

    #[test]
    fn bundle_listing_stops_at_the_entry_cap() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            bundle(
                dir.path(),
                &format!("App{i}"),
                Some(&plist_xml(&format!("dev.example.app{i}"), "x")),
            );
        }
        let scan = scan_bundles(&[dir.path().to_path_buf()], 3, Duration::from_secs(5));
        assert!(scan.truncated);
        assert_eq!(scan.outcome, "budget");
        assert_eq!(scan.apps.len(), 3);
        let none = scan_bundles(&[dir.path().join("nope")], 3, Duration::from_secs(5));
        assert_eq!(none.outcome, "missing");
    }

    #[test]
    fn program_folders_are_names_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Microsoft Teams")).unwrap();
        fs::write(dir.path().join("readme.txt"), "x").unwrap();
        let apps = scan_program_dirs(Some(dir.path()), 10);
        assert_eq!(
            apps,
            vec![FoundApp {
                bundle_id: None,
                name: "Microsoft Teams".into()
            }]
        );
    }

    #[test]
    fn installed_apps_merges_bundles_and_program_folders() {
        let dir = tempfile::tempdir().unwrap();
        let apps_dir = dir.path().join("Applications");
        bundle(
            &apps_dir,
            "Linear",
            Some(&plist_xml("com.linear", "Linear")),
        );
        let programs = dir.path().join("Programs");
        fs::create_dir_all(programs.join("Slack")).unwrap();
        let roots = ScanRoots {
            app_dirs: vec![apps_dir],
            programs_dir: Some(programs),
            ..ScanRoots::default()
        };
        let scan = installed_apps(&roots);
        assert_eq!(scan.outcome, "read");
        let names: Vec<_> = scan.apps.iter().map(|a| a.name.as_str()).collect();
        assert!(
            names.contains(&"Slack") && names.contains(&"Linear"),
            "{names:?}"
        );
        if !cfg!(windows) {
            assert_eq!(names, vec!["Slack", "Linear"]);
            assert_eq!(installed_apps(&ScanRoots::default()).outcome, "unsupported");
        }
    }

    #[test]
    fn serializes_camel_case_shape() {
        let found = FoundWorkApps {
            platform: "macos",
            scanned_at_ms: 1,
            apps: vec![FoundApp {
                bundle_id: Some("com.linear".into()),
                name: "Linear".into(),
            }],
            mcp_servers: vec![FoundMcpServer {
                tool: "codex",
                name: "notion".into(),
                transport: "http",
                host: Some("mcp.notion.com".into()),
                local: false,
                has_credential_fields: true,
                enabled: true,
            }],
            sources: vec![SourceOutcome {
                source: "codex",
                outcome: "read",
                count: 1,
            }],
            truncated: false,
        };
        let json = serde_json::to_value(&found).unwrap();
        assert_eq!(json["scannedAtMs"], 1);
        assert_eq!(json["apps"][0]["bundleId"], "com.linear");
        assert_eq!(json["mcpServers"][0]["hasCredentialFields"], true);
        assert_eq!(json["sources"][0]["outcome"], "read");
    }
}
