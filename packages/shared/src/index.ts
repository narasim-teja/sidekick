/**
 * @sidekick/shared — shared types, market configs, the pluggable oracle adapter interface,
 * and Arc/Circle/Stork/Chainlink constants. Imported by every other package so all layers
 * agree on the same shapes and addresses.
 */

export * from "./chain.ts";
export * from "./constants.ts";
export * from "./deployments.ts";
export * from "./erc8004.ts";
export * from "./market-config.ts";
export * from "./markets.ts";
export * from "./oracle.ts";
