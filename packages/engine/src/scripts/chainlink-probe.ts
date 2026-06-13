/**
 * chainlink-probe — a standalone credential + shape probe for Chainlink Data Streams. It does NOT
 * touch the venue: it just proves the `CHAINLINK_API_KEY` / `CHAINLINK_API_SECRET` pair authenticates
 * against the Data Streams REST API and shows the live report shape, so we can build the real pull
 * adapter (`oracle/chainlink.ts`, mirroring `oracle/stork.ts`) against a verified response.
 *
 * Chainlink Data Streams auth is HMAC-SHA256 request signing (verified against the official docs):
 *   Authorization: <keyId>
 *   X-Authorization-Timestamp: <ms-since-epoch>
 *   X-Authorization-Signature-SHA256: HMAC-SHA256(secret, "<METHOD> <path> <sha256hex(body)> <keyId> <ts>")
 * The testnet host is api.testnet-dataengine.chain.link; the feed id is a Chainlink 32-byte id
 * (NOT keccak256(symbol) like Stork). `fullReport` is ABI-encoded; we decode the v3 schema to a price.
 *
 * Run: `bun run src/scripts/chainlink-probe.ts [--feed 0x000359…] [--symbol ETH/USD]`
 * Requires CHAINLINK_API_KEY + CHAINLINK_API_SECRET in the root `.env`.
 *
 * @see https://docs.chain.link/data-streams/reference/data-streams-api/authentication
 * @see packages/engine/src/oracle/stork.ts (the pull path this mirrors)
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeAbiParameters, type Hex } from "viem";

loadRootEnv();

// ── Known Data Streams TESTNET feed ids (crypto, v3 schema). The probe defaults to ETH/USD. ──
// These are Chainlink's own 32-byte ids — the "0x0003…" prefix marks the v3 (crypto) report schema.
const KNOWN_FEEDS: Record<string, Hex> = {
  "ETH/USD": "0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782",
  "BTC/USD": "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
  "LINK/USD": "0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265",
  "SOL/USD": "0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f",
};

const DATASTREAMS_TESTNET_HOST = "api.testnet-dataengine.chain.link";
const REPORTS_LATEST_PATH = "/api/v1/reports/latest";

/** The v3 (crypto) Data Streams report payload, decoded from `fullReport`. */
const REPORT_V3_SCHEMA = [
  { type: "bytes32", name: "feedId" },
  { type: "uint32", name: "validFromTimestamp" },
  { type: "uint32", name: "observationsTimestamp" },
  { type: "uint192", name: "nativeFee" },
  { type: "uint192", name: "linkFee" },
  { type: "uint32", name: "expiresAt" },
  { type: "int192", name: "price" },
  { type: "int192", name: "bid" },
  { type: "int192", name: "ask" },
] as const;

interface SingleReport {
  feedID: string;
  validFromTimestamp: number;
  observationsTimestamp: number;
  fullReport: Hex;
}

/** Build the three Data Streams auth headers for a GET to `path` (body is empty for GET). */
function authHeaders(method: string, path: string, apiKey: string, apiSecret: string) {
  const timestamp = Date.now();
  const bodyHash = createHash("sha256").update("").digest("hex");
  const stringToSign = `${method} ${path} ${bodyHash} ${apiKey} ${timestamp}`;
  const signature = createHmac("sha256", apiSecret).update(stringToSign).digest("hex");
  return {
    Authorization: apiKey,
    "X-Authorization-Timestamp": String(timestamp),
    "X-Authorization-Signature-SHA256": signature,
  };
}

/** Fetch the latest signed report for a feed id over the Data Streams REST API. */
async function fetchLatestReport(feedId: Hex): Promise<SingleReport> {
  const apiKey = process.env.CHAINLINK_API_KEY;
  const apiSecret = process.env.CHAINLINK_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("CHAINLINK_API_KEY and CHAINLINK_API_SECRET are required (put them in .env)");
  }
  const host = process.env.CHAINLINK_STREAMS_HOST || DATASTREAMS_TESTNET_HOST;
  const path = `${REPORTS_LATEST_PATH}?feedID=${feedId}`;
  const res = await fetch(`https://${host}${path}`, {
    method: "GET",
    headers: authHeaders("GET", path, apiKey, apiSecret),
  });
  if (!res.ok) {
    throw new Error(`Data Streams ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  const body = (await res.json()) as { report: SingleReport };
  return body.report;
}

/** Decode `fullReport` → the v3 price (Data Streams prices are 18-decimal int192, same as our WAD). */
function decodePrice(fullReport: Hex): { price18: bigint; expiresAt: number; observedAt: number } {
  // fullReport = abi.encode(bytes32[3] reportContext, bytes reportBlob, …). The report blob itself is
  // the second top-level field; decode the outer envelope, then the v3 schema from the blob.
  const [, reportBlob] = decodeAbiParameters(
    [
      { type: "bytes32[3]", name: "reportContext" },
      { type: "bytes", name: "reportBlob" },
      { type: "bytes32[]", name: "rawRs" },
      { type: "bytes32[]", name: "rawSs" },
      { type: "bytes32", name: "rawVs" },
    ],
    fullReport,
  );
  const decoded = decodeAbiParameters(REPORT_V3_SCHEMA, reportBlob as Hex);
  // Tuple order matches REPORT_V3_SCHEMA: [...,, expiresAt(5), price(6), ...].
  const expiresAt = Number(decoded[5]);
  const price18 = decoded[6] as bigint;
  const observedAt = Number(decoded[2]);
  return { price18, expiresAt, observedAt };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const symbol = arg("symbol") ?? "ETH/USD";
  const feedId = (arg("feed") ?? KNOWN_FEEDS[symbol]) as Hex | undefined;
  if (!feedId) {
    throw new Error(
      `no feed id for "${symbol}". Pass --feed 0x… or use one of: ${Object.keys(KNOWN_FEEDS).join(", ")}`,
    );
  }

  console.log(`── Chainlink Data Streams probe (${symbol}) ──`);
  console.log(`  host:   ${process.env.CHAINLINK_STREAMS_HOST || DATASTREAMS_TESTNET_HOST}`);
  console.log(`  feedID: ${feedId}\n`);

  console.log(`  fetching latest signed report…`);
  const report = await fetchLatestReport(feedId);
  console.log(`  ✓ authenticated — report received`);
  console.log(`    validFrom:    ${new Date(report.validFromTimestamp * 1000).toISOString()}`);
  console.log(`    observations: ${new Date(report.observationsTimestamp * 1000).toISOString()}`);
  console.log(
    `    fullReport:   ${report.fullReport.slice(0, 26)}… (${report.fullReport.length} chars)`,
  );

  const { price18, expiresAt, observedAt } = decodePrice(report.fullReport);
  const price = Number(price18) / 1e18;
  const ageS = Math.round(Date.now() / 1000 - observedAt);
  console.log(`\n  decoded v3 report:`);
  console.log(`    price:     $${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}`);
  console.log(`    price18:   ${price18} (WAD, ready for the adapter's MarkPrice)`);
  console.log(`    observed:  ${ageS}s ago`);
  console.log(`    expiresAt: ${new Date(expiresAt * 1000).toISOString()}`);

  const ok = price18 > 0n;
  console.log(
    `\n${ok ? "✅ PASS — credentials work and the live mark decodes; the adapter can be built against this shape" : "❌ report decoded but price was non-positive"}`,
  );
  process.exit(ok ? 0 : 1);
}

/** Load the root `.env` into process.env (same minimal loader the stork-push script uses). */
function loadRootEnv(): void {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../../../.env", import.meta.url)), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        v.length >= 2 &&
        ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ambient env */
  }
}

main().catch((err) => {
  console.error("chainlink-probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
