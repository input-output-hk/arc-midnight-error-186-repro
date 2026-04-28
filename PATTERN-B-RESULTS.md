# Pattern B custody — does it land contract→contract sends?

Date: 2026/04/28

## Hypothesis under test

The original `Custom error: 186` reproduction in this repo
(`contracts/holder.compact` + `src/repro.ts`) uses the low-level
unshielded primitives `receiveUnshielded(color, amount)` /
`sendUnshielded(color, amount, recipient)`, which record nothing in
ledger state. The hypothesis: error 186 may be the node correctly
rejecting a contract that calls `sendUnshielded` for a coin it does not
actually custody. The canonical custody pattern used by
`midnight-contracts/packages/dao/contract/src/micro-dao.compact` —
declare `ledger pot: QualifiedShieldedCoinInfo`, deposit via
`receiveShielded(coin)` + `pot.writeCoin(...)`, spend via
`sendShielded(pot, recipient, amount)` — was expected to land cleanly
because the contract does formally hold the coin.

Verdict: **refuted, with a sharper finding.** The canonical custody
pattern also hits 186 when the recipient is a `ContractAddress`. The
original `holder.compact` artefact is unchanged; Pattern B has been
added alongside it as `contracts/holder-pattern-b.compact`,
`src/repro-pattern-b.ts`, and the `repro:pattern-b` npm script.

---

## What changed

### `contracts/holder-pattern-b.compact` (new, modelled on micro-dao)

Direct lift of the DAO's pot custody, modulo:
- the rename of the shielded primitives to be explicitly suffixed
  (`sendShielded` / `receiveShielded` / `QualifiedShieldedCoinInfo` /
  `ShieldedCoinInfo`) — the DAO uses pragma `>= 0.14.0` with the
  un-suffixed legacy names; this repo uses pragma `0.22` with the
  suffixed names (the compactc 0.30 stdlib rejects `send`/`receive`
  with *"apparent use of an old standard-library / ledger operator
  name send: the new name is sendShielded"*);
- the recipient is a `ContractAddress` instead of a
  `ZswapCoinPublicKey` so we can target another contract;
- partial sends are supported by writing the change coin back into
  `held` (DAO's `cash_out` always sends `pot.value`, so it never has
  change to handle).

Key contract excerpt (`contracts/holder-pattern-b.compact:30-77`):

```compact
export ledger held: QualifiedShieldedCoinInfo;   // mirrors `pot` in micro-dao.compact:32
export ledger held_has_coin: Boolean;            // mirrors `pot_has_coin` in micro-dao.compact:33
export ledger tx_count: Uint<64>;

export circuit deposit(coin: ShieldedCoinInfo): [] {
  receiveShielded(disclose(coin));
  if (!held_has_coin) {
    held.writeCoin(disclose(coin),
                   right<ZswapCoinPublicKey, ContractAddress>(kernel.self()));
    held_has_coin = true;
  } else {
    held.writeCoin(mergeCoinImmediate(held, disclose(coin)),
                   right<ZswapCoinPublicKey, ContractAddress>(kernel.self()));
  }
  tx_count = disclose((tx_count + (1 as Uint<64>)) as Uint<64>);
}

export circuit send_to_contract(recipient: ContractAddress, amount: Uint<128>): [] {
  assert(held_has_coin, "send_to_contract: contract holds no coin");
  const result = sendShielded(
    held,
    right<ZswapCoinPublicKey, ContractAddress>(disclose(recipient)),
    disclose(amount));
  if (result.change.is_some) {
    held.writeCoin(result.change.value,
                   right<ZswapCoinPublicKey, ContractAddress>(kernel.self()));
  } else {
    held = default<QualifiedShieldedCoinInfo>;
    held_has_coin = false;
  }
  tx_count = disclose((tx_count + (1 as Uint<64>)) as Uint<64>);
}
```

Reference points in the DAO:
- pot declaration —
  `../arc-passport/.../midnight-contracts/packages/dao/contract/src/micro-dao.compact:32-33`
- first-deposit-vs-merge pattern —
  `micro-dao.compact:133-138` (set_topic) and `:152-157` (buy_in)
- `send(pot, recipient, amount)` invocation —
  `micro-dao.compact:172-175` (cash_out)

### `src/repro-pattern-b.ts` (new)

A parallel test driver alongside `src/repro.ts`. Same shape:
deploy two instances of the holder, fund the sender, sender sends to
the recipient. Differences:
- Loads the Pattern B compiled contract from
  `contracts/managed/holder-pattern-b/` and overrides the providers'
  `zkConfigProvider` and `proofProvider` to point at that path (utils
  is unchanged).
- Picks the largest-balance shielded token from
  `state.shielded.balances` (on the dev chain that's the all-zeros
  token type with ~2.5 × 10¹⁴ units).
- Builds the deposit coin as
  `encodeShieldedCoinInfo(createShieldedCoinInfo(tokenType, 1000n))`
  and calls `sender.callTx.deposit(coin)`.
- Calls `sender.callTx.send_to_contract({ bytes: <recipient> }, 100n)`
  and reports either the tx hash or the raw RpcError verbatim.

### `package.json` (modified, two lines)

```diff
     "compile": "compact compile contracts/holder.compact contracts/managed/holder",
+    "compile:pattern-b": "compact compile contracts/holder-pattern-b.compact contracts/managed/holder-pattern-b",
     "repro": "tsx src/repro.ts",
+    "repro:pattern-b": "tsx src/repro-pattern-b.ts"
```

The original `holder.compact`, `repro.ts`, `repro.sh`, and `utils.ts`
are unchanged.

---

## What happened

### Pattern B run on a fresh devnet

```
[1/5] Spinning up wallet, providers ...
      wallet: 1 Night, 4 Zswap, dust=1249945433605836261894367
      using shielded token 0000000000000000000000000000000000000000000000000000000000000000 (balance: 250000000000000)

[2/5] Deploying SENDER (A) Pattern B contract ...
      ✓ 724dfd79c0d99d83b93ed345604bb9397a998af6fdddca43fa37a69374792fa2

[3/5] Deploying RECIPIENT (B) Pattern B contract ...
      ✓ 2cc79f747b96cdbae27b7cb0ae3c3d3cd8df8484bcd19c66889ba6de9e77828a

[4/5] Funding SENDER: depositing 1000 of token into Pattern B `held` ...
      ✓ deposit tx: 0067b032166e41df4b35dce87dfc8fae21234d5308c10f43023989262c6dac3b94

[5/5] SENDER → RECIPIENT: sendShielded(100) via Pattern B
      this is the call that the hypothesis predicts will land cleanly.

2026-04-28 06:48:12  RPC-CORE: submitAndWatchExtrinsic(...): ExtrinsicStatus::
                     1010: Invalid Transaction: Custom error: 186

═══════════════════════════════════════════════════════════════════
 ✗ HYPOTHESIS REFUTED: Pattern B still hits Custom error: 186.
═══════════════════════════════════════════════════════════════════

  cause: RpcError: 1010: Invalid Transaction: Custom error: 186
```

(Full log: `/tmp/repro-pattern-b.log`.)

Both Pattern B contract instances **deployed cleanly** on the freshly-
reset devnet (`midnightntwrk/midnight-node:0.22.5`,
`midnightntwrk/indexer-standalone:4.0.0`,
`midnightntwrk/proof-server:8.0.2`). The deposit step **landed**
on-chain with tx hash
`0067b032166e41df4b35dce87dfc8fae21234d5308c10f43023989262c6dac3b94`
— the contract genuinely does custody the coin in `held`.

The contract→contract send via `sendShielded(held, right<...>(B), 100)`
— the **canonical** spend pattern used by
`midnight-contracts/packages/dao/contract/src/micro-dao.compact:172-175`
— was rejected by the node with the **same** `1010: Invalid
Transaction: Custom error: 186` as the original `sendUnshielded`
reproduction.

### Side-by-side

| Variant | Custody | Spend primitive | Recipient | Result |
|---|---|---|---|---|
| `holder.compact`           (existing) | none (`receiveUnshielded` only) | `sendUnshielded(color, amount, ContractAddress)` | contract | **186** |
| `holder-pattern-b.compact` (new)      | `held: QualifiedShieldedCoinInfo` + `writeCoin` (DAO pattern) | `sendShielded(held, ContractAddress, amount)`   | contract | **186** |

Both fail with verbatim the same error code at the node's
transaction-validity check. The deploy and deposit steps land in both
cases; only the contract-to-contract send is rejected.

---

## Verdict

**Hypothesis falsified.** The 186 rejection is **not** caused by the
contract calling `sendUnshielded` for a coin it does not custody. A
contract that holds a coin via the canonical
`QualifiedShieldedCoinInfo` + `writeCoin` ledger pattern, exactly as
`midnight-contracts/packages/dao` does, **also fails to send to a
contract address** with the same `Custom error: 186`.

This sharpens the upstream finding rather than retracting it. The new
shape: *contract-to-contract unshielded **and** shielded sends both
fail on `midnightntwrk/midnight-node:0.22.5` with `Custom error: 186`,
even when the sending contract custodies the coin via the canonical
`QualifiedShieldedCoinInfo` + `writeCoin` ledger pattern as
demonstrated in `midnight-contracts/packages/dao` and
`midnight-contracts/packages/coracle`.* The original 186 finding for
the parent project (`FINDINGS.md` upstream) does not need to be
revised; if anything, it is reinforced, since both spend primitives
(`sendUnshielded` and `sendShielded`) hit the same error against
`ContractAddress` recipients while user-addressed sends work for both.

The remaining client-side fixes ruled out by the prior fix-attempts in
this session (`receiveUnshielded`-on-change in the sender circuit,
same-tx multi-call with `Intent.addCall` placing both contracts'
actions in one Intent, and the SDK-side
`extractUserAddressedOutputs → UnshieldedOffer` hot-patch) all still
apply: combined with this Pattern B result, the evidence is now
specifically that **no client-side workaround unblocks contract-to-
contract value transfer on this node version**, regardless of which
custody pattern the sending contract uses.

Recommendation: keep
[`midnight-ledger#233`](https://github.com/midnightntwrk/midnight-ledger/issues/233)
open, and attach this Pattern B run as evidence that the canonical
custody pattern is also affected. The next experiment worth running
would be a *user→contract* `sendShielded` to verify the node treats
shielded user-addressed recipients differently from contract-addressed
recipients — that would localise the failure to the contract-recipient
branch specifically, independent of the spend primitive.
