#!/usr/bin/env bash
# Profile: low-disk — leave only ~2 GB free so downloads/extractions that do
# not check space fail the way they do on a full laptop.
source "$HQ_MATRIX_ROOT/kit/common.sh"
free_gb=$(df -g / | awk 'NR==2{print $4}')
fill=$(( free_gb - 2 )); (( fill < 1 )) && { log "already low"; exit 0; }
mkdir -p "$HOME/.hq-matrix-fill"
# mkfile allocates fast without writing zeros through the page cache
mkfile -n "${fill}g" "$HOME/.hq-matrix-fill/fill.bin" 2>/dev/null || dd if=/dev/zero of="$HOME/.hq-matrix-fill/fill.bin" bs=1g count="$fill" 2>/dev/null
log "profile low-disk: filled ${fill} GB, now $(df -g / | awk 'NR==2{print $4}') GB free"
