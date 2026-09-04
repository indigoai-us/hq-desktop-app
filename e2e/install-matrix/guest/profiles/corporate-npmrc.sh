#!/usr/bin/env bash
# Profile: corporate-npmrc — the user's ~/.npmrc points at a corporate npm
# mirror that does not carry HQ's packages (Sentry HQ-DESKTOP-5Q: E404 from a
# non-default registry). The failure must be attributed clearly to the
# registry, not reported as a generic install error.
source "$HQ_MATRIX_ROOT/kit/common.sh"
printf 'registry=https://npm.corp.invalid/\nstrict-ssl=true\n' >"$HOME/.npmrc"
log "profile corporate-npmrc: ~/.npmrc registry=https://npm.corp.invalid/"
