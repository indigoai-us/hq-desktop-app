//! One-off repro binary for the sidebar "Companies" home-channel resolution
//! bug (Indigo/Liverecover show "..." then "Retry"). Reuses the app's own
//! cognito token loader + build_client(), same as decode_repro.rs. Fetches
//! `GET /v1/notify/channels` (the plain call the sidebar's
//! `resolveCompanyHomeOnce` actually issues — `includeCompanyProjects: false`
//! means the Rust command never appends `companyUid` to the URL, so this is
//! byte-identical to the real request), then reports, per target company
//! slug, the shape of any `scope: "company"` channel: name, isCompanyHome
//! (present? value?), companyUid. Never prints full channel names beyond the
//! slug match, member lists, or tokens.
//! Run with: cargo run -p hq-desktop-core --example companyhome_repro

use hq_desktop_core::client_info::build_client;
use hq_desktop_core::cognito;

const TARGET_SLUGS: &[&str] = &["indigo", "liverecover"];

#[tokio::main]
async fn main() {
    let base = std::env::var("HQ_VAULT_API_URL")
        .unwrap_or_else(|_| "https://hqapi.hq.computer".to_string());
    let base = base.trim_end_matches('/').to_string();

    let token = match cognito::get_valid_access_token().await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("auth failed: {e}");
            std::process::exit(1);
        }
    };

    let url = format!("{base}/v1/notify/channels");
    println!("=== GET /v1/notify/channels (plain, no companyUid — matches resolveCompanyHomeOnce) ===");
    let resp = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("send failed");
    println!("status: {}", resp.status());
    let body: serde_json::Value = resp.json().await.expect("parse failed");
    let channels = body.get("channels").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    println!("total channels: {}", channels.len());

    for slug in TARGET_SLUGS {
        println!("\n--- target slug: {slug} ---");
        let mut found_company_scope = 0;
        for ch in &channels {
            let scope = ch.get("scope").and_then(|v| v.as_str()).unwrap_or("");
            if scope != "company" {
                continue;
            }
            let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let normalized = name.trim().trim_start_matches('#').trim().to_lowercase();
            if normalized != *slug {
                continue;
            }
            found_company_scope += 1;
            let is_company_home = ch.get("isCompanyHome");
            let company_uid = ch.get("companyUid").and_then(|v| v.as_str()).unwrap_or("<absent>");
            let channel_id = ch.get("channelId").and_then(|v| v.as_str()).unwrap_or("<absent>");
            println!(
                "  match: name={name:?} channelId={channel_id} scope={scope} companyUid={company_uid} isCompanyHome_present={} isCompanyHome_value={:?}",
                is_company_home.is_some(),
                is_company_home
            );
        }
        if found_company_scope == 0 {
            println!("  NO scope:company channel named #{slug} found in the full roster");
        }
    }
}
