#!/usr/bin/env bash
# Reproduce the Midnight node `Custom error: 186` rejection in one command.
#
# Prerequisites:
#   - Docker
#   - Node.js >= 22
#   - `compact` compiler on PATH (Compact toolchain manager 0.5.x)
#   - openssl (one-time `infra/.env` generation)
#
# Usage:
#   ./repro.sh              # run end-to-end
#   ./repro.sh --fresh      # reset chain state first

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"

# ── Args ────────────────────────────────────────────────────────────────────

FRESH=false
for arg in "${@:-}"; do
  case $arg in
    --fresh) FRESH=true ;;
  esac
done

# ── Prerequisites ───────────────────────────────────────────────────────────

check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not found on PATH"; exit 1; }; }
check_cmd docker
check_cmd node
check_cmd openssl
check_cmd compact

NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "ERROR: Node 22+ required (found $(node --version))"
  exit 1
fi

# ── infra/.env (one-time) ───────────────────────────────────────────────────

if [[ ! -f "$INFRA_DIR/.env" ]]; then
  SECRET=$(openssl rand -hex 32)
  sed "s/^APP__INFRA__SECRET=$/APP__INFRA__SECRET=$SECRET/" "$SCRIPT_DIR/.env.example" > "$INFRA_DIR/.env"
  echo "infra/.env created (APP__INFRA__SECRET generated)"
fi

set -a
source "$INFRA_DIR/.env"
set +a

# ── Build ───────────────────────────────────────────────────────────────────

cd "$SCRIPT_DIR"
echo "Installing npm dependencies ..."
npm install --silent

echo "Compiling Compact contract ..."
npm run compile

# ── Devnet ──────────────────────────────────────────────────────────────────

COMPOSE_FILES="-f $INFRA_DIR/docker-compose.yml"
if [[ "$(uname -s)" == "Darwin" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $INFRA_DIR/docker-compose.macos.yml"
fi
COMPOSE="docker compose $COMPOSE_FILES"

if $FRESH; then
  echo ""
  echo "Resetting chain state ..."
  $COMPOSE down -v 2>/dev/null || true
  rm -rf midnight-level-db
  sleep 2
fi

echo ""
echo "Starting local Midnight devnet ..."
$COMPOSE up -d node indexer proof-server

echo "Waiting for node ..."
ELAPSED=0
until curl -sf http://localhost:9944/health > /dev/null 2>&1; do
  if (( ELAPSED >= 60 )); then echo "ERROR: node did not start within 60s"; $COMPOSE logs node --tail 20; exit 1; fi
  printf "."; sleep 2; (( ELAPSED += 2 ))
done
echo " OK"

echo "Waiting for indexer ..."
ELAPSED=0
until curl -sf http://localhost:8088/api/v4/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}' > /dev/null 2>&1; do
  if (( ELAPSED >= 120 )); then echo "WARN: indexer not ready after 120s"; break; fi
  printf "."; sleep 3; (( ELAPSED += 3 ))
done
echo " OK"

echo "Waiting for proof server ..."
ELAPSED=0
until curl -sf http://localhost:6300/version > /dev/null 2>&1; do
  if (( ELAPSED >= 30 )); then echo "WARN: proof server not responding"; break; fi
  printf "."; sleep 2; (( ELAPSED += 2 ))
done
echo " OK"

# ── Run ─────────────────────────────────────────────────────────────────────

echo ""
echo "Running reproduction ..."
echo ""
npm run repro
