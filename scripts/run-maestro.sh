#!/usr/bin/env bash
# Runs one Maestro flow with its artifacts inside the repository instead of
# the Maestro default, which is `$HOME/.maestro/tests/<timestamp>/<flow>/`.
#
# Every run gets its own directory holding the flow's `commands.json`,
# `manifest.json`, screenshots and `maestro.log`, plus a JUnit report
# (`junit.xml`) because the CLI default is `--format NOOP`, which emits none.
# `.maestro/runs/` is gitignored: these files are evidence, not source.
#
# Usage:
#   scripts/run-maestro.sh .maestro/m4-forms.yaml
#   scripts/run-maestro.sh .maestro/m4-forms.yaml --debug-output /tmp/debug
#
# Environment:
#   MAESTRO_RUN_DIR   artifact root (default: <repo>/.maestro/runs)
#   MAESTRO_SERIAL    device serial (default: emulator-5554)
#   MAESTRO_REVERSE=1 also `adb reverse tcp:8082 tcp:8083`, the known trap
#                     where the app's debug host points at 8082 while the
#                     guarded CRUD bundle is served on 8083.
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdk-17.0.20.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$HOME/.maestro/bin:$PATH"

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/run-maestro.sh <flow.yaml> [extra maestro args...]" >&2
  exit 2
fi

flow="$1"
shift

if [ ! -f "$flow" ]; then
  echo "flow not found: $flow" >&2
  exit 2
fi

serial="${MAESTRO_SERIAL:-emulator-5554}"
run_root="${MAESTRO_RUN_DIR:-$(git rev-parse --show-toplevel)/.maestro/runs}"
flow_name="$(basename "$flow" .yaml)"
out_dir="$run_root/$(date +%Y%m%d_%H%M%S)_$flow_name"
mkdir -p "$out_dir"

if [ "${MAESTRO_REVERSE:-0}" = "1" ]; then
  adb reverse tcp:8082 tcp:8083
fi

set +e
maestro --udid "$serial" test "$flow" \
  --test-output-dir "$out_dir" \
  --format JUNIT --output "$out_dir/junit.xml" \
  "$@"
status=$?
set -e

echo "maestro exit: $status"
echo "artifacts:    $out_dir"
if [ -f "$out_dir/junit.xml" ]; then
  grep -o 'tests="[0-9]*" failures="[0-9]*" errors="[0-9]*"' "$out_dir/junit.xml" || true
fi
exit "$status"
