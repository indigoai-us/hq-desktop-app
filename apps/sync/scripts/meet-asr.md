# Meet local speech runtime (development prototype)

Run `bash scripts/install-meet-asr.sh` from `apps/sync`. This builds pinned
whisper.cpp v1.7.6 and downloads the SHA-256-verified English base model (148 MB).
CMake and a C++ compiler are required. Nothing uploads microphone audio.

Runtime location is `dirs::data_dir()/HQ/meet-asr`: on macOS,
`~/Library/Application Support/HQ/meet-asr`. The recognizer expects `whisper-cli`
(`whisper-cli.exe` on Windows) and `ggml-base.en.bin` here. Windows automated
installation and production asset delivery are not implemented in this prototype.

The native `meet_transcribe_pcm` command accepts finite mono float samples in
[-1,1], exactly 16 kHz, at most 10 seconds, only from the call window. The
frontend supplies audio from its existing post-mute microphone path; this
command cannot open a microphone. Four-second windows are a useful initial
latency/accuracy tradeoff. Calls run one at a time and time out after 20 seconds.
Temporary PCM WAV files are private on Unix and removed on completion/error;
these are transient local files, not saved recordings. No audio/text is logged.

`meet_transcription_status` reports missing runtime files honestly. This is
chunked live English recognition, not a persistent streaming decoder. Each
chunk reloads the model; no cross-chunk context or server fallback is provided.
Silence below RMS 0.001 is skipped to reduce hallucinated text. Voice detection,
proper-noun accuracy and overlapping-window reconciliation need real-call QA.

Local validation on the development Mac: bundled upstream JFK fixture produced
“And so my fellow Americans, ask not what your country can do for you, ask what
you can do for your country.” in 0.64 seconds including process/model startup,
using four CPU threads and Accelerate. This is a fixture measurement, not a
claim about live microphone latency or all supported hardware.

A six-second crop of the same fixture decoded in 0.387 seconds, with imperfect
wording at the cropped utterance boundary. This reinforces the need to evaluate
sentence-boundary buffering for the live path. The macOS binary links only
system libSystem, libc++ and Accelerate (no Homebrew dylib dependency).
Readiness also rejects truncated model files and non-executable Unix binaries;
cryptographic verification happens during install, not per recognition request.
