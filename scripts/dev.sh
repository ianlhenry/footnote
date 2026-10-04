#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -s "${NVM_DIR:-$HOME/.config/nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.config/nvm}/nvm.sh"
  nvm use
fi

exec npx concurrently -n api,web -c blue,green "npm run dev:api" "npm run dev:web"
