#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
  else
    echo "Missing .env and .env.example. Create your environment file first."
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  npm install
fi

npm run build

if [ "${1:-}" = "--dev" ]; then
  exec npm run dev
else
  echo "TG-S3 is ready."
  echo "Start it with: npm start"
  echo "Or run in dev mode with: ./deploy.sh --dev"
fi