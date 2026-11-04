#!/usr/bin/env bash
# Copy image-bucket objects from one environment to another (e.g. Railway prod -> hotbox dry run).
# Runs rclone in a throwaway Docker container; credentials come from an env file, never argv.
#
# Usage:
#   scripts/bucket-sync.sh <env-file> <command> [--network <docker-network>]
#
# Commands:
#   size    object count + total bytes on both sides
#   plan    show what `copy` would transfer (rclone --dry-run, writes nothing)
#   copy    copy new/changed objects src -> dst (never deletes anything on dst)
#   mirror  make dst an exact mirror of src (DELETES dst objects missing from src; asks first)
#   check   verify every src object exists on dst with a matching checksum
#
# --network: join a Docker network so an internal endpoint (e.g. http://<alias>:8333) resolves.
# Template for the env file: scripts/bucket-sync.env.example
set -euo pipefail

RCLONE_IMAGE="rclone/rclone:1.68.2"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

[[ $# -ge 2 ]] || usage
ENV_FILE="$1"; CMD="$2"; shift 2
NETWORK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }

# Bucket names only (no secrets) are read here; credentials go straight to the container.
SRC_BUCKET=$(grep -E '^SRC_BUCKET=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DST_BUCKET=$(grep -E '^DST_BUCKET=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
[[ -n "$SRC_BUCKET" && -n "$DST_BUCKET" ]] || { echo "SRC_BUCKET and DST_BUCKET must be set in $ENV_FILE" >&2; exit 1; }

SRC="src:${SRC_BUCKET}"
DST="dst:${DST_BUCKET}"

rclone() {
  local net_args=()
  [[ -n "$NETWORK" ]] && net_args=(--network "$NETWORK")
  docker run --rm ${net_args[@]+"${net_args[@]}"} --env-file "$ENV_FILE" "$RCLONE_IMAGE" "$@"
}

# --checksum compares S3 ETags (MD5) instead of modtime, avoiding a HEAD per object.
COPY_FLAGS=(--checksum --transfers 16 --checkers 32 --stats 10s --stats-one-line -v)

echo "src: $SRC   dst: $DST${NETWORK:+   network: $NETWORK}"
case "$CMD" in
  size)
    echo "--- src"; rclone size "$SRC"
    echo "--- dst"; rclone size "$DST"
    ;;
  plan)
    rclone copy "$SRC" "$DST" "${COPY_FLAGS[@]}" --dry-run
    ;;
  copy)
    rclone copy "$SRC" "$DST" "${COPY_FLAGS[@]}"
    ;;
  mirror)
    read -r -p "This DELETES objects in $DST that are not in $SRC. Type 'mirror' to continue: " ok
    [[ "$ok" == "mirror" ]] || { echo "aborted"; exit 1; }
    rclone sync "$SRC" "$DST" "${COPY_FLAGS[@]}"
    ;;
  check)
    rclone check "$SRC" "$DST" --one-way --checksum
    ;;
  *) usage ;;
esac
