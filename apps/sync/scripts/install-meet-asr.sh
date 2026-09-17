#!/usr/bin/env bash
# Developer setup for the local Meet prototype. No microphone capture or cloud ASR.
# Builds a pinned static CPU/Accelerate whisper.cpp and installs base.en (~148 MB).
set -euo pipefail
case "$(uname -s)" in
  Darwin) runtime_dir="$HOME/Library/Application Support/HQ/meet-asr" ;;
  Linux) runtime_dir="${XDG_DATA_HOME:-$HOME/.local/share}/HQ/meet-asr" ;;
  *) echo "For Windows, build whisper-cli.exe v1.7.6 and install with ggml-base.en.bin under %APPDATA%/HQ/meet-asr." >&2; exit 1 ;;
esac
command -v cmake >/dev/null
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
curl -fL --retry 2 https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.7.6.tar.gz -o "$build_dir/source.tar.gz"
printf '%s  %s\n' '166140e9a6d8a36f787a2bd77f8f44dd64874f12dd8359ff7c1f4f9acb86202e' "$build_dir/source.tar.gz" | shasum -a 256 -c -
tar -xzf "$build_dir/source.tar.gz" -C "$build_dir"
cmake -S "$build_dir/whisper.cpp-1.7.6" -B "$build_dir/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_METAL=OFF
cmake --build "$build_dir/build" --target whisper-cli -j 4
curl -fL --retry 2 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin -o "$build_dir/ggml-base.en.bin"
printf '%s  %s\n' 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' "$build_dir/ggml-base.en.bin" | shasum -a 256 -c -
mkdir -p "$runtime_dir"
install -m 755 "$build_dir/build/bin/whisper-cli" "$runtime_dir/whisper-cli"
install -m 644 "$build_dir/ggml-base.en.bin" "$runtime_dir/ggml-base.en.bin"
echo "Local speech engine installed: $runtime_dir"
