/**
 * circleAccount adapter tests — drive the adapter with a FAKE Circle client (no network, no creds),
 * asserting it produces a viem account whose signMessage / signTypedData / signTransaction route to
 * Circle's API with the right shape, and that the address resolves. This is the contract the SideKick
 * SDK relies on when a real external agent uses a Circle developer-controlled wallet as its signer.
 */

import { describe, expect, test } from "bun:test";
import { serializeTransaction } from "viem";
import { type CircleSigner, circleAccount, circleBroadcaster } from "./circle-account.ts";

const WALLET_ID = "71f2a6b4-ffa7-417a-ad5b-fb928753edc8";
const ADDRESS = "0xe55628c98f5d81daaa79b72899b38a3535d10990" as const;
const SIG = "0xdeadbeef" as const;

/** A fake Circle client recording calls + returning canned signatures. */
function fakeCircle(): { signer: CircleSigner; calls: string[] } {
  const calls: string[] = [];
  const signer: CircleSigner = {
    async getWallet({ id }) {
      calls.push(`getWallet:${id}`);
      return { data: { wallet: { address: ADDRESS } } };
    },
    async signMessage({ walletId, message }) {
      calls.push(`signMessage:${walletId}:${message}`);
      return { data: { signature: SIG } };
    },
    async signTypedData({ walletId, data }) {
      calls.push(`signTypedData:${walletId}:${data}`);
      return { data: { signature: SIG } };
    },
    async signTransaction({ walletId }) {
      calls.push(`signTransaction:${walletId}`);
      return { data: { signedTransaction: SIG } };
    },
    async createContractExecutionTransaction({ walletId, contractAddress, abiFunctionSignature }) {
      calls.push(`createTx:${walletId}:${contractAddress}:${abiFunctionSignature}`);
      return { data: { id: "tx-1", state: "INITIATED" } };
    },
    async getTransaction({ id }) {
      calls.push(`getTx:${id}`);
      return { data: { transaction: { id, state: "CONFIRMED", txHash: "0xonchain" } } };
    },
  };
  return { signer, calls };
}

describe("circleAccount", () => {
  test("resolves the wallet address when not provided", async () => {
    const { signer, calls } = fakeCircle();
    const account = await circleAccount(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s" },
      signer,
    );
    expect(account.address).toBe(ADDRESS);
    expect(calls).toContain(`getWallet:${WALLET_ID}`);
  });

  test("skips the address lookup when address is supplied", async () => {
    const { signer, calls } = fakeCircle();
    await circleAccount(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    expect(calls.find((c) => c.startsWith("getWallet"))).toBeUndefined();
  });

  test("signMessage routes the EIP-191 text to Circle", async () => {
    const { signer, calls } = fakeCircle();
    const account = await circleAccount(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    const sig = await account.signMessage({ message: "hello" });
    expect(sig).toBe(SIG);
    expect(calls).toContain(`signMessage:${WALLET_ID}:hello`);
  });

  test("signTypedData JSON-stringifies the document for Circle (the Gateway nanopayment path)", async () => {
    const { signer, calls } = fakeCircle();
    const account = await circleAccount(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    const typedData = {
      domain: { name: "X", version: "1", chainId: 5042002, verifyingContract: ADDRESS },
      types: { Foo: [{ name: "amount", type: "uint256" }] },
      primaryType: "Foo" as const,
      message: { amount: 1_000_000n }, // bigint — the real Gateway path carries these
    };
    const sig = await account.signTypedData(typedData);
    expect(sig).toBe(SIG);
    // The call carries a JSON document with the domain + primaryType, with the bigint coerced to a string.
    const call = calls.find((c) => c.startsWith("signTypedData"));
    expect(call).toContain('"primaryType":"Foo"');
    expect(call).toContain('"name":"X"');
    expect(call).toContain('"amount":"1000000"'); // bigint serialized safely, not a thrown error
    // Regression guard: Circle requires an explicit EIP712Domain types entry (viem omits it). Verified
    // live — without this Circle rejects with "extra data provided in the message".
    expect(call).toContain('"EIP712Domain"');
    expect(call).toContain('{"name":"chainId","type":"uint256"}');
    expect(call).toContain('{"name":"verifyingContract","type":"address"}');
  });

  test("signTypedData does not duplicate EIP712Domain if already present", async () => {
    const { signer, calls } = fakeCircle();
    const account = await circleAccount(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    const typedData = {
      domain: { name: "X", version: "1" },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Foo: [{ name: "a", type: "string" }],
      },
      primaryType: "Foo" as const,
      message: { a: "x" },
    };
    // Deliberately pass a doc that already declares EIP712Domain (viem's signTypedData type rejects
    // that — it expects you to omit it). We test the adapter's dedup path, so the loose shape is intended.
    // biome-ignore lint/suspicious/noExplicitAny: intentional loose typed-data shape for the dedup test.
    await account.signTypedData(typedData as any);
    const call = calls.find((c) => c.startsWith("signTypedData")) ?? "";
    // Exactly one EIP712Domain entry (not doubled).
    expect(call.match(/EIP712Domain/g)?.length).toBe(1);
  });

  test("signTransaction serializes then returns Circle's signed tx", async () => {
    const { signer, calls } = fakeCircle();
    const account = await circleAccount(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    const tx = {
      type: "eip1559",
      chainId: 5042002,
      to: ADDRESS,
      value: 0n,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    } as const;
    // sanity: the tx serializes (the adapter does this before calling Circle)
    expect(serializeTransaction(tx)).toStartWith("0x");
    const signed = await account.signTransaction?.(tx);
    expect(signed).toBe(SIG);
    expect(calls).toContain(`signTransaction:${WALLET_ID}`);
  });
});

describe("circleBroadcaster", () => {
  const ERC20_APPROVE_ABI = [
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
      ],
      outputs: [],
    },
  ];

  test("translates a structured call to abiFunctionSignature + abiParameters and returns the txHash", async () => {
    const { signer, calls } = fakeCircle();
    const b = await circleBroadcaster(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    const hash = await b.write({
      to: ADDRESS,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [ADDRESS, 1_000_000n],
    });
    expect(hash).toBe("0xonchain");
    // Circle gets the canonical signature (proven EOA path), then we poll the tx.
    expect(
      calls.some((c) => c === `createTx:${WALLET_ID}:${ADDRESS}:approve(address,uint256)`),
    ).toBe(true);
    expect(calls).toContain("getTx:tx-1");
  });

  test("throws if Circle reports the tx FAILED", async () => {
    const { signer } = fakeCircle();
    signer.getTransaction = async ({ id }) => ({
      data: { transaction: { id, state: "FAILED", errorReason: "nope" } },
    });
    const b = await circleBroadcaster(
      { walletId: WALLET_ID, apiKey: "k", entitySecret: "s", address: ADDRESS },
      signer,
    );
    await expect(
      b.write({
        to: ADDRESS,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [ADDRESS, 1n],
      }),
    ).rejects.toThrow(/FAILED/);
  });
});
