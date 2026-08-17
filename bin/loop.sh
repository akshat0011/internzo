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

# Hold off idle sleep for the WHOLE loop, not just the scans.
# -----------------------------------------------------------
# caffeinate used to wrap only the scan below, which protected ~2.5 of every 30
# minutes and left the 27-minute wait exposed. On battery this Mac is set to
# `sleep 1` — system sleep after ONE minute idle — so it went under almost the
# moment a scan finished and stayed there until something else woke it. The
# `sleep` in the loop does not advance while the machine is suspended, so the
# next run simply never came: measured on 17 Aug as a single `sleep 1643` still
# alive 7h22m later.
#
# The cost was not marginal. Over the 14 days to 17 Aug: 66 gaps longer than 45
# minutes, 118.9 hours of collection lost, 8.5 hours a day — the scraper was
# down roughly 35% of wall-clock time, which dwarfs every scraper bug found in
# the same period.
#
# Re-exec under caffeinate so the assertion covers the waits too. Guarded on the
# binary existing, because a missing caffeinate must degrade to an uncaffeinated
# loop rather than kill the scheduler outright. launchd keeps supervising this:
# exec replaces the shell in place, and caffeinate exits when its child does, so
# KeepAlive still sees one process that lives and dies with the loop.
#
# This keeps the machine awake on battery as well as on AC — a deliberate
# choice, made 17 Aug, trading battery life for collection uptime. It still does
# NOT override closing the lid; nothing short of a system setting does.
#
# Re-invoked through /bin/bash explicitly rather than as "$0" alone: launchd
# already starts this file that way (`exec /bin/bash .../bin/loop.sh`), so the
# execute bit is not part of the contract and must not silently become one.
if [ -z "${WATCHER_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  export WATCHER_CAFFEINATED=1
  exec caffeinate -i /bin/bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/linkedin-watcher"
LOG="$LOG_DIR/run.log"
mkdir -p "$LOG_DIR"

# Overridable so a scan can be run at a different cadence without editing this
# file: WATCH_INTERVAL_SECONDS=300 bash bin/loop.sh
INTERVAL="${WATCH_INTERVAL_SECONDS:-1800}"

echo "$(date '+%Y-%m-%d %H:%M:%S') [LOOP START] interval=${INTERVAL}s pid=$$" >> "$LOG"

# Stop cleanly when launchd unloads the agent, and take a running scan with us
# rather than leaving an orphaned Brave holding the profile.
trap 'echo "$(date "+%Y-%m-%d %H:%M:%S") [LOOP STOP] pid=$$" >> "$LOG"; kill 0; exit 0' TERM INT

while true; do
  started=$(date +%s)

  # Redundant with the whole-script assertion above, and kept anyway: this is
  # the window where sleeping is most expensive. A scan interrupted mid-flight
  # showed up as ~604-second stalls with no log output, a page.goto that had
  # already blown its 60s timeout by the time the machine woke, and runs ending
  # 'partial' with most of a 90-minute budget spent asleep. If the outer exec is
  # ever removed or skipped, this still covers the scan itself.
  caffeinate -i bash "$HERE/bin/run.sh" --scheduled

  elapsed=$(( $(date +%s) - started ))
  remaining=$(( INTERVAL - elapsed ))

  if [ "$remaining" -gt 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [LOOP] run took ${elapsed}s — next in ${remaining}s" >> "$LOG"
    sleep "$remaining"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [LOOP] run took ${elapsed}s — over the ${INTERVAL}s interval, starting the next immediately" >> "$LOG"
  fi
done
