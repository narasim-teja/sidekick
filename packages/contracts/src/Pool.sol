// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignedWad} from "./lib/SignedWad.sol";
import {LPToken} from "./LPToken.sol";
import {Vault} from "./Vault.sol";

/// @title Pool — the per-market universal counterparty + decrement absorber (Doc 1 §3.1, §3.3).
/// @notice One isolated Pool per market. It is the default counterparty to every position and the
///         absorber of decremented size, so it holds the **negative of the traders' net signed
///         quantity** — whatever traders do not balance among themselves, the pool holds ("skew is
///         the pool's risk", Doc 3 §4). It pays/receives funding like any account. Faithful on-chain
///         port of `packages/engine/src/sim/pool.ts`.
///
///         Two solvency bounds live here:
///           - Layer 1 (convex skew funding) lives in the funding math; the pool just receives the
///             funding it is owed, booked by the engine via {receiveFunding}.
///           - Layer 2 (OI cap vs capital) is {admits}: net pool-absorbed exposure ≤ `k · capital`,
///             checked before admitting any new position delta. The cap floats with live capital and
///             a trade that *reduces* exposure is always admitted (the balancing side is never refused).
///
///         The gap fund (Layer 4, POC token form) is held here and drawn only on the `E ≤ 0`
///         decrement branch — the single place bad debt enters the system.
///
/// @dev State units mirror the venue: `capital`, `gapFund` are USDC 6dp. The pool's net exposure is
///      stored as a signed base quantity `netQtyWad` (WAD, 18dp; + = pool net long) plus a
///      volume-weighted `entryMark` (18dp), exactly as the simulation tracks `netQty`/`entryMark` —
///      the one place a base-asset quantity is the natural state (it aggregates many positions).
///      Exposure and PnL are derived back into USDC 6dp for the cap check and reporting.
///
///      The mutating exposure/capital ops are **engine-only**: the engine orchestrates the §4.3 loop
///      and is the sole writer of pool exposure, so ordering stays atomic and the double-count bug
///      class (a Pashov finding on Ostium's close callback) cannot reappear via interleaved callers.
///      LP deposit/withdraw is permissionless and routes capital through the {Vault}.
contract Pool is Ownable, ReentrancyGuard {
    using SignedWad for int256;

    /// @notice Conversion between 6dp USDC and 18dp WAD (1e12).
    uint256 internal constant USDC_TO_WAD = 1e12;
    int256 internal constant USDC_TO_WAD_I = 1e12;

    /// @notice The market this pool backs (label/id; the registry owns the full config).
    bytes32 public immutable marketId;
    /// @notice The shared collateral vault (LP capital flows through it).
    Vault public immutable vault;
    /// @notice The branded LP share token (slpUSDC) for this pool.
    LPToken public lpToken;
    /// @notice The PerpEngine permitted to mutate exposure / capital during the loop.
    address public engine;

    /// @notice LP-backing capital in USDC 6dp — the stable headline number (Doc 1 §7).
    uint256 public capital;
    /// @notice Layer-4 gap fund reserve in USDC 6dp; drawn only on the E ≤ 0 branch.
    uint256 public gapFund;
    /// @notice Pool's net signed base-asset quantity in WAD (= −Σ trader signedQty). + = net long.
    int256 public netQtyWad;
    /// @notice Volume-weighted entry mark of the net exposure (WAD 18dp); 0 when flat.
    uint256 public entryMark;

    /// @notice Cumulative funding the pool received (+) / paid (−), USDC 6dp (reporting).
    int256 public fundingAccrued;
    /// @notice Cumulative bad debt absorbed via the gap fund, USDC 6dp (reporting).
    uint256 public badDebtAbsorbed;

    event EngineSet(address indexed engine);
    event LpTokenSet(address indexed lpToken);
    event LPDeposited(address indexed lp, uint256 amount, uint256 shares);
    event LPWithdrawn(address indexed lp, uint256 shares, uint256 amount);
    event Absorbed(int256 traderDeltaQtyWad, uint256 mark, int256 newNetQtyWad);
    event CapitalChanged(int256 delta, uint256 newCapital);
    event FundingReceived(int256 amount, uint256 newCapital);
    event GapFundDrawn(uint256 amount, uint256 covered, uint256 shortfall);
    event GapFundSeeded(uint256 amount);

    error OnlyEngine();
    error EngineAlreadySet();
    error LpTokenAlreadySet();
    error ZeroAmount();
    error ZeroAddress();
    error ZeroShares();
    error InsufficientShares();

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(bytes32 marketId_, address vault_, address initialOwner) Ownable(initialOwner) {
        if (vault_ == address(0)) revert ZeroAddress();
        marketId = marketId_;
        vault = Vault(vault_);
    }

    /// @notice Wire the LP token once (deployed after the pool so it can reference it). Owner-only.
    function setLpToken(address lpToken_) external onlyOwner {
        if (address(lpToken) != address(0)) revert LpTokenAlreadySet();
        if (lpToken_ == address(0)) revert ZeroAddress();
        lpToken = LPToken(lpToken_);
        emit LpTokenSet(lpToken_);
    }

    /// @notice Wire the engine once. Owner-only, single-shot.
    function setEngine(address engine_) external onlyOwner {
        if (engine != address(0)) revert EngineAlreadySet();
        if (engine_ == address(0)) revert ZeroAddress();
        engine = engine_;
        emit EngineSet(engine_);
    }

    // ── LP flows (permissionless; capital flows through the Vault) ──────────────────

    /// @notice Provide `amount` USDC of liquidity from the LP's vault free collateral, minting
    ///         pro-rata slpUSDC. Shares = amount at genesis (1:1), else `amount · supply / capital`.
    /// @dev The LP must already hold ≥ `amount` free collateral in the Vault (deposited via
    ///      `Vault.deposit`). This moves it from the LP's free collateral into pool capital.
    function provideLiquidity(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        uint256 supply = lpToken.totalSupply();
        // Shares use pre-deposit capital. Genesis (or a fully-drawn-down pool) is 1:1.
        shares = (supply == 0 || capital == 0) ? amount : (amount * supply) / capital;
        // Guard the rounding edge: if `amount · supply < capital` the share math truncates to 0 and
        // the LP would gift `amount` to existing holders for no claim. Revert instead (a deposit too
        // small to earn a share is never intended).
        if (shares == 0) revert ZeroShares();
        // Move the LP's free collateral into pool capital (the USDC stays custodied in the Vault;
        // only the claim moves from `freeCollateral` to `capital`).
        vault.debitCollateral(msg.sender, amount);
        capital += amount;
        lpToken.mint(msg.sender, shares);
        emit LPDeposited(msg.sender, amount, shares);
    }

    /// @notice Redeem `shares` slpUSDC for pro-rata pool value, credited back to the LP's vault free
    ///         collateral. The payout is gated on the pool's live EQUITY at `mark`, not raw `capital`
    ///         (Doc 1 §3.4 withdrawal-of-un-utilized-capital rule): an LP cannot withdraw capital that
    ///         is backing winning traders' open profit, because that capital is the exact future debit
    ///         when those positions close (the pool books `−realizedPnl`). Concretely, the pool must
    ///         retain at least its unrealized LOSS `max(0, −pricePnl(mark))`, so the per-share value is
    ///         taken against pool equity (= capital + pricePnl) floored at 0. `mark` is injected,
    ///         consistent with the Phase-2 mark model (the engine/SDK supplies the current mark).
    /// @dev Without this gate an LP could exit at par while the pool is underwater on open positions,
    ///      stranding the winners (a bank-run / first-mover-extraction surface the sim never modeled).
    function withdrawLiquidity(uint256 shares, uint256 mark) external nonReentrant returns (uint256 amount) {
        if (shares == 0) revert ZeroAmount();
        uint256 supply = lpToken.totalSupply();
        if (shares > lpToken.balanceOf(msg.sender)) revert InsufficientShares();

        // Pool equity at mark, floored at 0 — the value LPs collectively have a claim on.
        int256 eq = int256(capital) + pricePnl(mark);
        uint256 withdrawableValue = eq > 0 ? uint256(eq) : 0;
        // Per-share payout against equity, but never more than free `capital` (the cash actually held;
        // unrealized gains are not yet cash and cannot be paid out).
        amount = (shares * withdrawableValue) / supply;
        if (amount > capital) amount = capital;

        lpToken.burn(msg.sender, shares);
        capital -= amount;
        vault.creditCollateral(msg.sender, amount);
        emit LPWithdrawn(msg.sender, shares, amount);
    }

    /// @notice Seed the gap fund with `amount` USDC from the caller's vault free collateral
    ///         (Layer-4 reserve; in production funded by a skim of the funding stream).
    function seedGapFund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        vault.debitCollateral(msg.sender, amount);
        gapFund += amount;
        emit GapFundSeeded(amount);
    }

    // ── Engine-only exposure + capital accounting (§4.3 loop) ───────────────────────

    /// @notice The §3.3 Layer-2 hard ceiling. Returns true iff admitting an additional pool-side
    ///         signed-quantity delta `poolDeltaQtyWad` keeps |pool exposure| within `k · capital` at
    ///         `mark`. A trade that does not increase exposure is always admitted (reducing skew is
    ///         never blocked). Pure view — the engine calls it before {absorb}.
    /// @param poolDeltaQtyWad The side the pool would take (i.e. the *opposite* of the trader's), WAD.
    /// @param mark            Current mark, WAD 18dp.
    /// @param k               OI-cap multiplier (integer).
    function admits(int256 poolDeltaQtyWad, uint256 mark, uint256 k) public view returns (bool) {
        int256 newNetQty = netQtyWad + poolDeltaQtyWad;
        uint256 newExposure = _exposureOf(newNetQty, mark);
        uint256 curExposure = _exposureOf(netQtyWad, mark);
        if (newExposure <= curExposure) return true; // never block a de-risking trade
        return newExposure <= k * capital;
    }

    /// @notice Absorb a trader opening/changing a position: the pool takes the opposite side.
    ///         `traderDeltaQtyWad` is the signed change in the *trader's* base quantity (WAD); the
    ///         pool absorbs `−traderDeltaQtyWad`, updating its volume-weighted entry mark so its
    ///         mark-to-market PnL is exact. Faithful port of `pool.ts`'s `absorb`. Engine-only.
    /// @dev Caller MUST have checked {admits} for the opening direction. Realized PnL on a
    ///      shrink/flip is booked by the engine via {adjustCapital} (the mirror of the trader's
    ///      realized PnL), so the pool's reported unrealized PnL stays exactly −Σ(open-trader
    ///      unrealized PnL) and capital is conserved.
    function absorb(int256 traderDeltaQtyWad, uint256 mark) external onlyEngine {
        int256 poolDelta = -traderDeltaQtyWad;
        int256 prevQty = netQtyWad;
        int256 newQty = prevQty + poolDelta;

        bool growingSameDir = (prevQty == 0 || _sameSign(prevQty, newQty)) && _absGte(newQty, prevQty);

        if (growingSameDir) {
            // Weight the new lot in at `mark`: entryMark = (prevQty·entryMark + addedQty·mark)/newQty.
            int256 addedQty = newQty - prevQty;
            int256 prevNotional = prevQty * int256(entryMark); // WAD·WAD (scaled out by div below)
            int256 addedNotional = addedQty * int256(mark);
            entryMark = newQty == 0 ? 0 : uint256((prevNotional + addedNotional) / newQty);
        } else if (!_sameSign(prevQty, newQty) && newQty != 0) {
            // Crossed through zero (flip): remaining exposure is freshly opened at `mark`.
            entryMark = mark;
        }
        // Shrinking same-direction exposure keeps the basis (realized PnL booked by the engine).
        netQtyWad = newQty;
        if (newQty == 0) entryMark = 0;
        emit Absorbed(traderDeltaQtyWad, mark, newQty);
    }

    /// @notice Apply a signed capital `delta` (USDC 6dp) — booking realized PnL the pool earns (+)
    ///         or pays (−) as the mirror of a trader's realized PnL on close/decrement. Engine-only.
    /// @return shortfall The portion of a loss (− delta) the pool could NOT cover from capital + gap
    ///         fund — uncovered bad debt the trader is therefore not paid (the socialized-deleveraging
    ///         tail, out of scope for the POC). 0 on a gain or a fully-covered loss. The engine uses
    ///         it to credit the trader only the cash that actually existed, so Σ(claims) is conserved.
    /// @dev Never reverts on a large loss: the pool is the counterparty and a trader gain exceeding
    ///      pool capital is exactly the insolvency event the gap fund backstops. Capital floors at 0;
    ///      the gap fund covers the overflow; any residual is recorded bad debt — so close/checkpoint
    ///      can never be bricked by a winning counterparty (a real liveness bug this guards against).
    function adjustCapital(int256 delta) external onlyEngine returns (uint256 shortfall) {
        if (delta >= 0) {
            capital += uint256(delta);
            emit CapitalChanged(delta, capital);
            return 0;
        }
        shortfall = _debitCapital(uint256(-delta));
        emit CapitalChanged(delta, capital);
    }

    /// @notice Credit the pool the net funding it is owed this block (Layer-1 pays the pool for the
    ///         risk it holds): + received, − paid. Engine-only.
    /// @return shortfall Net funding the pool owes traders beyond capital + gap fund (0 in practice;
    ///         the pool is seeded far above a single block's funding). Surfaced for conservation.
    function receiveFunding(int256 amount) external onlyEngine returns (uint256 shortfall) {
        if (amount >= 0) {
            capital += uint256(amount);
        } else {
            shortfall = _debitCapital(uint256(-amount));
        }
        fundingAccrued += amount;
        emit FundingReceived(amount, capital);
    }

    /// @dev Debit `amount` of cash the pool owes: from capital down to 0, then from the gap fund;
    ///      any remainder is uncovered bad debt (returned as `shortfall` and recorded). Never reverts.
    function _debitCapital(uint256 amount) internal returns (uint256 shortfall) {
        if (amount <= capital) {
            capital -= amount;
            return 0;
        }
        uint256 fromGap = amount - capital;
        capital = 0;
        (, shortfall) = _drawGap(fromGap);
    }

    /// @dev Internal gap-fund draw shared by {drawGapFund} and {_debitCapital}.
    function _drawGap(uint256 amount) internal returns (uint256 covered, uint256 shortfall) {
        covered = amount <= gapFund ? amount : gapFund;
        gapFund -= covered;
        badDebtAbsorbed += covered;
        shortfall = amount - covered;
        emit GapFundDrawn(amount, covered, shortfall);
    }

    /// @notice Draw `amount` of bad debt from the gap fund (Layer 4) on the E ≤ 0 gap branch. Returns
    ///         how much was covered; any shortfall (gap fund exhausted) is the residual that, in the
    ///         full design, hits socialized deleveraging — surfaced so the engine can flag it.
    ///         Engine-only. `badDebtAbsorbed` accrues the covered cash (what actually left the fund).
    function drawGapFund(uint256 amount) external onlyEngine returns (uint256 covered, uint256 shortfall) {
        return _drawGap(amount);
    }

    // ── Views (USDC 6dp) ────────────────────────────────────────────────────────────

    /// @notice Pool's net notional exposure at `mark`: |netQty| · mark, in USDC 6dp.
    function exposure(uint256 mark) external view returns (uint256) {
        return _exposureOf(netQtyWad, mark);
    }

    /// @notice The live Layer-2 cap this exposure is checked against: k · capital, USDC 6dp.
    function cap(uint256 k) external view returns (uint256) {
        return k * capital;
    }

    /// @notice Pool's unrealized price PnL at `mark`: netQty · (mark − entryMark), USDC 6dp.
    function pricePnl(uint256 mark) public view returns (int256) {
        if (netQtyWad == 0) return 0;
        int256 diff = int256(mark) - int256(entryMark); // WAD
        // netQtyWad (WAD base) · diff (WAD price) / 1e18 = WAD USDC(18dp); /1e12 → 6dp.
        return (netQtyWad * diff) / SignedWad.WAD / USDC_TO_WAD_I;
    }

    /// @notice Total pool equity at `mark`: capital + unrealized exposure PnL, USDC 6dp.
    function equity(uint256 mark) external view returns (int256) {
        return int256(capital) + pricePnl(mark);
    }

    // ── Internal ─────────────────────────────────────────────────────────────────

    /// @dev |netQty (WAD base)| · mark (WAD price) → USDC 6dp. /1e18 de-scales qty, /1e12 → 6dp.
    function _exposureOf(int256 qtyWad, uint256 mark) internal pure returns (uint256) {
        uint256 absQty = uint256(qtyWad >= 0 ? qtyWad : -qtyWad);
        return (absQty * mark) / uint256(SignedWad.WAD) / USDC_TO_WAD;
    }

    function _sameSign(int256 a, int256 b) internal pure returns (bool) {
        return (a >= 0) == (b >= 0);
    }

    function _absGte(int256 a, int256 b) internal pure returns (bool) {
        int256 aa = a >= 0 ? a : -a;
        int256 bb = b >= 0 ? b : -b;
        return aa >= bb;
    }
}
