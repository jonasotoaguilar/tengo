#!/usr/bin/env bash
# Runs one Maestro flow with its artifacts inside the repository instead of
# Maestro's own output location, which in this project's observed runs is
# `$HOME/.maestro/tests/<timestamp>/<flow>/` (that path comes from the runs
# themselves, not from `maestro test --help`, which does not state a default).
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
#                     guarded CRUD bundle is served on 8083. That reverse is
#                     REMOVED again when this script exits; a `tcp:8082`
#                     reverse that existed beforehand is NOT restored, and the
#                     script warns with the command to re-add it.
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdk-17.0.20.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
# Prepend only what the caller cannot already resolve, so this wrapper never
# shadows a `maestro`, `java` or `adb` the caller put on PATH deliberately.
command -v java >/dev/null 2>&1 || PATH="$JAVA_HOME/bin:$PATH"
command -v adb >/dev/null 2>&1 || PATH="$ANDROID_HOME/platform-tools:$PATH"
command -v maestro >/dev/null 2>&1 || PATH="$HOME/.maestro/bin:$PATH"
export PATH

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

# These are pinned below, and Maestro's parser lets a later flag win, so
# accepting them here would silently split or redirect the artifacts.
for extra in "$@"; do
  case "$extra" in
    --test-output-dir* | --format* | --output* | --udid*)
      echo "refusing '$extra': scripts/run-maestro.sh pins that flag" >&2
      exit 2
      ;;
  esac
done

run_root="${MAESTRO_RUN_DIR:-}"
if [ -z "$run_root" ]; then
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "not inside a git repository: set MAESTRO_RUN_DIR to choose the artifact root" >&2
    exit 2
  fi
  run_root="$repo_root/.maestro/runs"
fi

serial="${MAESTRO_SERIAL:-emulator-5554}"
# Sanitize the flow name for the artifact directory: a flow file with a space
# or a separator in its name would otherwise create an artifact path that has
# to be quoted forever after, and `basename` alone would carry its own newline
# through a pipeline into the name. Repeats collapse, leading/trailing
# separators are stripped, and a name that sanitizes to nothing falls back.
# The flow path itself is passed through untouched.
flow_name="$(basename "$flow" .yaml)"
flow_name="${flow_name//[^A-Za-z0-9._-]/-}"
flow_name="$(printf '%s' "$flow_name" | tr -s '-')"
flow_name="${flow_name#-}"
flow_name="${flow_name%-}"
[ -n "$flow_name" ] || flow_name="flow"
out_dir="$run_root/$(date +%Y%m%d_%H%M%S)_$flow_name"
mkdir -p "$out_dir"

reverse_applied=0
reverse_preexisting=0
if [ "${MAESTRO_REVERSE:-0}" = "1" ]; then
  if adb reverse --list 2>/dev/null | grep -q 'tcp:8082'; then
    reverse_preexisting=1
  fi
  adb reverse tcp:8082 tcp:8083
  reverse_applied=1
fi

cleanup() {
  if [ "$reverse_applied" = "1" ]; then
    adb reverse --remove tcp:8082 >/dev/null 2>&1 || true
    if [ "$reverse_preexisting" = "1" ]; then
      echo "note: a tcp:8082 reverse existed before this run; re-add it with:" >&2
      echo "      adb reverse tcp:8082 tcp:8082" >&2
    fi
  fi
}
trap cleanup EXIT

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
