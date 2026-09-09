#!/usr/bin/env bash
# Profile: no-github-api — api.github.com unreachable (corp firewall / rate-limit
# stand-in). Exercises every code path that hits the GitHub API anonymously
# (release lookups, template fetch) and proves install still degrades sanely.
source "$HQ_MATRIX_ROOT/kit/common.sh"
echo "$HQ_MATRIX_GUEST_PASS" | sudo -S sh -c 'printf "\n127.0.0.1 api.github.com\n" >> /etc/hosts' && sudo dscacheutil -flushcache 2>/dev/null || true
log "profile no-github-api: api.github.com → 127.0.0.1"
