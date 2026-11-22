#!/usr/bin/env bash
# usage: spike/run.sh MODEL RUNS PORT ; prints one line per run
set -u
M=$1; N=$2; PORT=${3:-4950}; D=$(cd "$(dirname "$0")" && pwd)
UPSTREAM_MODEL=$M PORT=$PORT SHIM_LOG=${SHIM_LOG:-} npx tsx "$D/shim.ts" 2>>"$D/shim-$PORT.log" & SP=$!
sleep 3
for i in $(seq 1 "$N"); do
  W=$(mktemp -d); cp "$D"/task/*.js "$D"/task/package.json "$W"/
  S=$(date +%s)
  ( cd "$W" && ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_AUTH_TOKEN=x ANTHROPIC_API_KEY= perl -e "alarm 420; exec @ARGV" claude -p "Run the tests with: node --test. Fix the bug in sum.js, then run the tests again." --model sonnet --allowedTools "Bash(node --test*)" "Read" "Edit" "Write" --max-turns 15 > "$W/out.txt" 2>&1 )
  E=$(( $(date +%s) - S ))
  if ( cd "$W" && node --test >/dev/null 2>&1 ); then R=PASS; else R=FAIL; fi
  echo "$M run$i $R ${E}s $(tail -c 120 "$W/out.txt" | tr '\n' ' ')"
done
kill $SP 2>/dev/null
