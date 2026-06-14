// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Vault} from "../src/Vault.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {Pool} from "../src/Pool.sol";
import {LPToken} from "../src/LPToken.sol";
import {MarkReceiver} from "../src/oracle/MarkReceiver.sol";
import {CheckpointSettler} from "../src/oracle/CheckpointSettler.sol";
import {SideKickUSDC} from "../src/test/SideKickUSDC.sol";
import {MarketParams} from "../src/Types.sol";
import {Params} from "../src/generated/Params.sol";

/// @title DeployCreVenue — an ISOLATED venue whose Layer-C settlement is driven by Chainlink CRE.
/// @notice Stands up a fresh Vault → MarketRegistry → PerpEngine → Pool → LPToken → MarkReceiver →
///         CheckpointSettler for ONE market, registers it with MarkReceiver as the oracle, and hands
///         the PerpEngine's ownership to the CheckpointSettler — so a CRE settlement report routed
///         through the settler's `onReport` can call `checkpoint`. Kept separate from the live venue
///         so the working deployment is untouched (Phase 6, settlement half).
///
///         Both the MarkReceiver and the CheckpointSettler allowlist the production Arc
///         KeystoneForwarder AND the local CRE simulator forwarder, so `cre workflow simulate
///         --broadcast` lands real on-chain writes.
///
/// @dev Run (dry):    forge script script/DeployCreVenue.s.sol --rpc-url arc_testnet
///      Live:         forge script script/DeployCreVenue.s.sol --rpc-url arc_testnet --broadcast
///      Env: MARKET (default "LINK-PERP"), CHAINLINK_FEED_<SYMBOL> (the Data Streams feed id),
///           CHAINLINK_FORWARDER (Arc KeystoneForwarder), CRE_SIM_FORWARDER (the simulator forwarder),
///           USDC_ADDRESS (canonical Arc USDC; else a local test token for dry runs).
contract DeployCreVenue is Script {
    uint256 internal constant BLOCK_SECONDS = 2;
    uint256 internal constant FUNDING_PERIOD_SECONDS = 8 hours;
    address internal constant ARC_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant CRE_SIM_FORWARDER = 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1;

    function run() external {
        address deployer = msg.sender;
        string memory symbol = vm.envOr("MARKET", string("LINK-PERP"));
        bytes32 marketId = bytes32(bytes(symbol));
        bytes32 feedId = vm.envBytes32(_feedEnvKey(symbol));
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));

        address[] memory forwarders = new address[](2);
        forwarders[0] = vm.envOr("CHAINLINK_FORWARDER", ARC_FORWARDER);
        forwarders[1] = vm.envOr("CRE_SIM_FORWARDER", CRE_SIM_FORWARDER);

        vm.startBroadcast();

        if (usdcAddr == address(0)) {
            usdcAddr = address(new SideKickUSDC());
            console2.log("WARNING: deployed test USDC (no USDC_ADDRESS). Local/dry run only.");
        }

        // Core venue, deployer-owned during wiring.
        Vault vault = new Vault(usdcAddr, deployer);
        MarketRegistry registry = new MarketRegistry(deployer);
        PerpEngine engine =
            new PerpEngine(address(registry), address(vault), BLOCK_SECONDS, FUNDING_PERIOD_SECONDS, deployer);
        Pool pool = new Pool(marketId, address(vault), deployer);
        LPToken lp = new LPToken(string.concat("SideKick ", symbol, " LP"), "slpUSDC-CRE", address(pool));

        // The Chainlink leg: MarkReceiver (oracle + CRE consumer) and CheckpointSettler (CRE consumer
        // that owns the engine). Both gated to the forwarder set.
        MarkReceiver receiver = new MarkReceiver(forwarders, feedId, deployer);
        CheckpointSettler settler = new CheckpointSettler(address(engine), forwarders, deployer);

        // Wire: pool ↔ lp/engine, vault operators, register the market with MarkReceiver as the oracle.
        pool.setLpToken(address(lp));
        pool.setEngine(address(engine));
        vault.setOperator(address(engine), true);
        vault.setOperator(address(pool), true);

        MarketParams memory params = Params.defaults();
        registry.registerMarket(marketId, symbol, params, address(pool), address(receiver), feedId);

        // Hand the engine to the settler so CRE-routed checkpoint() is authorized. (The settler's own
        // owner stays the deployer — admin of the forwarder allowlist + the ownership escape hatch.)
        engine.transferOwnership(address(settler));

        vm.stopBroadcast();

        console2.log("=== SideKick CRE-settled venue ===");
        console2.log("market:         ", symbol);
        console2.log("USDC:           ", usdcAddr);
        console2.log("Vault:          ", address(vault));
        console2.log("MarketRegistry: ", address(registry));
        console2.log("PerpEngine:     ", address(engine));
        console2.log("Pool:           ", address(pool));
        console2.log("LPToken:        ", address(lp));
        console2.log("MarkReceiver:   ", address(receiver));
        console2.log("CheckpointSettler:", address(settler));
        console2.log("(engine owner is now the settler:", engine.owner(), ")");
    }

    /// @dev "BTC-PERP" -> "CHAINLINK_FEED_BTCPERP".
    function _feedEnvKey(string memory symbol) internal pure returns (string memory) {
        bytes memory b = bytes(symbol);
        uint256 keep;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] != 0x2d) keep++;
        }
        bytes memory out = new bytes(keep);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] != 0x2d) {
                out[j] = b[i];
                j++;
            }
        }
        return string.concat("CHAINLINK_FEED_", string(out));
    }
}
