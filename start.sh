#!/bin/sh
# Start NewfieCad on Linux or macOS: serves this folder and opens your browser.
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py "$@"
else
  exec python serve.py "$@"
fi
