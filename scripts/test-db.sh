#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Prefer a normal virtualenv; support ignored repository-local tooling as a fallback.
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python -B -m unittest discover -s tests/database -v
fi
PYTHONPATH="$PWD/.tools/python${PYTHONPATH:+:$PYTHONPATH}" exec python3 -B -m unittest discover -s tests/database -v
