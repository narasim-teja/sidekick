# CRE live-run evidence (Arc testnet, chain 5042002)

Captured 2026-06-13. Full end-to-end: CRE delivers a real Chainlink Data Streams mark, then CRE
drives the authoritative on-chain settlement. Both halves landed real on-chain writes via the
KeystoneForwarder (the qualifying Connect-the-World state change), with the underflow-fixed contracts.

## Isolated CRE venue (fixed contracts, redeployed 2026-06-13)
| Component | Address |
|---|---|
| PerpEngine (owned by settler) | `0x6d4A9355585Df1c9919D09c1842f09d1231Fe848` |
| MarkReceiver (markfeed writes, settle reads) | `0x559074a39b5A10B1492D2423b069b692ad2C9c64` |
| CheckpointSettler (owns the engine) | `0xad5797964eBACecC1Ef49FF4Cf6E4B89F9c38690` |
| Vault / Pool / LPToken | `0x8b0caC0F90ceEBb899D550404E6849a6dA51C62c` / `0xa75949f6fED775DECd00eFA19aD149cec73C73Bf` / `0x4F3c55D26078416DB1bA98B9e110285b4A162a83` |
| market | `LINK-PERP` |
| Data Streams feed (LINK/USD testnet) | `0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265` |

## Run 1 — markfeed (mark delivery)
- Real Data Streams consensus mark: **price18 = 7965670000000000000 ($7.96567)**, observedMs 1781398200000
- `MarkReceiver.onReport` tx: **`0x3cd16b3568a9fc97c0353ad40a49fbbd7c383b5c99b68744ae9e73671af9d838`** (block 46955611, gasUsed 138117)
- Forwarder `0x6e9ee680…` event present in the receipt → the KeystoneForwarder called onReport.
- Post-state: `MarkReceiver.reportCount() = 1`; `getMark()` returns `(7965670000000000000, 1781398200000)` **without reverting** (the underflow fix in effect).

## Run 2 — settle (CRE-driven checkpoint)
- Read on-chain: mark 7965670000000000000 over 1 open account.
- `CheckpointSettler.onReport → engine.checkpoint` tx: **`0x524fc6c97ff1529c5962e2346426b4f46bb8007d063523c061fdbcfe8e0bf61c`** (block 46955720, gasUsed 207923, status success, 5 events)
- Post-state: `CheckpointSettler.settleCount() = 1`, `PerpEngine.checkpointCount(LINK) = 1`, engine.owner == settler.

## Reproduce
See ../README.md. Order: deploy venue → cre-venue-setup → `cre workflow simulate ./markfeed --broadcast` → `cre workflow simulate ./settle --broadcast`.
