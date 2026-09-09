#!/usr/bin/env bash
# Journey: full-fresh-install — what a real user does: desktop dependency
# engine first, then setup.sh in the resulting environment. Composite of the
# two journeys; each contributes its checks to one result.
source "$HQ_MATRIX_ROOT/kit/common.sh"
export JOURNEY_T0
bash "$HQ_MATRIX_ROOT/kit/journeys/desktop-deps-headless/run.sh" || true
HQ_MATRIX_DEPS_EXPECT=pass bash "$HQ_MATRIX_ROOT/kit/journeys/setup-sh/run.sh" || true
result_write 0
