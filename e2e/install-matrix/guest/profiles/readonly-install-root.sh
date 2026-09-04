#!/usr/bin/env bash
# Profile: readonly-install-root — ~/hq already exists and is NOT writable by
# the user (root-owned; the "forbidden path" class of prod failures,
# hq-installer#93). The installer must detect it and fall back / explain,
# never dead-end.
source "$HQ_MATRIX_ROOT/kit/common.sh"
S() { echo "$HQ_MATRIX_GUEST_PASS" | sudo -S -p '' "$@"; }
S mkdir -p "$HOME/hq"; S chown root:wheel "$HOME/hq"; S chmod 755 "$HOME/hq"
log "profile readonly-install-root: $HOME/hq is root-owned, mode 755 (user cannot write)"
