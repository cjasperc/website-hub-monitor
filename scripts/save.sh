#!/usr/bin/env bash
# Commits whatever the checks wrote under data/ and pushes, retrying when another run pushed first.
# Commits made with the workflow's own token never start other workflows, so this can't loop.
set -euo pipefail
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add data
if git diff --cached --quiet; then
  echo "Nothing new to save"
  exit 0
fi
git commit -q -m "${1:-Checks} $(date -u +%Y-%m-%dT%H:%MZ)"
for i in 1 2 3 4 5; do
  if git push -q; then exit 0; fi
  sleep $((i * 4))
  git pull -q --rebase
done
echo "Could not push after 5 tries" >&2
exit 1
