#!/usr/bin/env bash
# Is this run's commit still the head of main? Run at the start of every
# deploy job (rules, Hosting, alert). A re-run of an OLD run of "Deploy to
# Firebase on merge" (or a dispatch from another branch) would otherwise
# deploy an older app or older rules over newer ones; such a job skips its
# deploy steps with a notice instead. Writes current=true|false to
# $GITHUB_OUTPUT. Env: GITHUB_SHA, GITHUB_OUTPUT, JOB_LABEL (for the notice).
set -euo pipefail

git fetch --no-tags --quiet --depth=1 origin main
head=$(git rev-parse FETCH_HEAD)
if [ "$head" = "$GITHUB_SHA" ]; then
  echo "current=true" >> "$GITHUB_OUTPUT"
  echo "$GITHUB_SHA is the head of main; deploying."
else
  echo "current=false" >> "$GITHUB_OUTPUT"
  echo "::notice title=Stale run: ${JOB_LABEL:-deploy} skipped::$GITHUB_SHA is no longer the head of main ($head), so this job does not deploy it (a re-run of an old run must not roll the site or the rules back). Re-run the LATEST failed run of \"Deploy to Firebase on merge\" instead."
fi