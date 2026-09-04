#!/usr/bin/env bash
# Profile: path-polluted — the user already has an OLD node on PATH from a
# version manager (nvm-style). Installers that `command -v node` and trust it
# must not adopt an incompatible node; installers that prepend their own must
# still win in a fresh login shell.
source "$HQ_MATRIX_ROOT/kit/common.sh"
OLD="$HOME/.nvm/versions/node/v16.20.2/bin"; mkdir -p "$OLD"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo v16.20.2; exit 0; }\necho "old node stub"; exit 1\n' >"$OLD/node"; chmod +x "$OLD/node"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo 8.19.4; exit 0; }\necho "old npm stub (cannot install)"; exit 1\n' >"$OLD/npm"; chmod +x "$OLD/npm"
printf 'export PATH="%s:$PATH"\n' "$OLD" >>"$HOME/.zshrc"
printf 'export PATH="%s:$PATH"\n' "$OLD" >>"$HOME/.zprofile"
log "profile path-polluted: fake node v16 on PATH via ~/.zshrc + ~/.zprofile"
