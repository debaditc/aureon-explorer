#!/usr/bin/env bash
# One-command launcher for Aureon Explorer.
#   ./run.sh            -> setup venv (if needed) + start server on :8000
#   PORT=9000 ./run.sh  -> custom port
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-8000}"
VENV=".venv"

if [ ! -d "$VENV" ]; then
  echo "▸ creating virtualenv ($VENV) …"
  python3 -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --quiet --upgrade pip

# The aureon CORE package (https://github.com/debaditc/aureon) must be installed
# first. If it isn't importable in this venv, clone it and editable-install it.
if ! python -c "import aureon" 2>/dev/null; then
  if [ ! -d "aureon" ]; then
    echo "▸ cloning the aureon core package …"
    git clone https://github.com/debaditc/aureon.git
  fi
  echo "▸ installing aureon (editable) …"
  pip install --quiet -e ./aureon
fi

echo "▸ installing app dependencies …"
pip install --quiet -r requirements.txt

echo "▸ starting Aureon Explorer at http://localhost:${PORT}"
exec uvicorn aureon_explorer.server:app --host 0.0.0.0 --port "$PORT"
