/**
 * Spike B — Mark read on-chain via the pluggable oracle adapter (Stork).
 *
 * Deploys the `StorkAdapter` (which implements the common `IOracleAdapter`) for each of the
 * five markets, then reads the mark on-chain through that one interface. Confirms: the Stork
 * mark source is real on Arc, WHICH of BTC/ETH/SOL/HYPE/LINK have live feeds (and whether the
 * `keccak256(symbol)` asset-id encoding matches Stork's registry), and that the pluggable
 * adapter pattern works so the source is swappable per-market.
 *
 * The Chainlink leg of the adapter is confirmed Day-1 once feed addresses on Arc are known;
 * this spike proves the adapter shape end-to-end with the Stork implementation.
 *
 * Run: `bun run spike:oracle` (from repo root) — requires a funded PRIVATE_KEY in .env.
 *
 * @see docs/02-PHASED-BUILD-PLAN.md Phase 0 Spike B
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARC, MARKET_SYMBOLS, MARKETS, STORK, storkAssetId } from "@sidekick/shared";
import { type Abi, type Address, formatUnits, type Hex } from "viem";
import {
  banner,
  httpClient,
  loadRootEnv,
  REPO_ROOT,
  spikeAccount,
  walletClient,
} from "./_shared.ts";

loadRootEnv();

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function loadArtifact(rel: string): Artifact {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, "packages/contracts/out", rel), "utf8"),
  ) as Artifact;
}

/** A Stork mark reading, normalized by the on-chain adapter to 18 decimals. */
type Mark = { price18: bigint; timestampMs: bigint };

async function main() {
  banner("Spike B — Oracle mark read on-chain (Stork, via pluggable adapter)");

  const account = spikeAccount();
  const pub = httpClient();
  const wallet = walletClient(account);
  const adapter = loadArtifact("StorkAdapter.sol/StorkAdapter.json");

  console.log(`account:        ${account.address}`);
  console.log(`stork contract: ${STORK.contractAddress}`);
  console.log("reading the mark through IOracleAdapter.getMark() for each market.\n");

  const results: { symbol: string; asset: string; ok: boolean; detail: string }[] = [];

  for (const symbol of MARKET_SYMBOLS) {
    const market = MARKETS[symbol];
    // Only the Stork-backed markets are exercised here; assetId via keccak256(asset).
    const assetId =
      market.oracle.source === "stork" ? market.oracle.assetId : storkAssetId(market.asset);

    try {
      // Deploy a StorkAdapter bound to (stork contract, assetId).
      const deployHash = await wallet.deployContract({
        abi: adapter.abi,
        bytecode: adapter.bytecode.object,
        args: [STORK.contractAddress, assetId],
        account,
        chain: null,
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
      const address = rcpt.contractAddress as Address;

      // Read the mark through the common interface.
      const mark = (await pub.readContract({
        address,
        abi: adapter.abi,
        functionName: "getMark",
      })) as Mark;

      const price = formatUnits(mark.price18, 18);
      const ageS =
        mark.timestampMs === 0n
          ? "n/a"
          : `${Math.round(Date.now() / 1000 - Number(mark.timestampMs) / 1000)}s ago`;
      const ok = mark.price18 > 0n;
      const detail = ok ? `$${price} (updated ${ageS})` : "no value (price18=0)";
      results.push({ symbol, asset: market.asset, ok, detail });
      console.log(`${ok ? "✓" : "·"} ${symbol.padEnd(10)} ${market.asset.padEnd(8)} ${detail}`);
    } catch (err) {
      // A revert here usually means "no feed for this asset id" (NotFound) — informative, not fatal.
      const msg = err instanceof Error ? (err.message.split("\n")[0] ?? "error") : String(err);
      results.push({ symbol, asset: market.asset, ok: false, detail: msg });
      console.log(`· ${symbol.padEnd(10)} ${market.asset.padEnd(8)} reverted/no-feed: ${msg}`);
    }
  }

  const live = results.filter((r) => r.ok);
  console.log(
    `\nLive Stork feeds on Arc: ${live.length}/${results.length} — ${live.map((r) => r.asset).join(", ") || "none"}`,
  );
  console.log(`Explorer: ${ARC.explorerUrl}/address/${STORK.contractAddress}`);

  banner(
    live.length > 0
      ? "Spike B PASS ✓ (pluggable adapter reads a live Stork mark on-chain)"
      : "Spike B INCOMPLETE — no live feed read (check asset-id encoding / feed availability)",
  );
  if (live.length === 0) {
    console.log(
      "The adapter deployed and the call path works; no feed returned a value. Likely the",
    );
    console.log(
      "asset-id encoding differs from keccak256(symbol), or these assets are not pushed on",
    );
    console.log("Arc testnet yet. Confirm the encoded asset ids with the Stork team / registry.");
  }
  process.exit(live.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSpike B FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
