#!/bin/bash
# The scheduler. A single long-lived process that runs the watcher forever,
# aiming to start a scan every INTERVAL seconds.
#
# Why a loop rather than launchd's own timer
# -----------------------------------------
# This used to be StartCalendarInterval at :00 and :30 — fixed clock slots.
# Fixed slots have one bad property: a run that overruns its slot collides with
# the next one, and the loser is skipped. At 15-minute slots that cost more
# than half the runs (37 of 96 on one measured day) because the lock was still
# held when the next slot fired.
#
# A loop has no slots to miss. It runs a scan, then waits out whatever is left
# of the interval, then runs the next. The timer is measured from the START of
# each run, so the target cadence is one scan every INTERVAL seconds rather
# than INTERVAL seconds of idling between scans.
#
# If a scan takes longer than the interval, the next one starts immediately.
# That is deliberate: the instruction is that a scan happens as often as
# possible, so a slow run eats into the wait rather than being dropped.
#
# Concurrency
# -----------
# There is exactly one of these processes, and it runs scans one after another,
# so two scans can never overlap. That is what stops the run lock in
# src/index.js from ever skipping anything — not because the lock was removed,
# but because the situation it guards against cannot arise. The lock stays as a
# backstop for a scan started by hand while this loop is mid-run; two Braves on
# one profile directory is what produces "launchPersistentContext: Timeout".
#
# launchd restarts this script if it ever exits (KeepAlive), so the only way to
# stop it is to unload the agent.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/linkedin-watcher"
LOG="$LOG_DIR/run.log"
mkdir -p "$LOG_DIR"

# Overridable so a scan can be run at a different cadence without editing this
# file: WATCH_INTERVAL_SECONDS=300 bash bin/loop.sh
INTERVAL="${WATCH_INTERVAL_SECONDS:-900}"

echo "$(date '+%Y-%m-%d %H:%M:%S') [LOOP START] interval=${INTERVAL}s pid=$$" >> "$LOG"

# Stop cleanly when launchd unloads the agent, and take a running scan with us
# rather than leaving an orphaned Brave holding the profile.
trap 'echo "$(date "+%Y-%m-%d %H:%M:%S") [LOOP STOP] pid=$$" >> "$LOG"; kill 0; exit 0' TERM INT

while true; do
  started=$(date +%s)

  bash "$HERE/bin/run.sh" --scheduled

  elapsed=$(( $(date +%s) - started ))
  remaining=$(( INTERVAL - elapsed ))

  if [ "$remaining" -gt 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [LOOP] run took ${elapsed}s — next in ${remaining}s" >> "$LOG"
    sleep "$remaining"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [LOOP] run took ${elapsed}s — over the ${INTERVAL}s interval, starting the next immediately" >> "$LOG"
  fi
done
