#!/usr/bin/env sh
# Starts the app. Creates .env from the template on first run.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required: https://nodejs.org"
  exit 1
fi
[ -f .env ] || cp .env.example .env
exec node server.js
