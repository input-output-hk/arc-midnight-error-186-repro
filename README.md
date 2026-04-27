# Midnight `Custom error: 186` reproduction

A minimal, self-contained reproduction of a Midnight v1 node rejection
that surfaces when a Compact contract attempts to send Night
(unshielded) tokens to another contract address.

The Compact contract compiles cleanly. The proof generates successfully.
The resulting extrinsic is then rejected by the node's transaction
validator with:

```
1010: Invalid Transaction: Custom error: 186
```

The same circuit pattern works correctly when the recipient is a
**`UserAddress`**; only the **`ContractAddress`** branch trips this
error. This blocks any architectural pattern that needs contract-to-
contract Night routing — for example, account-abstraction designs that
delegate funds between specialised contracts.

## How to reproduce

### Prerequisites

- Docker (for the local devnet)
- Node.js ≥ 22
- `compact` toolchain on PATH (manager `0.5.x`, active compiler `0.30.0`
  or compatible)
- `openssl` (used once to generate `infra/.env`)

### One-shot

```bash
./repro.sh              # run end-to-end
./repro.sh --fresh      # reset chain state first
```

The script:

1. Installs npm dependencies.
2. Compiles `contracts/holder.compact`.
3. Brings up a local Midnight devnet (node + indexer + proof-server).
4. Deploys two instances of the same minimal contract — *sender* and
   *recipient*.
5. Has the user wallet deposit 1 000 Night into the *sender* contract.
6. Has the *sender* contract call `sendUnshielded(100 Night, recipient)`
   targeting the *recipient* contract address.
7. Catches the rejection from the node and prints it.

### Expected output

```
═══════════════════════════════════════════════════════════════════
 Midnight node — sendUnshielded contract→contract repro (error 186)
═══════════════════════════════════════════════════════════════════

[1/5] Spinning up wallet, providers ...
      ✓ wallet synced.
[2/5] Deploying SENDER contract ...
      ✓ <hex address>
[3/5] Deploying RECIPIENT contract ...
      ✓ <hex address>
[4/5] Funding SENDER: depositing 1000 Night from user wallet ...
      ✓ deposit tx: <hex>
[5/5] SENDER → RECIPIENT: sendUnshielded(100 Night)
      this is the call that triggers error 186.

═══════════════════════════════════════════════════════════════════
 ✓ REPRODUCED: error 186 is present.
═══════════════════════════════════════════════════════════════════

Full error from node:
  Threw: Unexpected error submitting scoped transaction '<unnamed>': …
  cause: RpcError: 1010: Invalid Transaction: Custom error: 186
…
```

A reproduction takes around 4–6 minutes end-to-end on a recent laptop
(the bulk is image pulls on the first run, plus proof generation).

## What the contract does

```compact
// contracts/holder.compact (excerpt)

export circuit deposit_unshielded(color: Bytes<32>, amount: Uint<128>): [] {
  receiveUnshielded(disclose(color), disclose(amount));
}

export circuit send_unshielded_to_contract(
  color:     Bytes<32>,
  amount:    Uint<128>,
  recipient: ContractAddress,
): [] {
  sendUnshielded(
    disclose(color),
    disclose(amount),
    left<ContractAddress, UserAddress>(disclose(recipient)),
  );
}
```

The two circuits are mirror images of the standard Compact pattern —
nothing experimental about the contract structure. The reproduction
is at the *node* layer, not at the language or proof layer.

## Software versions tested

This reproduction was last verified against:

| Component | Version |
|-----------|---------|
| `midnightntwrk/midnight-node` | `0.22.5` |
| `midnightntwrk/indexer-standalone` | `4.0.0` |
| `midnightntwrk/proof-server` | `8.0.2` |
| `compact` toolchain manager | `0.5.1` (active compiler `0.30.0`) |
| `pragma language_version` (in `holder.compact`) | `0.22` |
| `@midnight-ntwrk/midnight-js-*` | `^4.0.4` (latest published) |
| `@midnight-ntwrk/ledger-v8` | `^8.0.3` (latest published) |
| `@midnight-ntwrk/wallet-sdk-shielded` | `^3.0.0` (latest published) |
| `@midnight-ntwrk/wallet-sdk-dust-wallet` | `^4.0.0` (latest published) |
| `@midnight-ntwrk/wallet-sdk-unshielded-wallet` | `^3.0.0` (latest published) |
| `@midnight-ntwrk/wallet-sdk-facade` | `^4.0.0` (latest published) |

If you are testing against a newer node release where this issue is
fixed: please open an issue on this repository (or the upstream
Midnight tracker) with your version pins so we can update the README
and close out the reproduction.

## What success looks like

If the bug has been fixed in your build, the script will print:

```
═══════════════════════════════════════════════════════════════════
 UNEXPECTED: the contract→contract send SUCCEEDED.
═══════════════════════════════════════════════════════════════════
tx hash: 00…
```

…and exit 0. That tx hash is the proof of fix. Please share it,
along with your software versions, so the issue can be closed.

## Repository layout

| Path | Purpose |
|------|---------|
| `contracts/holder.compact` | Minimal Compact contract — two circuits |
| `src/utils.ts` | Wallet + provider plumbing for the devnet |
| `src/repro.ts` | The reproduction script itself |
| `infra/docker-compose.yml` | Pinned local devnet (node + indexer + proof-server) |
| `infra/docker-compose.macos.yml` | macOS bridge-networking override |
| `repro.sh` | Single-command end-to-end runner |
| `package.json` | Pinned `@midnight-ntwrk/*` dependency set |

## Notes for reviewers

- The `feeBlocksMargin` is set to `100` in `src/utils.ts`, raised from
  the SDK default of `5`. The default trips
  `MalformedError::BalanceCheckOverspend` (`Custom error: 138`) at
  deploy time on `midnight-node:0.22.5` for any contract with a circuit
  at k ≥ 14. The contract in this reproduction is small (k ≤ 10) but
  the margin override is kept for symmetry with the larger experiment
  this minimal repro was extracted from.
- `wallet-sdk-unshielded-wallet@3` removed
  `InMemoryTransactionHistoryStorage`. The new `wallet-sdk-shielded@3`
  and `wallet-sdk-dust-wallet@4` expect a storage object exposing
  `upsert` / `get` / `delete` / `list`. We supply a no-op stub since
  history isn't relevant to this reproduction (`src/utils.ts:45`).
- The contract pragma is `language_version 0.22`. Bumping to a higher
  language version (the active compiler accepts up to `0.30`) does not
  change the result — the reproduction is at the node layer, downstream
  of the language entirely.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).
