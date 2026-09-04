#!/usr/bin/env bash
# Profile: pnpm-global-ghost — a pnpm global install of hq/qmd exists OFF the
# login PATH (~/Library/pnpm), the way Collin's Mac looked on 2026-08-20 when
# four uncoordinated updaters reinstalled the CLI 8+ times an hour and npm's
# rename-aside step finally gutted the package. The installer must neither
# adopt the ghost nor collide with it.
source "$HQ_MATRIX_ROOT/kit/common.sh"
P="$HOME/Library/pnpm"; mkdir -p "$P/global/5/node_modules/@indigoai-us/hq-cli/bin" "$P/global/5/node_modules/@tobilu/qmd/bin"
printf '#!/bin/sh\necho "5.0.0-ghost-pnpm"\n' >"$P/hq"; chmod +x "$P/hq"
printf '#!/bin/sh\necho "qmd 1.0.7-ghost"\n' >"$P/qmd"; chmod +x "$P/qmd"
printf 'global-bin-dir=%s\n' "$P" >>"$HOME/.npmrc"
log "profile pnpm-global-ghost: ghost hq/qmd at $P (not on PATH), pnpm global-bin-dir set"
