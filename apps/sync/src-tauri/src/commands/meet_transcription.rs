//! Local-only, bounded speech recognition using whisper.cpp. No microphone is
//! opened here: the call supplies post-mute PCM from its existing capture.
use serde::Serialize;
use std::{path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};
use tokio::sync::Semaphore;

const RATE: u32 = 16_000;
const MAX_SAMPLES: usize = RATE as usize * 10;
static WORKER: OnceLock<Semaphore> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    ready: bool,
    engine: &'static str,
    reason: Option<String>,
}
#[derive(Serialize)]
pub struct Transcript {
    text: String,
}

fn runtime_paths() -> Result<(PathBuf, PathBuf), String> {
    let root = dirs::data_dir()
        .ok_or("Cannot find application data directory")?
        .join("HQ/meet-asr");
    Ok((
        root.join(if cfg!(windows) {
            "whisper-cli.exe"
        } else {
            "whisper-cli"
        }),
        root.join("ggml-base.en.bin"),
    ))
}
fn installed(binary: &std::path::Path, model: &std::path::Path) -> bool {
    let Ok(executable) = std::fs::metadata(binary) else {
        return false;
    };
    let Ok(weights) = std::fs::metadata(model) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    executable.is_file()
        && executable.len() > 0
        && weights.is_file()
        && weights.len() == 147_964_211
}
#[tauri::command]
pub fn meet_transcription_status() -> Readiness {
    let reason = match runtime_paths() {
        Ok((binary, model)) if installed(&binary, &model) => None,
        Ok(_) => Some("Local speech model is not installed. Run scripts/install-meet-asr.sh in the desktop project.".into()),
        Err(error) => Some(error),
    };
    Readiness {
        ready: reason.is_none(),
        engine: "whisper.cpp/base.en",
        reason,
    }
}

fn wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    if sample_rate != RATE
        || samples.is_empty()
        || samples.len() > MAX_SAMPLES
        || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0)
    {
        return Err("Expected 1–160000 finite mono PCM samples at 16000 Hz, in [-1, 1]".into());
    }
    let size = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(size + 36).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&RATE.to_le_bytes());
    bytes.extend_from_slice(&(RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&((sample * 32767.0).round() as i16).to_le_bytes());
    }
    Ok(bytes)
}
struct AudioFile(PathBuf);
impl Drop for AudioFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub async fn meet_transcribe_pcm(
    window: tauri::WebviewWindow,
    samples: Vec<f32>,
    sample_rate: u32,
) -> Result<Transcript, String> {
    if window.label() != "call" {
        return Err("Recognition is only available in a call window".into());
    }
    let bytes = wav(&samples, sample_rate)?;
    let _permit = WORKER
        .get_or_init(|| Semaphore::new(1))
        .try_acquire()
        .map_err(|_| "Speech recognition is busy")?;
    // Silence should never generate Whisper's occasional hallucinated captions.
    if samples.iter().map(|s| s * s).sum::<f32>() / (samples.len() as f32) < 0.000001 {
        return Ok(Transcript {
            text: String::new(),
        });
    }
    let (binary, model) = runtime_paths()?;
    if !installed(&binary, &model) {
        return Err("Local speech model is not installed".into());
    }
    let path = std::env::temp_dir().join(format!("hq-asr-{}.wav", uuid::Uuid::new_v4()));
    let audio = tokio::task::spawn_blocking(move || {
        let audio = AudioFile(path);
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&audio.0)?.write_all(&bytes)?;
        Ok::<AudioFile, std::io::Error>(audio)
    })
    .await
    .map_err(|_| "Audio preparation failed")?
    .map_err(|_| "Cannot prepare audio for recognition")?;
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new(binary)
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(&audio.0)
        .args(["-nt", "-np", "-ng", "-t", "4", "-l", "en"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start local speech engine")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Speech engine output unavailable")?;
    // Bound output even if the local binary is broken. Drain concurrently to
    // avoid a full pipe blocking process completion.
    let reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take(65537)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let status = match tokio::time::timeout(Duration::from_secs(20), child.wait()).await {
        Ok(result) => result.map_err(|_| "Speech engine failed")?,
        Err(_) => {
            // Reap before AudioFile drops: Windows cannot unlink an open WAV.
            let _ = child.kill().await;
            let _ = child.wait().await;
            reader.abort();
            return Err("Local recognition timed out".into());
        }
    };
    let output = reader
        .await
        .map_err(|_| "Speech engine output failed")?
        .map_err(|_| "Speech engine output failed")?;
    if !status.success() {
        return Err("Local speech engine failed to recognize this audio".into());
    }
    if output.len() > 65536 {
        return Err("Speech engine returned too much text".into());
    }
    let text = String::from_utf8(output).map_err(|_| "Speech engine returned invalid text")?;
    Ok(Transcript {
        text: text.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_invalid_audio() {
        assert!(wav(&[], RATE).is_err());
        assert!(wav(&[0.0], 48000).is_err());
        assert!(wav(&[f32::NAN], RATE).is_err());
        assert!(wav(&[1.01], RATE).is_err());
        assert!(wav(&vec![0.0; MAX_SAMPLES + 1], RATE).is_err());
    }
    #[test]
    fn partial_runtime_is_not_ready() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        let model = dir.path().join("ggml-base.en.bin");
        assert!(!installed(&binary, &model));
        std::fs::write(&binary, b"binary").unwrap();
        std::fs::write(&model, b"partial download").unwrap();
        assert!(!installed(&binary, &model));
    }
    #[test]
    fn transient_audio_is_removed_on_drop() {
        let path = std::env::temp_dir().join(format!("hq-asr-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"test").unwrap();
        {
            let _audio = AudioFile(path.clone());
        }
        assert!(!path.exists());
    }
    #[test]
    fn encodes_mono_pcm_with_exact_lengths() {
        let bytes = wav(&[-1.0, 0.0, 1.0], RATE).unwrap();
        assert_eq!(bytes.len(), 50);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[24..28], &RATE.to_le_bytes());
        assert_eq!(&bytes[40..44], &6u32.to_le_bytes());
        assert_eq!(&bytes[44..], &[1, 128, 0, 0, 255, 127]);
    }
}
