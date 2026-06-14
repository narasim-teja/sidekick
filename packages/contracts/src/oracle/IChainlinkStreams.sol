// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IChainlinkStreams — minimal Chainlink Data Streams on-chain interfaces.
/// @notice Net-new in this repo: there is no Chainlink lib under packages/contracts/lib (only the
///         Stork SDK is vendored). These are the *only* surfaces {ChainlinkAdapter} needs, hand-
///         declared so we do not pull in the full chainlink-evm package for two structs + one call.
/// @dev Data Streams differs structurally from Stork: the REST API returns an opaque `fullReport`
///      blob that must be passed to the on-chain Verifier *proxy* `verify()` (payable, state-
///      changing) which validates the DON signature and RETURNS the decoded report — it does NOT
///      persist anything. So unlike Stork (push-then-`view`-read), a Data Streams adapter cannot do
///      the verify inside a `view getMark()`. We split it: a writer calls `verify()`, decodes, and
///      STORES the Mark; `getMark()` is a plain `view` over that stored value. See {ChainlinkAdapter}.

/// @notice The Verifier proxy. `verify` validates `payload` (the API's `fullReport` hex) and returns
///         the ABI-encoded verified report body, charging the fee named in `parameterPayload`.
/// @dev `parameterPayload = abi.encode(feeTokenAddress)`. On chains with native-fee billing enabled
///      the fee token is the wrapped-native (WETH-style) address and the fee is paid via msg.value;
///      with LINK billing it is the LINK address and the fee is pulled via ERC-20 allowance.
interface IVerifierProxy {
    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external
        payable
        returns (bytes memory verifierResponse);

    /// @notice The FeeManager for this verifier, if fees are enabled (zero address if not).
    function s_feeManager() external view returns (address);
}

/// @notice The FeeManager — used to price a report before paying for `verify`.
/// @dev `getFeeAndReward` returns the fee in the quoted token; the adapter's writer reads it (or
///      decodes report.nativeFee/linkFee directly) so it can attach the right msg.value / allowance.
interface IFeeManager {
    struct Asset {
        address assetAddress;
        uint256 amount;
    }

    function getFeeAndReward(address subscriber, bytes memory unverifiedReport, address quoteAddress)
        external
        view
        returns (Asset memory fee, Asset memory reward, uint256 totalDiscount);

    /// @notice The wrapped-native token address this fee manager prices native fees in.
    function i_nativeAddress() external view returns (address);

    /// @notice The reward manager that ERC-20 fees must be approved to.
    function i_rewardManager() external view returns (address);
}

/// @notice Data Streams v3 (crypto) report body, as returned by `verify` and ABI-decodable.
/// @dev All of price/bid/ask are int192 at 18 decimals — same scale as Stork's quantizedValue, so
///      price18 = price needs NO rescale. Timestamps are SECONDS (×1000 → ms). v4 (RWA/DEX) adds a
///      trailing `uint32 marketStatus`; we read the v3 prefix, which is layout-compatible for the
///      fields we use (feedId..price). We deliberately ignore bid/ask — MarkPrice has one price slot.
struct ReportV3 {
    bytes32 feedId;
    uint32 validFromTimestamp;
    uint32 observationsTimestamp;
    uint192 nativeFee;
    uint192 linkFee;
    uint32 expiresAt;
    int192 price;
    int192 bid;
    int192 ask;
}
