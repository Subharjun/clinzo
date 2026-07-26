#!/usr/bin/env bash
# Generate cryptographically random JWT secrets and write them into .env.
#
# The application refuses to boot in production with the placeholder values
# from .env.example — this script is the intended way to satisfy that check.
set -euo pipefail

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "creating $ENV_FILE from .env.example"
  cp .env.example "$ENV_FILE"
fi

ACCESS_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
REFRESH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

# The two secrets must differ, or an access token could be replayed as a
# refresh token. `openssl rand` makes a collision impossible in practice.
tmp="$(mktemp)"
while IFS= read -r line; do
  case "$line" in
    JWT_ACCESS_SECRET=*)  echo "JWT_ACCESS_SECRET=${ACCESS_SECRET}" ;;
    JWT_REFRESH_SECRET=*) echo "JWT_REFRESH_SECRET=${REFRESH_SECRET}" ;;
    *)                    echo "$line" ;;
  esac
done < "$ENV_FILE" > "$tmp"
mv "$tmp" "$ENV_FILE"

echo "wrote fresh JWT secrets to $ENV_FILE"
