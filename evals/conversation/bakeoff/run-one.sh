#!/bin/zsh
# usage: run-one.sh <candidate> <run-index>
set -e
CAND=$1; IDX=$2
cd /Users/jejo/Projects/jehad-os
POLICY_YAML_PATH=$PWD/evals/conversation/bakeoff/policy-$CAND.yaml \
JUDGE_MODEL=openai/gpt-4.1 \
TEST_DATABASE_URL=postgres://jejo@localhost:5432/jehad \
npx tsx evals/conversation/semantic-live.ts --dev --label bo-$CAND-$IDX 2>&1 | tail -3
