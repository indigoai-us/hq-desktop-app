#!/usr/bin/env bash
# Guest-side helpers for HQ install-matrix journeys. Sourced by every journey
# and profile; also runnable as `bash common.sh inventory <label>`.
#
# HARD RULE: pure bash + BSD userland only. A bare consumer Mac has NO python3,
# NO jq, NO git — `/usr/bin/python3` and `/usr/bin/git` are Xcode CLT stubs
# that print "No developer tools were found" and pop the install dialog. The
# first matrix run proved this. The host (which has python3) does all parsing.
#
# Result contract: a journey writes $HQ_MATRIX_OUT/result.json via `result_write`
# with {ok, checks:[{name, ok, detail, t}], notes:[...], failed:[...]}.

: "${HQ_MATRIX_OUT:=/Users/Shared/hq-matrix/out}"
mkdir -p "$HQ_MATRIX_OUT"
CHECKS_FILE="$HQ_MATRIX_OUT/.checks.jsonl"
NOTES_FILE="$HQ_MATRIX_OUT/.notes.txt"
JOURNEY_T0="${JOURNEY_T0:-$(date +%s)}"

# JSON string escaper (backslash, quote, control chars → space, newline → \n).
jstr() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/ }"; s="${s//$'\r'/}"
  s="$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037' | iconv -c -f UTF-8 -t UTF-8 2>/dev/null)"
  printf '"%s"' "$s"
}
# JSON array of strings from stdin lines
jarr_lines() { local first=1 l; printf '['; while IFS= read -r l; do [[ $first == 1 ]] || printf ','; first=0; jstr "$l"; done; printf ']'; }

log()  { printf '[guest %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
note() { log "note: $*"; printf '%s\n' "$*" >>"$NOTES_FILE"; }

# check <name> <ok:0|nonzero> [detail]
check() {
  local name="$1" ok="$2" detail="${3:-}" okj=false
  [[ "$ok" == 0 ]] && okj=true
  printf '{"name":%s,"ok":%s,"detail":%s,"t":%s}\n' "$(jstr "$name")" "$okj" "$(jstr "$(printf '%s' "$detail" | tail -c 400)")" "$(( $(date +%s) - JOURNEY_T0 ))" >>"$CHECKS_FILE"
  if [[ "$ok" == 0 ]]; then log "PASS $name ${detail:+— $detail}"; else log "FAIL $name ${detail:+— $detail}"; fi
}
# run_check <name> <cmd...> — passes iff the command exits 0
run_check() {
  local name="$1"; shift
  local out; out="$("$@" 2>&1)"; local ec=$?
  check "$name" "$ec" "$(printf '%s' "$out" | tail -c 400 | tr '\n' ' ')"
  return $ec
}

# Login-shell lookup — what a real user's terminal sees AFTER install.
# The user's ACTUAL login shell (bash-default-shell profile changes it). A
# bash user never reads ~/.zshrc, so checks must go through their shell.
user_shell() { dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}'; }
login_shell_cmd() { case "$(user_shell)" in */bash) echo "bash -lic";; *) echo "zsh -lic";; esac; }
login_which() { $(login_shell_cmd) "command -v $1" 2>/dev/null | tail -1; }
login_run()   { $(login_shell_cmd) "$*" 2>&1; }
noninteractive_which() { case "$(user_shell)" in */bash) bash -lc "command -v $1" 2>/dev/null | tail -1;; *) zsh -lc "command -v $1" 2>/dev/null | tail -1;; esac; }
# CLT stub detection: /usr/bin/{git,python3,...} exist as stubs when CLT is absent.
clt_present() { [[ -d /Library/Developer/CommandLineTools/usr/bin ]]; }
is_clt_stub() { [[ "$1" == /usr/bin/* ]] && ! clt_present; }
# Safe --version: never invoke a CLT stub (it would pop the install dialog).
safe_version() { local p; p="$(login_which "$1")"; [[ -z "$p" ]] && return 0; is_clt_stub "$p" && { echo "CLT-STUB"; return 0; }; zsh -lic "$1 --version 2>/dev/null | head -1" 2>/dev/null | tail -1; }
# Full-disk presence (policy hq-verify-clean-room-vm-bare-full-disk).
disk_find_bin() { find "$HOME" /usr/local /opt -type f -perm -111 -name "$1" 2>/dev/null | grep -v "^${HQ_MATRIX_ROOT:-/Users/Shared/hq-matrix}" | head -5; }
http_code() { curl -sS -o /dev/null -m 8 -w '%{http_code}' "https://$1/" 2>/dev/null || echo err; }

result_write() {
  local ok="$1" all=true failed=() l name okv
  if [[ -f "$CHECKS_FILE" ]]; then
    while IFS= read -r l; do
      okv="${l#*\"ok\":}"; okv="${okv%%,*}"
      if [[ "$okv" != true ]]; then all=false; name="${l#*\"name\":\"}"; name="${name%%\"*}"; failed+=("$name"); fi
    done <"$CHECKS_FILE"
  fi
  [[ "$ok" == 0 ]] || all=false
  {
    printf '{"schema":1,"ok":%s,"duration_secs":%s,' "$all" "$(( $(date +%s) - JOURNEY_T0 ))"
    printf '"failed":'; printf '%s\n' "${failed[@]+"${failed[@]}"}" | { [[ ${#failed[@]} -gt 0 ]] && jarr_lines || printf '[]'; }
    printf ',"notes":'; [[ -f "$NOTES_FILE" ]] && jarr_lines <"$NOTES_FILE" || printf '[]'
    printf ',"checks":['; [[ -f "$CHECKS_FILE" ]] && paste -sd, "$CHECKS_FILE"; printf ']}\n'
  } >"$HQ_MATRIX_OUT/result.json"
}

inventory() {
  local label="$1" t p v d
  local sh_now; sh_now="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')"
  printf '{"label":%s,' "$(jstr "$label")"
  printf '"os":{"version":%s,"build":%s,"arch":%s},' "$(jstr "$(sw_vers -productVersion)")" "$(jstr "$(sw_vers -buildVersion)")" "$(jstr "$(uname -m)")"
  printf '"user":{"name":%s,"uid":%s,"admin":%s,"login_shell":%s},' "$(jstr "$(id -un)")" "$(id -u)" "$( id -Gn | grep -qw admin && echo true || echo false)" "$(jstr "$sh_now")"
  printf '"clt":{"present":%s},"homebrew":%s,' "$(clt_present && echo true || echo false)" "$([[ -d /opt/homebrew/bin ]] && echo true || echo false)"
  printf '"login_path":%s,' "$(jstr "$(zsh -lic 'echo $PATH' 2>/dev/null | tail -1)")"
  printf '"hq_state":{"home_hq":%s,"dot_hq":%s,"managed_toolchain":%s},' "$([[ -d $HOME/hq ]] && echo true || echo false)" "$([[ -d $HOME/.hq ]] && echo true || echo false)" "$([[ -d "$HOME/Library/Application Support/Indigo HQ" ]] && echo true || echo false)"
  printf '"disk_free_gb":%s,' "$(df -g / | awk 'NR==2{print $4}')"
  printf '"tools":{'; local first=1
  for t in node npm npx qmd yq hq git gh claude brew pnpm python3; do
    [[ $first == 1 ]] || printf ','; first=0
    p="$(login_which $t)"; v="$(safe_version $t)"; d="$(disk_find_bin $t | paste -sd' ' -)"
    printf '%s:{"login_path":%s,"version":%s,"on_disk":%s}' "$(jstr "$t")" "$(jstr "$p")" "$(jstr "$v")" "$(jstr "$d")"
  done
  printf '},"net":{'; first=1
  for t in nodejs.org registry.npmjs.org api.github.com github.com objects.githubusercontent.com raw.githubusercontent.com; do
    [[ $first == 1 ]] || printf ','; first=0; printf '%s:%s' "$(jstr "$t")" "$(jstr "$(http_code $t)")"
  done
  printf '},"github_ratelimit":%s}\n' "$(jstr "$(curl -sS -m 8 https://api.github.com/rate_limit 2>/dev/null | tr -d ' \n' | sed -n 's/.*"core":{"limit":\([0-9]*\),"used":[0-9]*,"remaining":\([0-9]*\).*/\2\/\1/p')")"
}

case "${1:-}" in
  inventory) inventory "${2:-now}"; exit 0 ;;
esac
