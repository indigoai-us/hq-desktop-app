//! Captures a local fixture page through the real hidden-window pipeline and
//! checks the PNG. macOS only; other platforms have no capture and the panel
//! uses the og:image fallback there.

#[allow(dead_code, unused_imports)]
#[path = "../src/commands/deploy_snapshot.rs"]
mod deploy_snapshot;

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("deploy_snapshot_capture: skipped, capture is macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const PAGE: &str = "<!doctype html><html><head><title>fixture</title></head>\
        <body style=\"margin:0;background:#d23b3b;font:64px sans-serif;color:#fff\">\
        <h1 style=\"margin:80px\">Snapshot fixture</h1></body></html>";

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{PAGE}",
                PAGE.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });

    let app = tauri::Builder::<tauri::Wry>::new()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build tauri app");
    type Outcome = Option<Result<Vec<u8>, String>>;
    let outcome: Arc<Mutex<Outcome>> = Arc::new(Mutex::new(None));
    let slot = outcome.clone();
    let mut started = false;
    // DEPLOY_SNAPSHOT_URL lets a developer capture a real page by hand.
    let url = url::Url::parse(
        &std::env::var("DEPLOY_SNAPSHOT_URL").unwrap_or(format!("http://127.0.0.1:{port}/")),
    )
    .unwrap();
    let code = app.run_return(move |handle, event| {
        if matches!(event, tauri::RunEvent::Ready) && !started {
            started = true;
            let handle = handle.clone();
            let slot = slot.clone();
            let url = url.clone();
            tauri::async_runtime::spawn(async move {
                let result =
                    deploy_snapshot::capture_page(&handle, url, Duration::from_secs(20), true)
                        .await;
                *slot.lock().unwrap() = Some(result);
                handle.exit(0);
            });
        }
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            // Closing the hidden window must not end the run before the result lands.
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
    assert_eq!(code, 0);
    let png = outcome
        .lock()
        .unwrap()
        .take()
        .expect("capture finished")
        .expect("capture succeeded");
    assert!(png.len() > 1000, "png is {} bytes", png.len());
    assert_eq!(
        deploy_snapshot::png_dimensions(&png),
        Some((
            deploy_snapshot::VIEW_WIDTH * 2,
            deploy_snapshot::VIEW_HEIGHT * 2
        ))
    );
    if let Ok(out) = std::env::var("DEPLOY_SNAPSHOT_OUT") {
        std::fs::write(out, &png).unwrap();
    }
    println!("deploy_snapshot_capture: ok, {} bytes", png.len());
}
