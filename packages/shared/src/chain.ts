/**
 * viem chain definition for Arc Testnet.
 *
 * Arc does not (yet) ship an official viem chain export, so we define it inline from the
 * Doc 1 §9 facts. Note Arc's native gas token is USDC with 18 decimals.
 */

import { defineChain } from "viem";
import { ARC, rpcUrl, wssUrl } from "./constants.ts";

/**
 * Build the Arc Testnet chain object, resolving RPC/WSS from env (so an Alchemy or other
 * provider URL overrides the public default). Call with no args to use `process.env`.
 */
export function arcTestnet(env: Record<string, string | undefined> = process.env) {
  return defineChain({
    id: ARC.chainId,
    name: ARC.name,
    nativeCurrency: ARC.nativeCurrency,
    rpcUrls: {
      default: {
        http: [rpcUrl(env)],
        webSocket: [wssUrl(env)],
      },
    },
    blockExplorers: {
      default: { name: "Arcscan", url: ARC.explorerUrl },
    },
    testnet: true,
  });
}
