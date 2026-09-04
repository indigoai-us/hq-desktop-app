#!/usr/bin/env bash
# Profile: bash-default-shell — user's login shell is bash, not zsh. PATH
# blocks written only to ~/.zprofile are invisible to this user.
source "$HQ_MATRIX_ROOT/kit/common.sh"
echo "$HQ_MATRIX_GUEST_PASS" | sudo -S chsh -s /bin/bash "$(id -un)" >/dev/null 2>&1 || true
touch "$HOME/.bash_profile"
log "profile bash-default-shell: login shell → $(dscl . -read /Users/$(id -un) UserShell | awk '{print $2}')"
