#!/usr/bin/env bash
# Profile: nonadmin-user — the journey runs as a STANDARD (non-admin) macOS
# user with a REAL console session, the way corporate/family Macs are set up:
# no sudo, no writes to /Applications or /usr/local, no Homebrew possible.
#
# Mechanics: create `tester` (standard), enable SSH for them, copy the harness
# key, set macOS auto-login to `tester` (kcpassword), and ask run-cell.sh to
# reboot the VM so tester owns the console session (a GUI app launched for a
# user with no session hangs — first attempt of this profile proved it).
source "$HQ_MATRIX_ROOT/kit/common.sh"
U=tester; P=tester
S() { echo "$HQ_MATRIX_GUEST_PASS" | sudo -S -p '' "$@"; }
if ! id "$U" >/dev/null 2>&1; then
  S sysadminctl -addUser "$U" -fullName "Standard Tester" -password "$P" -home "/Users/$U" >/dev/null 2>&1
fi
S createhomedir -c -u "$U" >/dev/null 2>&1 || true
S dseditgroup -o edit -a "$U" -t user com.apple.access_ssh >/dev/null 2>&1 || true
S mkdir -p "/Users/$U/.ssh"; S cp "$HOME/.ssh/authorized_keys" "/Users/$U/.ssh/authorized_keys"
S chown -R "$U:staff" "/Users/$U/.ssh"; S chmod 700 "/Users/$U/.ssh"; S chmod 600 "/Users/$U/.ssh/authorized_keys"
if S dseditgroup -o checkmember -m "$U" admin >/dev/null 2>&1; then echo "profile nonadmin-user: $U is unexpectedly an admin" >&2; exit 1; fi
# kcpassword: password XOR'd with Apple's fixed 11-byte key, padded to a 12-byte multiple.
key=(0x7D 0x89 0x52 0x23 0xD2 0xBC 0xDD 0xEA 0xA3 0xB9 0x1F 0x00)
enc=""; i=0; for ((n=0; n<${#P}; n++)); do c=$(printf '%d' "'${P:$n:1}"); enc+=$(printf '\\x%02x' $(( c ^ key[i % 12] ))); i=$((i+1)); done
while (( i % 12 != 0 )); do enc+=$(printf '\\x%02x' $(( key[i % 12] ))); i=$((i+1)); done
printf "$enc" | S tee /etc/kcpassword >/dev/null; S chmod 600 /etc/kcpassword
S defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string "$U"
S chmod -R a+rX "$HQ_MATRIX_ROOT"; S chmod 777 "$HQ_MATRIX_OUT"
echo "$U" >"$HQ_MATRIX_ROOT/run-as-user"; touch "$HQ_MATRIX_ROOT/reboot-required"
log "profile nonadmin-user: standard user '$U' (uid $(id -u $U)) created, auto-login set; requesting reboot"
