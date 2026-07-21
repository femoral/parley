#!/usr/bin/env sh
# Parley provenance hook for Grok Build. Passive: stdout is ignored; exit 0.
# Paths relative to this file; GROK_PLUGIN_ROOT is preferred when set.
set -eu

ROOT="${GROK_PLUGIN_ROOT:-}"
if [ -z "$ROOT" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
fi

HOOK_JS="$ROOT/dist/hook.js"
if [ ! -f "$HOOK_JS" ]; then
  # Fail-open: never block a session if the package was installed without build.
  exit 0
fi

exec node "$HOOK_JS"
