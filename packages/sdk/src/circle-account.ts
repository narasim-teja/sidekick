/**
 * `circleAccount` — adapt a **Circle developer-controlled wallet** into a viem `Account` the SideKick
 * SDK can sign with. This is the "real external agent" custody path (Doc 1 §8 / the Circle Agent Stack
 * ask): the agent's key never exists as a whole — it's 2-of-2 MPC, held by Circle, authorized per
 * request by a single-use entity-secret ciphertext — yet the SDK uses it exactly like any signer,
 * because `SideKickConfig` already accepts `{ account }`:
 *
 *     import { SideKick } from "@sidekick/sdk";
 *     import { circleAccount } from "@sidekick/sdk/circle";
 *     const account = await circleAccount({ walletId, apiKey, entitySecret });
 *     const sk = new SideKick({ account, engineUrl });   // trades + answers margin calls, no raw key
 *
 * What this gives you vs an HD-derived EOA: no seed phrase in your process, MPC custody, and (on
 * mainnet) Circle's wallet-layer spending policies. The gas-free margin-call **Nanopayment** flows
 * through `signTypedData` here (the SDK's signer-only Gateway path), so a Circle wallet answers margin
 * calls with no raw key and no gas.
 *
 * Scope / honesty: this adapter implements the **signing** surface viem needs — `signMessage` and
 * `signTypedData` map 1:1 onto Circle's developer-controlled signing API, which covers the entire
 * Gateway/x402 nanopayment flow. `signTransaction` is supported for EOA wallets (Circle returns an
 * EIP-1559-compatible signature), but note Circle's own model is to *broadcast* via its API; for
 * heavy contract-call throughput you may prefer routing writes through Circle's transaction API. The
 * read paths and the headline gas-free settlement need only message/typed-data signing, which is
 * fully covered.
 *
 * @see https://developers.circle.com/w3s/programmable-wallets-account-types (EOA vs SCA)
 */

import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  type Address,
  type CustomSource,
  type Hash,
  type Hex,
  hashMessage,
  type LocalAccount,
  serializeTransaction,
} from "viem";
import { toAccount } from "viem/accounts";
import type { Broadcaster } from "./types.ts";

/** Config for {@link circleAccount}. The entity secret is a SECRET — pass it from env, never log it. */
export interface CircleAccountConfig {
  /** The Circle developer-controlled wallet id (from `createWallets`). */
  walletId: string;
  /** Circle Console API key (`CIRCLE_API_KEY`). */
  apiKey: string;
  /** The 32-byte entity secret (`CIRCLE_ENTITY_SECRET`) — Circle never stores it; handle as a secret. */
  entitySecret: string;
  /** Optionally pass the wallet's known address to skip a lookup round-trip. */
  address?: Address;
  /** Override Circle's API base URL (tests / staging). */
  baseUrl?: string;
}

/** The Circle client surface this adapter uses (a structural subset, so it's easy to fake in tests). */
export interface CircleSigner {
  getWallet(input: { id: string }): Promise<{ data?: { wallet?: { address?: string } } }>;
  signMessage(input: {
    walletId: string;
    message: string;
  }): Promise<{ data?: { signature?: string } }>;
  signTypedData(input: {
    walletId: string;
    data: string;
  }): Promise<{ data?: { signature?: string } }>;
  signTransaction(input: {
    walletId: string;
    transaction: string;
  }): Promise<{ data?: { signature?: string; signedTransaction?: string } }>;
  /**
   * Broadcast a contract call via Circle using `abiFunctionSignature` + `abiParameters` (the proven
   * EOA path on Arc), returns the created tx id + state. (Raw `callData` exists in the API but the
   * signature+params form is what works for developer-controlled EOA wallets.)
   */
  createContractExecutionTransaction(input: {
    idempotencyKey: string;
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
    amount?: string;
    fee: { type: "level"; config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" } };
  }): Promise<{ data?: { id?: string; state?: string } }>;
  /** Fetch a Circle transaction's current status (we poll this to COMPLETE/CONFIRMED). */
  getTransaction(input: { id: string }): Promise<{
    data?: { transaction?: { txHash?: string; state?: string; id?: string; errorReason?: string } };
  }>;
}

function mustSig(res: { data?: { signature?: string } }, what: string): Hex {
  const sig = res.data?.signature;
  if (!sig) throw new Error(`Circle ${what} returned no signature`);
  return sig as Hex;
}

/** Build (or accept a pre-built/fake) Circle developer-controlled client from creds. */
function circleClient(config: CircleAccountConfig, signer?: CircleSigner): CircleSigner {
  return (
    signer ??
    (initiateDeveloperControlledWalletsClient({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's ClientParams is broader than our subset.
    } as any) as unknown as CircleSigner)
  );
}

/** Current epoch ms (wrapped so the dependency is explicit; fine in this regular module). */
function nowMs(): number {
  return Date.now();
}

/**
 * Build Circle's `abiFunctionSignature` (e.g. `approve(address,uint256)`) from a viem ABI + function
 * name. Tuples render as `(type,type)` per Solidity canonical form — matching what Circle expects.
 */
// biome-ignore lint/suspicious/noExplicitAny: abi is a union over the SDK's hand-written ABIs.
export function abiFunctionSignatureOf(abi: any[], functionName: string): string {
  const entry = abi.find((e) => e?.type === "function" && e?.name === functionName);
  if (!entry) throw new Error(`function ${functionName} not found in ABI`);
  // biome-ignore lint/suspicious/noExplicitAny: ABI input nodes.
  const render = (inp: any): string =>
    inp.type === "tuple" || inp.type?.startsWith("tuple")
      ? `(${(inp.components ?? []).map(render).join(",")})${inp.type.slice(5)}`
      : inp.type;
  return `${functionName}(${(entry.inputs ?? []).map(render).join(",")})`;
}

/**
 * Coerce a viem arg into Circle's `abiParameters` JSON form: bigint/number → decimal string, arrays
 * recurse, addresses/strings pass through. (Circle takes string/number/boolean + nested arrays.)
 */
function toAbiParam(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v.toString();
  if (Array.isArray(v)) return v.map(toAbiParam);
  return v;
}

/**
 * A {@link Broadcaster} backed by a Circle developer-controlled wallet. SideKick hands the structured
 * call (abi + function + args); we translate it to Circle's `abiFunctionSignature` + `abiParameters`
 * (the proven EOA path on Arc — same shape the versus-agents project uses), create the contract-
 * execution tx, then poll to COMPLETE/CONFIRMED and return the on-chain txHash. This is the only way a
 * Circle MPC wallet does arbitrary contract writes (it can't return a viem-broadcastable signed tx).
 * `feeLevel` defaults to MEDIUM.
 */
export async function circleBroadcaster(
  config: CircleAccountConfig,
  signer?: CircleSigner,
  feeLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM",
): Promise<Broadcaster> {
  const client = circleClient(config, signer);
  return {
    async write({ to, abi, functionName, args }): Promise<Hex> {
      const created = await client.createContractExecutionTransaction({
        idempotencyKey: randomUUID(),
        walletId: config.walletId,
        contractAddress: to,
        abiFunctionSignature: abiFunctionSignatureOf(abi, functionName),
        abiParameters: args.map(toAbiParam),
        fee: { type: "level", config: { feeLevel } },
      });
      const id = created.data?.id;
      if (!id) throw new Error("Circle createContractExecutionTransaction returned no id");
      // Poll until COMPLETE/CONFIRMED (Circle broadcasts async). ~5 min cap.
      const deadline = 300_000;
      const start = nowMs();
      while (nowMs() - start < deadline) {
        const got = await client.getTransaction({ id });
        const tx = got.data?.transaction;
        const state = tx?.state;
        if (state === "COMPLETE" || state === "CONFIRMED") {
          if (!tx?.txHash) throw new Error(`Circle tx ${id} ${state} but no txHash`);
          return tx.txHash as Hex;
        }
        if (state === "FAILED" || state === "DENIED" || state === "CANCELLED")
          throw new Error(
            `Circle tx ${id} ${state}${tx?.errorReason ? `: ${tx.errorReason}` : ""}`,
          );
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error(`Circle tx ${id} did not confirm within ${deadline}ms`);
    },
  };
}

/**
 * Convenience: build BOTH the signer {@link circleAccount} and the {@link circleBroadcaster} from one
 * config + one Circle client, ready to spread into `new SideKick({ ...circle, engineUrl })` for full
 * Circle-MPC custody (signing AND on-chain writes), no raw key anywhere.
 */
export async function circleSigner(
  config: CircleAccountConfig,
): Promise<{ account: LocalAccount; broadcaster: Broadcaster }> {
  const client = circleClient(config);
  const [account, broadcaster] = await Promise.all([
    circleAccount(config, client),
    circleBroadcaster(config, client),
  ]);
  return { account, broadcaster };
}

/**
 * Build a viem `Account` backed by a Circle developer-controlled wallet. Resolves the wallet address
 * up front (one read) unless you pass it. The returned account plugs straight into
 * `new SideKick({ account })`.
 *
 * @param signer optional pre-built Circle client (or a fake, for tests); else one is created from
 *   `apiKey` + `entitySecret`.
 */
export async function circleAccount(
  config: CircleAccountConfig,
  signer?: CircleSigner,
): Promise<LocalAccount> {
  const client = circleClient(config, signer);

  let address = config.address;
  if (!address) {
    const w = await client.getWallet({ id: config.walletId });
    const a = w.data?.wallet?.address;
    if (!a) throw new Error(`Circle wallet ${config.walletId} has no address (not LIVE yet?)`);
    address = a as Address;
  }

  const source: CustomSource = {
    address,
    async signMessage({ message }): Promise<Hex> {
      // viem hands us a string / {raw}; Circle's signMessage takes the EIP-191 message text.
      const text =
        typeof message === "string"
          ? message
          : "raw" in message
            ? (message.raw as Hex)
            : String(message);
      return mustSig(
        await client.signMessage({ walletId: config.walletId, message: text }),
        "signMessage",
      );
    },
    async signTypedData(typedData): Promise<Hex> {
      // Circle validates the FULL canonical EIP-712 document and requires an explicit `EIP712Domain`
      // types entry — viem omits it (it infers the domain), so we synthesize it from the domain fields
      // that are actually present. Without this Circle rejects with "extra data provided in the
      // message". Also: EIP-712 messages routinely carry bigint fields (amounts/deadlines/nonces) and
      // JSON.stringify can't serialize BigInt, so coerce them to decimal strings (canonical JSON form).
      const doc = withEip712Domain(typedData);
      const data = JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      return mustSig(
        await client.signTypedData({ walletId: config.walletId, data }),
        "signTypedData",
      );
    },
    async signTransaction(transaction): Promise<Hex> {
      const serialized = serializeTransaction(transaction);
      const res = await client.signTransaction({
        walletId: config.walletId,
        transaction: serialized,
      });
      const signed = res.data?.signedTransaction ?? res.data?.signature;
      if (!signed) throw new Error("Circle signTransaction returned no signed transaction");
      return signed as Hex;
    },
  };
  return toAccount(source);
}

/** Convenience: the keccak256 of an EIP-191 message, for callers verifying a Circle signature. */
export function messageHash(message: string): Hash {
  return hashMessage(message);
}

/** Canonical EIP-712 type of each standard domain field (used to build the EIP712Domain entry). */
const EIP712_DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};

/**
 * Return a copy of a viem typed-data document with an explicit `EIP712Domain` types entry, derived
 * from whichever domain fields are present (in canonical order). viem omits `EIP712Domain` because it
 * infers it; Circle (and most non-viem validators) require it in the document. No-op if already present.
 */
// biome-ignore lint/suspicious/noExplicitAny: viem's TypedDataDefinition generic is too narrow to mutate generically.
function withEip712Domain(typedData: any): any {
  const types = typedData?.types ?? {};
  if (types.EIP712Domain) return typedData;
  const domain = typedData?.domain ?? {};
  const eip712Domain = Object.keys(EIP712_DOMAIN_FIELD_TYPES)
    .filter((f) => domain[f] !== undefined)
    .map((f) => ({ name: f, type: EIP712_DOMAIN_FIELD_TYPES[f] }));
  return { ...typedData, types: { EIP712Domain: eip712Domain, ...types } };
}
