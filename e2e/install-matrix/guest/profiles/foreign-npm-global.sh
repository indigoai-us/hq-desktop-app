#!/usr/bin/env bash
# Profile: foreign-npm-global — the user already has a self-configured npm
# global prefix (~/.npm-global via ~/.npmrc, on PATH) holding a BROKEN qmd and
# an old hq shim, the way half-migrated developer Macs look (Sentry
# HQ-DESKTOP-5B/5C/5E class: ENOTEMPTY/EEXIST/managed-shadow conflicts).
source "$HQ_MATRIX_ROOT/kit/common.sh"
P="$HOME/.npm-global"; mkdir -p "$P/bin" "$P/lib/node_modules/@tobilu/qmd"
printf 'prefix=%s\n' "$P" >"$HOME/.npmrc"
printf '#!/bin/sh\necho "qmd: foreign broken shim"; exit 1\n' >"$P/bin/qmd"; chmod +x "$P/bin/qmd"
printf '#!/bin/sh\necho "0.0.1-foreign"\n' >"$P/bin/hq"; chmod +x "$P/bin/hq"
printf 'export PATH="%s/bin:$PATH"\n' "$P" >>"$HOME/.zshrc"; printf 'export PATH="%s/bin:$PATH"\n' "$P" >>"$HOME/.zprofile"
log "profile foreign-npm-global: ~/.npmrc prefix=$P with broken qmd + stale hq shims on PATH"
