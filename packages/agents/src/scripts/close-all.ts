/**
 * close-all — close every demo agent's open position in a market (freeing their collateral). Used
 * to reset between demo runs (e.g. after a BTC run, free collateral so the agents can trade ETH).
 *
 * Run: `bun run src/scripts/close-all.ts --market BTC-PERP`.
 */

import { type AgentRole, deriveDemoAgents, type MarketSymbol, SideKick } from "@sidekick/sdk";
import { agentsMnemonic, engineUrl, loadRootEnv } from "../config.ts";

loadRootEnv();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const market = arg("market", "BTC-PERP") as MarketSymbol;
  const agents = deriveDemoAgents(agentsMnemonic());
  console.log(`closing all demo-agent positions on ${market}…`);
  for (const [role, id] of Object.entries(agents) as [AgentRole, (typeof agents)[AgentRole]][]) {
    const sk = new SideKick({
      network: "arc-testnet",
      privateKey: id.privateKey,
      engineUrl: engineUrl(),
    });
    try {
      const view = await sk.getAccount(market);
      if (view.side === "flat") {
        console.log(`  ${role.padEnd(8)} flat — nothing to close`);
        continue;
      }
      const tx = await sk.close(market);
      const ok = await sk.confirm(tx);
      console.log(
        `  ${role.padEnd(8)} ${ok ? "✓ closed" : "✗ reverted"} (${view.side} → flat) ${tx}`,
      );
    } catch (err) {
      console.log(
        `  ${role.padEnd(8)} error: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
      );
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("close-all failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
