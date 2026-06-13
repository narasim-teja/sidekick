// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Vault} from "../src/Vault.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {AccountManager} from "../src/AccountManager.sol";
import {Pool} from "../src/Pool.sol";
import {LPToken} from "../src/LPToken.sol";
import {StorkAdapter} from "../src/oracle/StorkAdapter.sol";
import {SideKickUSDC} from "../src/test/SideKickUSDC.sol";
import {MarketParams} from "../src/Types.sol";
import {Params} from "../src/generated/Params.sol";

/// @title Deploy — stand up the full SideKick venue on Arc Testnet (Doc 2 §2.3).
/// @notice Deploys Vault → MarketRegistry → PerpEngine → AccountManager, then one Pool + slpUSDC LP
///         token + StorkAdapter per market, wires operators/engine, and registers all five markets
///         with the **Phase-1 swept params** (mirrors the shared package DEFAULT_PARAMS exactly).
///
///         Collateral: on Arc the venue uses the **canonical Arc testnet USDC** (the faucet token —
///         also the gas token, Spike C). Set `USDC_ADDRESS` in the environment to that address.
///         If unset, the script deploys {SideKickUSDC} (the 6-dp test token) so a local/dry run
///         still works end-to-end — but a real Arc deploy MUST point at the canonical USDC.
///
/// @dev Run (dry, no broadcast):
///        forge script script/Deploy.s.sol --rpc-url arc_testnet
///      Live (broadcast + verify) is the explicit Phase-2 follow-up once the funded key is confirmed:
///        forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --verify
///      After a live run, copy the logged addresses into the shared package (deployments.ts).
contract Deploy is Script {
    // Phase-1 sweep-selected params come from the GENERATED {Params} library (src/generated/Params.sol),
    // produced from the shared package's DEFAULT_PARAMS by `bun run gen:params` — one source of truth
    // for the sim (TS) and the chain (Solidity). Re-sweep -> regenerate -> these follow automatically.

    uint256 internal constant BLOCK_SECONDS = 2; // Arc ~2s blocks
    uint256 internal constant FUNDING_PERIOD_SECONDS = 8 hours;

    // Stork oracle on Arc testnet (Doc 1 §9; Spike B). Adapter reads keccak256(symbol) feed ids.
    address internal constant STORK = 0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62;

    struct MarketDef {
        bytes32 id;
        string symbol;
        string asset; // Stork asset symbol, e.g. "BTCUSD"
        string lpName;
        string lpSymbol;
    }

    function run() external {
        address deployer = msg.sender;
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));
        // The STANDING owner of the venue (Vault/Registry/Engine/Pools) should be a multisig or a
        // timelock, NOT the deploy EOA — the owner can grant Vault operators (who move the internal
        // claim ledger), so a single-key compromise is the highest-value privilege in the system.
        // The deployer owns DURING wiring (setOperator/setEngine/registerMarket are owner-gated),
        // then ownership transfers to OWNER_ADDRESS at the end. Defaults to the deployer for local runs.
        address owner = vm.envOr("OWNER_ADDRESS", deployer);

        vm.startBroadcast();

        // Collateral: canonical Arc USDC if provided, else a local test token (dry runs only).
        if (usdcAddr == address(0)) {
            usdcAddr = address(new SideKickUSDC());
            console2.log("WARNING: deployed test USDC (no USDC_ADDRESS env). Local/dry run only.");
        }

        Vault vault = new Vault(usdcAddr, deployer);
        MarketRegistry registry = new MarketRegistry(deployer);
        PerpEngine engine =
            new PerpEngine(address(registry), address(vault), BLOCK_SECONDS, FUNDING_PERIOD_SECONDS, deployer);
        AccountManager accountManager = new AccountManager(address(vault), address(engine));

        // The engine is the loop operator on the vault.
        vault.setOperator(address(engine), true);

        MarketParams memory params = Params.defaults(); // generated from the shared package's sweep
        MarketDef[5] memory markets = _markets();
        Pool[5] memory pools;

        for (uint256 i = 0; i < markets.length; i++) {
            MarketDef memory md = markets[i];

            Pool pool = new Pool(md.id, address(vault), deployer);
            LPToken lp = new LPToken(md.lpName, md.lpSymbol, address(pool));
            pool.setLpToken(address(lp));
            pool.setEngine(address(engine));
            vault.setOperator(address(pool), true); // pool moves LP capital claims
            pools[i] = pool;

            bytes32 feedId = keccak256(bytes(md.asset)); // Stork: keccak256(utf8(symbol)) — Spike B
            StorkAdapter adapter = new StorkAdapter(STORK, feedId);

            registry.registerMarket(md.id, md.symbol, params, address(pool), address(adapter), feedId);

            console2.log(md.symbol);
            console2.log("  pool:    ", address(pool));
            console2.log("  lpToken: ", address(lp));
            console2.log("  oracle:  ", address(adapter));
        }

        // Hand the standing owner role to OWNER_ADDRESS (multisig/timelock) now that wiring is done.
        if (owner != deployer) {
            vault.transferOwnership(owner);
            registry.transferOwnership(owner);
            engine.transferOwnership(owner);
            for (uint256 i = 0; i < pools.length; i++) {
                pools[i].transferOwnership(owner);
            }
            console2.log("Ownership transferred to:", owner);
        } else {
            console2.log("WARNING: owner == deployer EOA. Set OWNER_ADDRESS to a multisig/timelock for a real deploy.");
        }

        vm.stopBroadcast();

        console2.log("=== SideKick venue ===");
        console2.log("USDC:          ", usdcAddr);
        console2.log("Vault:         ", address(vault));
        console2.log("MarketRegistry:", address(registry));
        console2.log("PerpEngine:    ", address(engine));
        console2.log("AccountManager:", address(accountManager));
    }

    function _markets() internal pure returns (MarketDef[5] memory m) {
        m[0] = MarketDef(bytes32("BTC-PERP"), "BTC-PERP", "BTCUSD", "SideKick BTC-PERP LP", "slpUSDC-BTC");
        m[1] = MarketDef(bytes32("ETH-PERP"), "ETH-PERP", "ETHUSD", "SideKick ETH-PERP LP", "slpUSDC-ETH");
        m[2] = MarketDef(bytes32("SOL-PERP"), "SOL-PERP", "SOLUSD", "SideKick SOL-PERP LP", "slpUSDC-SOL");
        m[3] = MarketDef(bytes32("HYPE-PERP"), "HYPE-PERP", "HYPEUSD", "SideKick HYPE-PERP LP", "slpUSDC-HYPE");
        m[4] = MarketDef(bytes32("LINK-PERP"), "LINK-PERP", "LINKUSD", "SideKick LINK-PERP LP", "slpUSDC-LINK");
    }
}
