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
import {ChainlinkAdapter} from "../src/oracle/ChainlinkAdapter.sol";
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

    /// @dev Per-market oracle source chosen at deploy time from env (default Stork — the proven
    ///      Spike-B path). Set ORACLE_SOURCE=chainlink for a global default, or
    ///      ORACLE_SOURCE_<SYMBOL_NO_DASH>=chainlink per market (e.g. ORACLE_SOURCE_LINKPERP=chainlink).
    ///      Mirrors the off-chain engine's ORACLE_SOURCE / ORACLE_SOURCE_<MARKET> resolution so the
    ///      registered adapter and the engine's reader agree on the source per market.
    enum Source {
        Stork,
        Chainlink
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

        // The market SET is configurable: MARKETS=BTC-PERP,LINK-PERP (or "all"/unset → all five).
        // The engine reads the SAME `MARKETS` var (resolveMarketSet) so the chain and the off-chain
        // service agree on which markets exist. Each selected def is filtered from the five in _markets().
        MarketDef[] memory markets = _selectedMarkets();
        Pool[] memory pools = new Pool[](markets.length);

        // Chainlink Data Streams Verifier proxy + fee token on Arc (env; address(0) = not-yet-live,
        // adapter runs in relay mode). Only read when at least one market resolves to Chainlink.
        address clVerifier = vm.envOr("CHAINLINK_VERIFIER", address(0));
        address clFeeToken = vm.envOr("CHAINLINK_FEE_TOKEN", address(0));

        for (uint256 i = 0; i < markets.length; i++) {
            MarketDef memory md = markets[i];

            Pool pool = new Pool(md.id, address(vault), deployer);
            LPToken lp = new LPToken(md.lpName, md.lpSymbol, address(pool));
            pool.setLpToken(address(lp));
            pool.setEngine(address(engine));
            vault.setOperator(address(pool), true); // pool moves LP capital claims
            pools[i] = pool;

            // feedId semantics are PER SOURCE:
            //   Stork     → keccak256(utf8(asset))           (Spike B convention)
            //   Chainlink → a FIXED 32-byte Data Streams id  (from CHAINLINK_FEED_<SYMBOL> env;
            //               NOT derivable from the symbol). Recorded verbatim in the registry.
            Source src = _sourceFor(md.symbol);
            address adapter;
            bytes32 feedId;
            if (src == Source.Chainlink) {
                feedId = vm.envBytes32(_feedEnvKey(md.symbol)); // required: no symbol-derivable default
                adapter = address(new ChainlinkAdapter(clVerifier, feedId, clFeeToken, deployer));
                console2.log(md.symbol, "[chainlink]");
            } else {
                feedId = keccak256(bytes(md.asset)); // Stork: keccak256(utf8(symbol)) — Spike B
                adapter = address(new StorkAdapter(STORK, feedId));
                console2.log(md.symbol, "[stork]");
            }

            registry.registerMarket(md.id, md.symbol, params, address(pool), adapter, feedId);

            console2.log("  pool:    ", address(pool));
            console2.log("  lpToken: ", address(lp));
            console2.log("  oracle:  ", adapter);
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

    function _markets() internal pure returns (MarketDef[6] memory m) {
        m[0] = MarketDef(bytes32("BTC-PERP"), "BTC-PERP", "BTCUSD", "SideKick BTC-PERP LP", "slpUSDC-BTC");
        m[1] = MarketDef(bytes32("ETH-PERP"), "ETH-PERP", "ETHUSD", "SideKick ETH-PERP LP", "slpUSDC-ETH");
        m[2] = MarketDef(bytes32("SOL-PERP"), "SOL-PERP", "SOLUSD", "SideKick SOL-PERP LP", "slpUSDC-SOL");
        m[3] = MarketDef(bytes32("HYPE-PERP"), "HYPE-PERP", "HYPEUSD", "SideKick HYPE-PERP LP", "slpUSDC-HYPE");
        m[4] = MarketDef(bytes32("LINK-PERP"), "LINK-PERP", "LINKUSD", "SideKick LINK-PERP LP", "slpUSDC-LINK");
        m[5] = MarketDef(bytes32("XAU-PERP"), "XAU-PERP", "XAUUSD", "SideKick XAU-PERP LP", "slpUSDC-XAU");
    }

    /// @notice The market SET to deploy, filtered from the canonical five by the MARKETS env var.
    /// @dev MARKETS is a comma list (e.g. "BTC-PERP,LINK-PERP") or "all"/unset → all five. Unknown
    ///      symbols are ignored (mirrors the engine's marketsFromEnv silent-drop behavior). The
    ///      registry imposes no count, so deploying a subset is first-class — only this script ever
    ///      bounded it to five. Returns a right-sized dynamic array.
    function _selectedMarkets() internal view returns (MarketDef[] memory selected) {
        MarketDef[6] memory all = _markets();
        string memory raw = vm.envOr("MARKETS", string(""));

        if (bytes(raw).length == 0 || _eq(raw, "all")) {
            selected = new MarketDef[](6);
            for (uint256 i = 0; i < 6; i++) {
                selected[i] = all[i];
            }
            return selected;
        }

        string[] memory wanted = vm.split(raw, ",");
        // First pass: count matches so we can size the output array exactly.
        uint256 n;
        for (uint256 i = 0; i < 6; i++) {
            if (_contains(wanted, all[i].symbol)) n++;
        }
        require(n > 0, "MARKETS matched no known market");

        selected = new MarketDef[](n);
        uint256 j;
        for (uint256 i = 0; i < 6; i++) {
            if (_contains(wanted, all[i].symbol)) {
                selected[j++] = all[i];
            }
        }
    }

    /// @notice Resolve a market's oracle source from env: ORACLE_SOURCE_<SYMBOL> overrides the
    ///         global ORACLE_SOURCE, which defaults to "stork". <SYMBOL> strips the dash, e.g.
    ///         ORACLE_SOURCE_LINKPERP (dashes are not valid env-var characters).
    function _sourceFor(string memory symbol) internal view returns (Source) {
        string memory perMarket = vm.envOr(_sourceEnvKey(symbol), string(""));
        string memory chosen =
            bytes(perMarket).length > 0 ? perMarket : vm.envOr("ORACLE_SOURCE", string("stork"));
        if (_eq(chosen, "chainlink")) return Source.Chainlink;
        require(_eq(chosen, "stork"), "ORACLE_SOURCE must be 'stork' or 'chainlink'");
        return Source.Stork;
    }

    /// @dev "BTC-PERP" → "ORACLE_SOURCE_BTCPERP".
    function _sourceEnvKey(string memory symbol) internal pure returns (string memory) {
        return string.concat("ORACLE_SOURCE_", _stripDash(symbol));
    }

    /// @dev "BTC-PERP" → "CHAINLINK_FEED_BTCPERP" (the fixed Data Streams 32-byte id for this market).
    function _feedEnvKey(string memory symbol) internal pure returns (string memory) {
        return string.concat("CHAINLINK_FEED_", _stripDash(symbol));
    }

    // ── small string helpers (forge-std lacks these) ─────────────────────────────

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _contains(string[] memory xs, string memory target) private pure returns (bool) {
        for (uint256 i = 0; i < xs.length; i++) {
            if (_eq(_trim(xs[i]), target)) return true;
        }
        return false;
    }

    /// @dev Strip surrounding ASCII spaces (env list items may be " ETH-PERP").
    function _trim(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 start;
        uint256 end = b.length;
        while (start < end && b[start] == 0x20) start++;
        while (end > start && b[end - 1] == 0x20) end--;
        bytes memory out = new bytes(end - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = b[start + i];
        }
        return string(out);
    }

    /// @dev Remove '-' so a symbol is a valid env-var suffix: "BTC-PERP" → "BTCPERP".
    function _stripDash(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 keep;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] != 0x2d) keep++; // 0x2d = '-'
        }
        bytes memory out = new bytes(keep);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] != 0x2d) {
                out[j] = b[i];
                j++;
            }
        }
        return string(out);
    }
}
