#!/usr/bin/env bash
# Profile: dirty-hq-dir — ~/hq already exists from an earlier attempt: a git
# repo with uncommitted changes, a stray worktree entry, and a stale
# ~/.hq/menubar.json pointing at it (INS-0356: a real user's instance wedged
# on a stray worktree and needed a full reinstall).
source "$HQ_MATRIX_ROOT/kit/common.sh"
mkdir -p "$HOME/hq" "$HOME/.hq" "$HOME/hq/.git/worktrees/stale-wt"
printf 'gitdir: /Users/nobody/hq/.git/worktrees/stale-wt\n' >"$HOME/hq/.git/worktrees/stale-wt/gitdir"
printf '[core]\n\trepositoryformatversion = 0\n\tbare = false\n' >"$HOME/hq/.git/config"; printf 'ref: refs/heads/main\n' >"$HOME/hq/.git/HEAD"; mkdir -p "$HOME/hq/.git/refs/heads" "$HOME/hq/.git/objects"
printf '# leftover\n' >"$HOME/hq/README.md"; printf 'untracked scratch\n' >"$HOME/hq/scratch.txt"
printf '{"machineId":"11111111-1111-1111-1111-111111111111","hqPath":"%s/hq","installCompleted":false}\n' "$HOME" >"$HOME/.hq/menubar.json"
log "profile dirty-hq-dir: pre-existing ~/hq git repo with stray worktree + dirty tree; stale ~/.hq/menubar.json"
