#!/usr/bin/env bash
# Profile: stale-toolchain — a PRIOR, half-finished install left a managed
# toolchain directory behind (the resume/upgrade path real users hit when an
# earlier attempt died). We fabricate the directory with a bogus node stub so
# the installer must detect it is unusable and re-provision, not trust it.
source "$HQ_MATRIX_ROOT/kit/common.sh"
TC="$HOME/Library/Application Support/Indigo HQ/toolchain"
mkdir -p "$TC/node/bin" "$TC/npm-global/bin"
printf '#!/bin/sh\necho "node: stale stub"; exit 97\n' >"$TC/node/bin/node"; chmod +x "$TC/node/bin/node"
printf '#!/bin/sh\necho "qmd: stale stub"; exit 97\n' >"$TC/npm-global/bin/qmd"; chmod +x "$TC/npm-global/bin/qmd"
cat >>"$HOME/.zprofile" <<'Z'
# Indigo HQ managed toolchain
export PATH="$HOME/Library/Application Support/Indigo HQ/toolchain/node/bin:$HOME/Library/Application Support/Indigo HQ/toolchain/npm-global/bin:$PATH"
Z
log "profile stale-toolchain: stub node/qmd planted at $TC and PATH block written"
