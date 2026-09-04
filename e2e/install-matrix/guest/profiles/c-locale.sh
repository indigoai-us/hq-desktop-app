#!/usr/bin/env bash
# Profile: c-locale — no UTF-8 locale in the environment (LANG/LC_ALL unset →
# C). This is what launchd, hooks, agent shells, and some SSH/corporate
# terminal setups give a script; setup.sh once died here with
# `QMD_VERSION…: unbound variable`.
source "$HQ_MATRIX_ROOT/kit/common.sh"
printf '\nunset LANG LC_ALL LC_CTYPE\nexport HQ_MATRIX_LOCALE=C\n' >>"$HQ_MATRIX_ROOT/env.sh"
log "profile c-locale: LANG/LC_ALL unset for the journey"
