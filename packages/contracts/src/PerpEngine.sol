// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SignedWad} from "./lib/SignedWad.sol";
import {Funding} from "./lib/Funding.sol";
import {Decrement} from "./lib/Decrement.sol";
import {MarketParams, Position, Side} from "./Types.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {Vault} from "./Vault.sol";
import {Pool} from "./Pool.sol";

/// @title PerpEngine — the authoritative on-chain state machine (Doc 2 §2.1).
/// @notice The on-chain port of `packages/engine/src/sim/market.ts`. It owns positions, opens/closes
///         them under Layer-2 admission control, and — once per checkpoint — runs the EXACT §4.3
///         loop on-chain for a market:
///
///           0. apply opens/closes (admission-controlled)   ← separate txns (open/close)
///           1. mark      — equity at the new price          ┐
///           2. fund      — equity ±= funding_payment        │
///           3. check     — healthy iff E ≥ m·N (post-fund)  │  checkpoint(marketId, mark)
///           4. call      — else margin call (m·N − E)       │  runs 1→6 atomically per position
///           5. settle    — top up from free collateral      │
///           6. decrement — else N'=E/m (E>0) or gap (E≤0)   ┘
///
///         Mark, THEN fund, THEN check against the post-funding equity, THEN decrement on that
///         equity — never recompute equity out of order. This ordering is the anti-double-count
///         guarantee (a Pashov audit flagged the reverse in Ostium's close callback). Keeping the
///         whole loop in one contract, as the sole writer of pool exposure, is what makes that
///         guarantee hold: no interleaving caller can split mark from fund.
///
///         Mark is **injected** in Phase 2 (engine/test harness passes it to {checkpoint}); the
///         oracle adapter recorded in the registry is wired in Phase 3/6. Margin-call *payments*
///         are off-chain (Gateway nanopayments) — here the settle step models them as a top-up from
///         the account's Vault free collateral, clamped to the shortfall, exactly as the simulation's
///         responder pays `min(shortfall, freeCollateral)`; a "dark" agent simply has no free
///         collateral to draw on. In Phase 3 the amount answered becomes an off-chain agent decision.
///
/// @dev Conservation (mirrored from the sim, asserted in tests): the pool is the universal
///      counterparty, so its unrealized PnL is by construction −Σ(open-trader unrealized PnL).
///      Realized PnL is booked into pool capital on every close/decrement/gap (the mirror of the
///      trader's realized PnL). Funding is a zero-sum transfer trader ↔ pool. The gap-fund draw on
///      the E ≤ 0 branch is the only bad-debt sink. Units: USDC 6dp money; mark + dimensionless
///      params in WAD 18dp.
contract PerpEngine is Ownable, ReentrancyGuard {
    using SignedWad for int256;
    using Funding for *;
    using Decrement for *;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice 6dp-USDC ↔ 18dp-WAD scale (1e12) and 1e30 = 1e18 · 1e12 for notional→qty.
    uint256 internal constant USDC_TO_WAD = 1e12;
    int256 internal constant NOTIONAL_TO_QTY = 1e30; // entryNotional(6dp)·1e30/mark(18dp) = qty(WAD)

    /// @notice Block cadence Δt and funding period T (seconds) for the N·rate·(Δt/T) payment.
    uint256 public immutable blockSeconds;
    uint256 public immutable fundingPeriodSeconds;

    MarketRegistry public immutable registry;
    Vault public immutable vault;

    /// @notice marketId → account → position.
    mapping(bytes32 => mapping(address => Position)) private _positions;
    /// @notice marketId → the set of accounts with a LIVE (non-flat) position. Maintained on
    ///         open/close/gap so the CRE settlement workflow (Phase 6) can read the checkpoint
    ///         account set on-chain ({openAccounts}) — fully decentralized, no off-chain list to trust.
    mapping(bytes32 => EnumerableSet.AddressSet) private _openAccounts;
    /// @notice marketId → carried EMA state S_smooth (WAD), threaded across checkpoints.
    mapping(bytes32 => int256) public smoothSkewPrev;
    /// @notice marketId → last checkpoint index (monotonic; the Layer-C cadence counter).
    mapping(bytes32 => uint256) public checkpointCount;

    // ── Events (the dashboard/feed payload — Doc 1 §7) ──────────────────────────────
    event PositionOpened(
        bytes32 indexed marketId, address indexed account, Side side, uint256 notional, uint256 margin, uint256 mark
    );
    event PositionClosed(bytes32 indexed marketId, address indexed account, int256 realizedPnl, uint256 mark);
    event Checkpoint(
        bytes32 indexed marketId,
        uint256 indexed index,
        uint256 mark,
        int256 skew,
        int256 smoothSkew,
        int256 fundingRate,
        uint256 oiLong,
        uint256 oiShort
    );
    event PositionReconciled(
        bytes32 indexed marketId,
        address indexed account,
        int256 equity,
        int256 funding,
        uint256 call,
        uint256 paid,
        Decrement.Kind outcome,
        uint256 notionalBefore,
        uint256 notionalAfter
    );
    event GapShortfall(bytes32 indexed marketId, address indexed account, uint256 shortfall);

    error MarketNotFound();
    error PositionAlreadyOpen();
    error NoPosition();
    error ZeroMark();
    error ZeroNotional();
    error OICapExceeded();
    error InsufficientFreeCollateral();

    constructor(
        address registry_,
        address vault_,
        uint256 blockSeconds_,
        uint256 fundingPeriodSeconds_,
        address initialOwner
    ) Ownable(initialOwner) {
        registry = MarketRegistry(registry_);
        vault = Vault(vault_);
        blockSeconds = blockSeconds_;
        fundingPeriodSeconds = fundingPeriodSeconds_;
    }

    // ── Step 0: opens / closes (admission-controlled) ───────────────────────────────

    /// @notice Open a position in `marketId`: post `margin` from free collateral and take `notional`
    ///         of exposure at `mark`; the pool absorbs the opposite quantity (Layer-2 checked first).
    ///         One position per account per market (POC). `mark` is injected (Phase 2).
    function openPosition(bytes32 marketId, Side side, uint256 notional, uint256 margin, uint256 mark)
        external
        nonReentrant
    {
        if (mark == 0) revert ZeroMark();
        if (notional == 0) revert ZeroNotional();
        if (side == Side.Flat) revert ZeroNotional();
        Position storage p = _positions[marketId][msg.sender];
        if (p.side != Side.Flat) revert PositionAlreadyOpen();

        (Pool pool, MarketParams memory params) = _poolAndParams(marketId);

        // Layer 2: the pool absorbs −traderDeltaQty; refuse if that breaches k·capital at `mark`.
        int256 traderQtyWad = _qtyWad(notional, mark, side);
        if (!pool.admits(-traderQtyWad, mark, params.k)) revert OICapExceeded();

        // Post margin from free collateral (reverts if insufficient).
        vault.debitCollateral(msg.sender, margin);

        p.side = side;
        p.entryNotional = notional;
        p.entryMark = mark;
        p.margin = margin;
        _openAccounts[marketId].add(msg.sender); // track for the on-chain checkpoint account set

        pool.absorb(traderQtyWad, mark);
        emit PositionOpened(marketId, msg.sender, side, notional, margin, mark);
    }

    /// @notice Close the caller's position at `mark`: realize price PnL against the pool, return the
    ///         remaining equity to free collateral, and unwind the pool's offsetting exposure.
    function closePosition(bytes32 marketId, uint256 mark) external nonReentrant {
        if (mark == 0) revert ZeroMark();
        _closeFor(marketId, msg.sender, mark);
    }

    // ── Steps 1–6: the per-block checkpoint loop (§4.3) ─────────────────────────────

    /// @notice Run one checkpoint for `marketId` at the injected `mark`: recompute skew + funding
    ///         from the live book, then for every account run mark → fund → check → settle →
    ///         decrement in that exact order. Engine-owner-gated (the trusted operator / CRE in
    ///         Phase 6 calls it at the Layer-C cadence). `accounts` is the position set to reconcile
    ///         (the engine enumerates open positions off-chain and passes them; the contract verifies
    ///         each has a live position and skips flats).
    /// @dev Funding is computed once from the post-`mark` open interest, then applied per position.
    ///      The pool receives the mirror of all trader funding at the end (Layer-1 pays the pool).
    function checkpoint(bytes32 marketId, uint256 mark, address[] calldata accounts) external onlyOwner nonReentrant {
        if (mark == 0) revert ZeroMark();
        (Pool pool, MarketParams memory params) = _poolAndParams(marketId);

        // Skew + funding from the live book (§4.1).
        (uint256 oiLong, uint256 oiShort) = _openInterest(marketId, accounts, mark);
        int256 s = Funding.skew(oiLong, oiShort);
        int256 sSmooth = Funding.smoothSkew(s, smoothSkewPrev[marketId], params.lambda);
        smoothSkewPrev[marketId] = sSmooth;
        int256 rate = Funding.fundingRate(
            sSmooth, Funding.Params({alpha: params.alpha, rMax: params.rMax, lambda: params.lambda})
        );

        int256 poolFundingReceived = 0;

        for (uint256 i = 0; i < accounts.length; i++) {
            address acct = accounts[i];
            Position storage p = _positions[marketId][acct];
            if (p.side == Side.Flat) continue;

            poolFundingReceived += _reconcileOne(marketId, acct, p, pool, params, mark, rate);
        }

        // Pool receives −Σ(trader funding): Layer-1 pays the pool for the risk it holds.
        pool.receiveFunding(poolFundingReceived);

        uint256 idx = ++checkpointCount[marketId];
        emit Checkpoint(marketId, idx, mark, s, sSmooth, rate, oiLong, oiShort);
    }

    /// @dev Reconcile a single position through steps 1–6. Returns the funding the POOL receives
    ///      from this position (= −trader funding), to be summed and booked once by the caller.
    function _reconcileOne(
        bytes32 marketId,
        address acct,
        Position storage p,
        Pool pool,
        MarketParams memory params,
        uint256 mark,
        int256 rate
    ) internal returns (int256 poolFundingFromThis) {
        uint256 notionalBefore = p.entryNotional;
        uint256 notionalNow = _notionalAt(p, mark);

        // 2. fund — magnitude = N · rate · (Δt/T); sign: rate>0 → longs pay, shorts receive.
        //    Funding is a transfer of REAL cash: it moves the position's `margin` claim, and the
        //    pool receives exactly what the trader's margin gave up (paid funding is floored at the
        //    available margin cash — a position cannot pay funding out of unrealized PnL on-chain;
        //    any resulting shortfall vs maintenance is caught by the margin-call/decrement path,
        //    which realizes PnL into cash). `funding` (signed, for the event/equity) is the intended
        //    cashflow; `cashMoved` is what actually transferred.
        int256 magnitude = Funding.fundingPayment(notionalNow, rate, blockSeconds, fundingPeriodSeconds);
        int256 sideSign = p.side == Side.Long ? int256(1) : int256(-1);
        int256 funding = -sideSign * magnitude; // + received, − paid (intended)
        poolFundingFromThis = _applyFunding(p, funding); // pool gets −(cash the margin gained)

        // 1+2 settled. Equity at new price on the post-funding margin.
        int256 equity = _equityAt(p, mark);

        // 3. check — healthy iff E ≥ m·N (post-funding equity vs current notional).
        uint256 call = Decrement.marginCall(equity, notionalNow, params.m);
        if (call == 0) {
            emit PositionReconciled(
                marketId, acct, equity, funding, 0, 0, Decrement.Kind.Healthy, notionalBefore, notionalBefore
            );
            return poolFundingFromThis;
        }

        // 4 + 5. call + settle — top up from the account's free collateral, clamped to the shortfall
        // (mirrors the sim's responder paying min(shortfall, freeCollateral); dark = no collateral).
        uint256 free = vault.freeCollateral(acct);
        uint256 paid = call <= free ? call : free;
        if (paid > 0) {
            vault.debitCollateral(acct, paid);
            p.margin += paid;
            equity += int256(paid);
        }
        if (Decrement.isHealthy(equity, notionalNow, params.m)) {
            emit PositionReconciled(
                marketId, acct, equity, funding, call, paid, Decrement.Kind.Healthy, notionalBefore, notionalBefore
            );
            return poolFundingFromThis;
        }

        // 6. decrement — unpaid/under-paid: shrink to maintenance-adequacy, or gap on E ≤ 0.
        _decrementOrGap(marketId, acct, p, pool, params, mark, equity, funding, call, paid, notionalBefore);
    }

    /// @dev Steps the §4.2 decrement/gap branch. Re-basing the remaining position to `mark` realizes
    ///      the trader's full unrealized price PnL; the pool books the mirror into capital so USDC is
    ///      conserved (the pool's unrealized PnL stays −Σ(open-trader unrealized PnL)).
    function _decrementOrGap(
        bytes32 marketId,
        address acct,
        Position storage p,
        Pool pool,
        MarketParams memory params,
        uint256 mark,
        int256 equity,
        int256 funding,
        uint256 call,
        uint256 paid,
        uint256 notionalBefore
    ) internal {
        uint256 notionalNow = _notionalAt(p, mark);
        int256 realizedPricePnl = _pricePnl(p, mark);
        Decrement.Outcome memory o = Decrement.applyDecrement(equity, notionalNow, params.m);

        if (o.kind == Decrement.Kind.Decrement) {
            // Force-close the ΔN slice against the pool at mark; pool books the mirror of the
            // trader's realized price PnL into capital. If the trader is decrementing while in PROFIT
            // (margin eroded by funding but pricePnl > 0) and the gain exceeds pool capital, the pool
            // draws the gap fund and returns the uncovered `shortfall`; the re-based margin is reduced
            // by it so we never re-base on cash that does not exist (conservation holds).
            uint256 shortfall = pool.adjustCapital(-realizedPricePnl);
            int256 closedQtyWad = _qtyWad(o.closedNotional, mark, p.side);
            // The trader closes `closedQty` of its side → pass the trader's signed-qty change;
            // absorb() takes the opposite for the pool.
            pool.absorb(p.side == Side.Long ? -closedQtyWad : closedQtyWad, mark);
            // Re-base: equity (less any unpayable profit) now backs the smaller notional at `m`.
            uint256 newMargin = uint256(equity) > shortfall ? uint256(equity) - shortfall : 0;
            p.entryNotional = o.newNotional;
            p.entryMark = mark;
            p.margin = newMargin;
            emit PositionReconciled(
                marketId, acct, equity, funding, call, paid, Decrement.Kind.Decrement, notionalBefore, o.newNotional
            );
        } else {
            // E ≤ 0: gap — close fully and recover what cash actually exists. The pool's realized
            // gain on the closed exposure is −pricePnl, but on-chain it can only collect cash that
            // is really there: the seized margin (already in the system) plus the covered slice of
            // the gap fund. The UNCOVERED shortfall is bad debt the pool eats now (in the full design
            // it routes to socialized deleveraging). Booking `−pricePnl − shortfall` makes the pool's
            // capital change exactly `seizedMargin + covered`, so Σ(claims) is conserved across a gap
            // that exhausts the fund. (The simulation over-credits here because its tested gaps never
            // exceed the fund; this is the on-chain-correct accounting of that edge.)
            (, uint256 shortfall) = pool.drawGapFund(o.badDebt);
            pool.adjustCapital(-realizedPricePnl - int256(shortfall));
            pool.absorb(-_signedQtyWad(p), mark); // unwind pool exposure
            if (shortfall > 0) emit GapShortfall(marketId, acct, shortfall);
            _positions[marketId][acct] = _flat();
            _openAccounts[marketId].remove(acct); // position is flat — drop from the open set
            emit PositionReconciled(marketId, acct, equity, funding, call, paid, Decrement.Kind.Gap, notionalBefore, 0);
        }
    }

    // ── Off-chain margin-call settlement hook (Phase 3 / Gateway) ───────────────────

    /// @notice Credit `amount` of answered margin-call USDC straight into an account's position
    ///         margin, from its Vault free collateral. The on-chain landing point for a Gateway
    ///         nanopayment settled between checkpoints (the agent tops up proactively). Owner-gated
    ///         (the trusted operator applies settled authorizations). Mirrors a `paid` top-up that
    ///         happens *before* the next checkpoint rather than inside it.
    function answerMarginCall(bytes32 marketId, address account, uint256 amount) external onlyOwner nonReentrant {
        _poolAndParams(marketId); // defense-in-depth: revert MarketNotFound on an unknown market
        Position storage p = _positions[marketId][account];
        if (p.side == Side.Flat) revert NoPosition();
        vault.debitCollateral(account, amount); // reverts if free collateral insufficient
        p.margin += amount;
    }

    // ── Internal: close, math, helpers ──────────────────────────────────────────────

    function _closeFor(bytes32 marketId, address account, uint256 mark) internal {
        Position storage p = _positions[marketId][account];
        if (p.side == Side.Flat) revert NoPosition();
        (Pool pool,) = _poolAndParams(marketId);

        int256 equity = _equityAt(p, mark);
        int256 realized = equity - int256(p.margin); // trader's realized price PnL (event only)

        // Book ONLY the recoverable cash so Σ(claims) is always conserved and the close can never
        // brick. The trader's return is clamped at 0 (an underwater close cannot hand out more than
        // exists), and the pool gains exactly what stays in the system: the seized margin minus what
        // is returned. Two edges this gets right that a naive `adjustCapital(-realized)` does not:
        //   • equity < 0 (underwater close at an injected mark): pool gains only `margin`, so the
        //     |equity| shortfall is NOT minted as phantom capital (the sim credits the negative
        //     equity to free collateral; clamping to 0 here would otherwise leak |equity|).
        //   • equity > pool capital (winning close): adjustCapital floors capital at 0, draws the gap
        //     fund, and returns the uncovered `shortfall` — the profit the pool cannot pay; the trader
        //     is credited its equity minus that shortfall. No CapitalUnderflow brick (a liveness fix).
        // When equity ≥ 0 and the pool is solvent this is identical to the old `adjustCapital(-realized)`.
        uint256 ret = equity > 0 ? uint256(equity) : 0;
        uint256 shortfall = pool.adjustCapital(int256(p.margin) - int256(ret));
        pool.absorb(-_signedQtyWad(p), mark); // unwind: pool takes opposite of −trader qty

        if (shortfall >= ret) ret = 0;
        else ret -= shortfall;
        if (ret > 0) vault.creditCollateral(account, ret);

        _positions[marketId][account] = _flat();
        _openAccounts[marketId].remove(account); // position is flat — drop from the open set
        emit PositionClosed(marketId, account, realized, mark);
    }

    /// @dev Total open interest split long/short, valued at `mark` (USDC 6dp), over `accounts`.
    function _openInterest(bytes32 marketId, address[] calldata accounts, uint256 mark)
        internal
        view
        returns (uint256 long, uint256 short)
    {
        for (uint256 i = 0; i < accounts.length; i++) {
            Position storage p = _positions[marketId][accounts[i]];
            if (p.side == Side.Long) long += _notionalAt(p, mark);
            else if (p.side == Side.Short) short += _notionalAt(p, mark);
        }
    }

    /// @dev Current notional at `mark`: entryNotional · mark / entryMark (USDC 6dp).
    function _notionalAt(Position storage p, uint256 mark) internal view returns (uint256) {
        if (p.side == Side.Flat) return 0;
        return (p.entryNotional * mark) / p.entryMark;
    }

    /// @dev Unrealized price PnL at `mark`: signedQty · (mark − entryMark) =
    ///      entryNotional · (mark − entryMark) / entryMark, signed by side (USDC 6dp).
    function _pricePnl(Position storage p, uint256 mark) internal view returns (int256) {
        if (p.side == Side.Flat) return 0;
        int256 diff = int256(mark) - int256(p.entryMark);
        int256 magnitude = (int256(p.entryNotional) * diff) / int256(p.entryMark);
        return p.side == Side.Long ? magnitude : -magnitude;
    }

    /// @dev Equity at `mark`: margin + unrealized price PnL (USDC 6dp).
    function _equityAt(Position storage p, uint256 mark) internal view returns (int256) {
        return int256(p.margin) + _pricePnl(p, mark);
    }

    /// @dev Signed base quantity of a position at WAD: entryNotional(6dp)·1e30/entryMark(18dp),
    ///      signed by side. The +/− the pool/engine pass to {Pool.absorb}. The quantity is fixed at
    ///      entry (re-marking does not change the held base amount), so no `mark` is needed.
    function _signedQtyWad(Position storage p) internal view returns (int256) {
        int256 mag = (int256(p.entryNotional) * NOTIONAL_TO_QTY) / int256(p.entryMark);
        return p.side == Side.Long ? mag : -mag;
    }

    /// @dev Unsigned-then-signed base qty (WAD) for a fresh `notional` valued at `mark`, by `side`.
    function _qtyWad(uint256 notional, uint256 mark, Side side) internal pure returns (int256) {
        int256 mag = (int256(notional) * NOTIONAL_TO_QTY) / int256(mark);
        return side == Side.Long ? mag : -mag;
    }

    /// @dev Apply a signed funding cashflow to a position's `margin` cash claim and return the cash
    ///      the POOL receives as a result (= −Δmargin). Funding received (+) credits margin in full
    ///      (the pool pays it, so the pool's claim drops by the same amount). Funding paid (−) debits
    ///      margin but is floored at the available margin cash — a position cannot pay funding out of
    ///      unrealized PnL on-chain, so the pool only receives the cash that actually existed; any
    ///      shortfall vs maintenance is then caught by the margin-call/decrement path (which realizes
    ///      PnL into cash). This keeps every funding USDC the pool books backed by a real margin debit.
    function _applyFunding(Position storage p, int256 funding) internal returns (int256 poolReceives) {
        if (funding >= 0) {
            p.margin += uint256(funding); // pool pays this — its claim drops by `funding`
            return -funding;
        }
        uint256 owed = uint256(-funding);
        uint256 avail = p.margin;
        uint256 cashPaid = owed <= avail ? owed : avail; // floor at available margin cash
        p.margin = avail - cashPaid;
        return int256(cashPaid); // pool receives exactly the cash the trader's margin gave up
    }

    function _poolAndParams(bytes32 marketId) internal view returns (Pool pool, MarketParams memory params) {
        MarketRegistry.Market memory m = registry.getMarket(marketId);
        pool = Pool(m.pool);
        params = m.params;
    }

    function _flat() internal pure returns (Position memory) {
        return Position({side: Side.Flat, entryNotional: 0, entryMark: 0, margin: 0});
    }

    // ── Views (AccountManager / dashboard) ──────────────────────────────────────────

    /// @notice The caller-supplied account's position in a market.
    function positionOf(bytes32 marketId, address account) external view returns (Position memory) {
        return _positions[marketId][account];
    }

    /// @notice Position equity at `mark` (margin + unrealized price PnL), USDC 6dp.
    function equityOf(bytes32 marketId, address account, uint256 mark) external view returns (int256) {
        Position storage p = _positions[marketId][account];
        if (p.side == Side.Flat) return 0;
        return _equityAt(p, mark);
    }

    /// @notice Current notional of an account's position at `mark`, USDC 6dp.
    function notionalOf(bytes32 marketId, address account, uint256 mark) external view returns (uint256) {
        return _notionalAt(_positions[marketId][account], mark);
    }

    /// @notice The set of accounts with a live position in `marketId` — the checkpoint account set,
    ///         readable on-chain so the CRE settlement workflow computes it from chain state (no
    ///         off-chain list to trust). Order is not guaranteed; the set is small (per-market OI cap).
    function openAccounts(bytes32 marketId) external view returns (address[] memory) {
        return _openAccounts[marketId].values();
    }

    /// @notice Number of accounts with a live position in `marketId` (for paginating large sets).
    function openAccountCount(bytes32 marketId) external view returns (uint256) {
        return _openAccounts[marketId].length();
    }
}
