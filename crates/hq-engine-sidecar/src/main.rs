use std::path::PathBuf;
use std::sync::Arc;

use hq_engine::{CoreBackend, Engine};
use hq_engine_sidecar::{event_supervisor_for_bus, run_session_with_supervisor};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let options = runtime_options_from(std::env::args());
    let backend = options
        .state_root
        .map_or_else(CoreBackend::default, |root| {
            CoreBackend::with_roots(
                &root,
                root.join(".claude").join("projects"),
                root.join(".codex"),
            )
        });
    let event_bus = backend.event_bus();
    let engine = Arc::new(Engine::new(options.application_version, backend));
    let supervisor = event_supervisor_for_bus(&event_bus, 256);
    let mut stdout = tokio::io::stdout();

    if let Err(error) = run_session_with_supervisor(
        tokio::io::stdin(),
        &mut stdout,
        engine,
        supervisor,
        |message| {
            eprintln!("{message}");
        },
    )
    .await
    {
        eprintln!("hq-engine-sidecar failed: {error}");
        std::process::exit(1);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeOptions {
    application_version: String,
    state_root: Option<PathBuf>,
}

fn runtime_options_from<I, S>(arguments: I) -> RuntimeOptions
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = arguments.into_iter().map(Into::into).skip(1);
    let mut application_version = None;
    let mut state_root = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--application-version" => {
                application_version = args.next().filter(|value| !value.trim().is_empty());
            }
            "--state-root" => {
                state_root = args
                    .next()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from);
            }
            _ => {}
        }
    }

    RuntimeOptions {
        application_version: application_version.unwrap_or_else(|| {
            std::env::var("HQ_APPLICATION_VERSION")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
        }),
        state_root,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_options_accept_an_explicit_isolated_state_root() {
        let options = runtime_options_from([
            "hq-engine-sidecar",
            "--application-version",
            "0.10.21",
            "--state-root",
            "/tmp/hq-native-engine-test",
        ]);

        assert_eq!(options.application_version, "0.10.21");
        assert_eq!(
            options.state_root.as_deref(),
            Some(std::path::Path::new("/tmp/hq-native-engine-test"))
        );
    }
}
