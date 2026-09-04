#!/usr/bin/env bash
# Journey: probe-machine — no install. Proves the cell is what it claims
# (bare = provably bare on disk, not just off PATH) and that the network the
# installers need is reachable. A failing probe invalidates every other cell
# on this image, so it runs first in the nightly. Pure bash (see common.sh).
source "$HQ_MATRIX_ROOT/kit/common.sh"
inventory probe >"$HQ_MATRIX_OUT/inventory.json"
check "os.version" 0 "$(sw_vers -productVersion) $(sw_vers -buildVersion) $(uname -m)"
for h in nodejs.org registry.npmjs.org github.com objects.githubusercontent.com api.github.com; do
  code="$(http_code $h)"
  case "$HQ_MATRIX_PROFILE:$h" in
    no-github-api:api.github.com) if [[ "$code" != 2* && "$code" != 3* ]]; then check "net.$h.blocked-as-expected" 0 "$code"; else check "net.$h.blocked-as-expected" 1 "$code"; fi;;
    *) if [[ "$code" == 2* || "$code" == 3* || "$code" == 4* ]]; then check "net.$h" 0 "$code"; else check "net.$h" 1 "http=$code"; fi;;
  esac
done
rl="$(curl -sS -m 8 https://api.github.com/rate_limit 2>/dev/null | tr -d ' \n' | sed -n 's/.*"core":{"limit":\([0-9]*\),"used":[0-9]*,"remaining":\([0-9]*\).*/\2\/\1/p')"
check "github.ratelimit" 0 "${rl:-unavailable}"
# python3 / git are CLT stubs on a bare Mac — record it; installers must not call them.
for t in python3 git; do p="$(login_which $t)"; if is_clt_stub "$p"; then note "$t resolves to CLT stub $p (calling it pops the Xcode dialog)"; fi; done
if [[ "$HQ_MATRIX_IMAGE" == *consumer* ]]; then
  for t in node npm qmd yq hq brew; do
    d="$(disk_find_bin $t | paste -sd' ' -)"; lp="$(login_which $t)"
    if [[ "$HQ_MATRIX_PROFILE" == path-polluted && ( "$t" == node || "$t" == npm ) ]]; then check "bare.$t.polluted-by-profile" 0 "$lp"; continue; fi
    if [[ "$HQ_MATRIX_PROFILE" == stale-toolchain && ( "$t" == node || "$t" == qmd ) ]]; then check "bare.$t.stale-by-profile" 0 "$d"; continue; fi
    if [[ -z "$d" && -z "$lp" ]]; then check "bare.$t" 0 "absent on disk + PATH"; else check "bare.$t" 1 "path=$lp disk=$d"; fi
  done
  if clt_present; then check "bare.clt" 1 "CLT present on a consumer image"; else check "bare.clt" 0 "no CLT"; fi
else
  if clt_present; then check "configured.clt" 0; else check "configured.clt" 1 "CLT missing on configured image"; fi
fi
result_write 0
