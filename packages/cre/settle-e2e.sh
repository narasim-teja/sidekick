#!/usr/bin/env bash
# settle-e2e — the end-to-end CRE settlement demo: deliver a Chainlink Data Streams mark to the
# ISOLATED CRE-settled venue's MarkReceiver, then run the settle workflow so the DON reads that mark,
# reaches consensus, and drives PerpEngine.checkpoint on-chain (the Connect-the-World on-chain write).
#
# This is the T6 sequence as ONE command. It:
#   1. exports CRE_ETH_PRIVATE_KEY + CHAINLINK_API_KEY/SECRET from ../../.env (cre reads them from the
#      shell env, NOT .env directly — running cre without this is the "CRE_ETH_PRIVATE_KEY is not set" error),
#   2. points markfeed/config.json at the settle venue's MarkReceiver (settle reads what markfeed wrote),
#   3. runs markfeed --broadcast (delivers the mark), then settle --broadcast (drives the checkpoint),
#   4. restores markfeed/config.json to the committed ETH default on exit.
#
# Usage:  ./settle-e2e.sh        (run from packages/cre/)
set -euo pipefail

cd "$(dirname "$0")"               # packages/cre
ENV_FILE="../../.env"
SETTLE_MARK_RECEIVER="0x559074a39b5A10B1492D2423b069b692ad2C9c64"

# Export the secrets the CRE CLI needs (it reads them from the shell env, not .env directly).
load() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']$//g"; }
export CRE_ETH_PRIVATE_KEY="$(load CRE_ETH_PRIVATE_KEY)"
export CHAINLINK_API_KEY="$(load CHAINLINK_API_KEY)"
export CHAINLINK_API_SECRET="$(load CHAINLINK_API_SECRET)"
if [ -z "$CRE_ETH_PRIVATE_KEY" ] || [ -z "$CHAINLINK_API_KEY" ] || [ -z "$CHAINLINK_API_SECRET" ]; then
  echo "✗ missing CRE_ETH_PRIVATE_KEY / CHAINLINK_API_KEY / CHAINLINK_API_SECRET in $ENV_FILE" >&2
  exit 1
fi

# Always restore the committed ETH default config on exit.
restore() { cp markfeed/config.eth.json markfeed/config.json 2>/dev/null || true; echo; echo "config.json restored to ETH default."; }
trap restore EXIT INT TERM

echo "── CRE end-to-end settle (markfeed → settle on the isolated venue) ──"

# Point markfeed at the SETTLE venue's MarkReceiver so the settle workflow can read what it writes.
python3 -c "import json;c=json.load(open('markfeed/config.eth.json'));c['evms'][0]['markReceiverAddress']='$SETTLE_MARK_RECEIVER';json.dump(c,open('markfeed/config.json','w'),indent=2)"
echo "  markfeed → settle venue MarkReceiver $SETTLE_MARK_RECEIVER"

echo
echo "[1/2] delivering the mark (markfeed)…"
cre workflow simulate ./markfeed --broadcast --target arc

echo
echo "[2/2] settling on it (settle → PerpEngine.checkpoint)…"
cre workflow simulate ./settle --broadcast --target arc

echo
echo "✓ end-to-end CRE settlement done."
