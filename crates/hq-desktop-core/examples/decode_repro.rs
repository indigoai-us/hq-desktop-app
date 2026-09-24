//! One-off repro binary for the `error decoding response body` reports in
//! `~/.hq/logs/hq-sync.log` (dm_notify poll_channels + messages get_json).
//! Reuses the app's own cognito token loader + build_client() so the request
//! is byte-identical to the real poll. Prints status/headers/size and the
//! first/last bytes of the raw body — never the auth header, never full
//! message content. Run with: cargo run -p hq-desktop-core --example decode_repro

use hq_desktop_core::client_info::build_client;
use hq_desktop_core::cognito;

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

    for path in ["/v1/notify/channels", "/v1/notify/inbox"] {
        let url = format!("{base}{path}");
        println!("=== GET {path} ===");
        let resp = build_client()
            .get(&url)
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                println!("send() failed: {e}");
                continue;
            }
        };
        println!("status: {}", resp.status());
        for name in [
            "content-length",
            "content-encoding",
            "transfer-encoding",
            "content-type",
            "vary",
        ] {
            if let Some(v) = resp.headers().get(name) {
                println!("{name}: {}", v.to_str().unwrap_or("<non-ascii>"));
            }
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                println!("bytes() failed: {e}");
                if let Some(src) = std::error::Error::source(&e) {
                    println!("  source: {src}");
                    let mut cur = src.source();
                    while let Some(s) = cur {
                        println!("  source: {s}");
                        cur = s.source();
                    }
                }
                continue;
            }
        };
        println!("byte_len: {}", bytes.len());
        let head: Vec<u8> = bytes.iter().take(200).copied().collect();
        let tail: Vec<u8> = bytes
            .iter()
            .rev()
            .take(200)
            .rev()
            .copied()
            .collect();
        println!("head_hex: {}", hex_string(&head));
        println!("tail_hex: {}", hex_string(&tail));
        match std::str::from_utf8(&bytes) {
            Ok(s) => match serde_json::from_str::<serde_json::Value>(s) {
                Ok(_) => println!("parses as JSON: yes"),
                Err(e) => println!("parses as JSON: no ({e})"),
            },
            Err(e) => println!("valid utf8: no ({e})"),
        }
        println!();
    }
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
