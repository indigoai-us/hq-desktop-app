#!/usr/bin/env bash
# Profile: eacces-npm-global — ~/.npmrc points the npm global prefix at a
# directory the user cannot write (Sentry HQ-DESKTOP-3Y: EACCES on
# `npm install -g`). The managed toolchain must not inherit this prefix.
source "$HQ_MATRIX_ROOT/kit/common.sh"
S() { echo "$HQ_MATRIX_GUEST_PASS" | sudo -S -p '' "$@"; }
S mkdir -p /usr/local/lib/node_modules /usr/local/bin; S chown -R root:wheel /usr/local/lib /usr/local/bin; S chmod 755 /usr/local/lib /usr/local/lib/node_modules /usr/local/bin
printf 'prefix=/usr/local\n' >"$HOME/.npmrc"
log "profile eacces-npm-global: ~/.npmrc prefix=/usr/local (root-owned, not writable)"
