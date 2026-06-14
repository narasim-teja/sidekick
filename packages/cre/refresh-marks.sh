#!/usr/bin/env bash
# refresh-marks — keep the Chainlink markets' on-chain marks fresh by re-running the CRE markfeed
# workflow for each feed on a cadence. This is the Chainlink analog of the engine's inline Stork push:
# it's EXTERNAL because only the Chainlink DON's KeystoneForwarder may write MarkReceiver.onReport — the
# engine (or any EOA) cannot, by design (that gate is what makes it a real, qualifying Chainlink write).
#
# Each iteration, for each feed: copy its per-feed config to the active config.json, then run
# `cre workflow simulate ./markfeed --broadcast` (the DON fetches Data Streams, reaches consensus, and
# the forwarder lands the mark on-chain). The engine then reads it as `chainlink-live`.
#
# Usage:  ./refresh-marks.sh [interval_seconds]      (default 60)
#         run from packages/cre/.  Reads CRE_ETH_PRIVATE_KEY + CHAINLINK_API_KEY/SECRET from ../../.env.
#         Ctrl-C to stop.  Restores config.json to the ETH default on exit.
set -euo pipefail

cd "$(dirname "$0")"               # packages/cre
INTERVAL="${1:-60}"
ENV_FILE="../../.env"

# The Chainlink markets to refresh: "<label> <per-feed config file>".
FEEDS=(
  "ETH  markfeed/config.eth.json"
  "LINK markfeed/config.link.json"
)

# Export the secrets the CRE CLI needs (it reads them from the shell env, not .env directly).
load() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']$//g'; }
export CRE_ETH_PRIVATE_KEY="$(load CRE_ETH_PRIVATE_KEY)"
export CHAINLINK_API_KEY="$(load CHAINLINK_API_KEY)"
export CHAINLINK_API_SECRET="$(load CHAINLINK_API_SECRET)"
if [ -z "$CRE_ETH_PRIVATE_KEY" ] || [ -z "$CHAINLINK_API_KEY" ] || [ -z "$CHAINLINK_API_SECRET" ]; then
  echo "✗ missing CRE_ETH_PRIVATE_KEY / CHAINLINK_API_KEY / CHAINLINK_API_SECRET in $ENV_FILE" >&2
  exit 1
fi

# Always leave config.json at the ETH default (the committed convention) when we stop.
restore() { cp markfeed/config.eth.json markfeed/config.json 2>/dev/null || true; echo; echo "stopped — config.json restored to ETH default."; }
trap restore EXIT INT TERM

echo "── CRE mark refresh loop (every ${INTERVAL}s; Ctrl-C to stop) ──"
echo "  feeds: $(printf '%s ' "${FEEDS[@]%% *}")"
echo

while true; do
  for entry in "${FEEDS[@]}"; do
    label="${entry%% *}"; cfg="${entry##* }"
    cp "$cfg" markfeed/config.json
    echo "▸ $(date +%H:%M:%S) refreshing $label ($cfg)…"
    # Print only the meaningful lines; a failed run logs but does NOT stop the loop (next pass retries).
    cre workflow simulate ./markfeed --broadcast --target arc 2>&1 \
      | grep -iE "consensus mark|onReport written|error|✗|fail" | sed 's/^/    /' || true
  done
  cp markfeed/config.eth.json markfeed/config.json     # leave the default in place between passes
  echo "  …sleeping ${INTERVAL}s"
  sleep "$INTERVAL"
done
