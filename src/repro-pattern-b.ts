// Pattern B variant of the contract→contract send reproduction.
//
// The canonical 186 repro (`src/repro.ts`) uses the unshielded primitives
// `receiveUnshielded(color, amount)` / `sendUnshielded(color, amount,
// recipient)` and is rejected by the node when the recipient is a
// `ContractAddress`. The hypothesis under test here is that 186 is the
// node correctly rejecting a contract that calls `sendUnshielded` for a
// coin it does not actually custody. This driver exercises the canonical
// shielded-coin custody pattern (Pattern B), modelled on
// micro-dao.compact: declare `held: QualifiedShieldedCoinInfo`, deposit
// via `receiveShielded(coin)` + `held.writeCoin(...)`, spend via
// `sendShielded(held, right<...>(recipient), amount)`.
//
// If Pattern B lands the contract→contract send, the original 186
// finding is a contract-design issue, not a node bug.
//
// Run with: npm run repro:pattern-b

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { firstValueFrom } from 'rxjs';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {
  createShieldedCoinInfo,
  encodeShieldedCoinInfo,
} from '@midnight-ntwrk/ledger-v8';

import {
  createWallet,
  createProviders,
  PRIVATE_STATE_ID,
  hexToBytes32,
  syncWallet,
  printBalances,
} from './utils.js';

const SEED = process.env.WALLET_SEED;
if (!SEED) {
  console.error('ERROR: WALLET_SEED is not set. Source ./infra/.env first or run via repro.sh.');
  process.exit(1);
}

// Dynamically load the Pattern B compiled contract (sibling of `holder`).
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const patternBZkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'holder-pattern-b');
if (!fs.existsSync(`${patternBZkConfigPath}/contract/index.js`)) {
  console.error('ERROR: Pattern B contract not compiled. Run `npm run compile:pattern-b` first.');
  process.exit(1);
}
const HolderPatternB = await import(pathToFileURL(`${patternBZkConfigPath}/contract/index.js`).href);

console.log('═══════════════════════════════════════════════════════════════════');
console.log(' Midnight node — sendShielded contract→contract Pattern B repro');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('');

const compiled = CompiledContract.make('holder-pattern-b', HolderPatternB.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(patternBZkConfigPath),
);

console.log('[1/5] Spinning up wallet, providers ...');
const walletCtx = await createWallet(SEED);
await syncWallet(walletCtx, 'wallet');
const initialState: any = await firstValueFrom(walletCtx.wallet.state());
printBalances(initialState);
const baseProviders: any = await createProviders(walletCtx);
// Re-point ZK + proof providers at the Pattern B managed dir; the rest
// of the providers (wallet, indexer, private state) are agnostic.
const patternBZkConfigProvider = new NodeZkConfigProvider(patternBZkConfigPath);
const providers: any = {
  ...baseProviders,
  zkConfigProvider: patternBZkConfigProvider,
  proofProvider: httpClientProofProvider('http://127.0.0.1:6300', patternBZkConfigProvider as any),
};
console.log('');

// Pick a shielded token the wallet holds at least DEPOSIT_AMOUNT of.
const DEPOSIT_AMOUNT = 1000n;
const SEND_AMOUNT = 100n;

const shieldedBalances: Record<string, bigint> = initialState.shielded?.balances ?? {};
const shieldedEntries = Object.entries(shieldedBalances).filter(([, v]) => BigInt(v) >= DEPOSIT_AMOUNT);
if (shieldedEntries.length === 0) {
  console.error('ERROR: wallet has no shielded token balance >= DEPOSIT_AMOUNT (1000).');
  console.error('Available shielded balances:');
  for (const [k, v] of Object.entries(shieldedBalances)) {
    console.error(`  ${k}: ${v}`);
  }
  process.exit(1);
}

// Use the largest-balance token to maximise headroom.
shieldedEntries.sort(([, a], [, b]) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
const [TOKEN_TYPE_HEX, TOKEN_BAL] = shieldedEntries[0];
console.log(`      using shielded token ${TOKEN_TYPE_HEX} (balance: ${TOKEN_BAL})`);
console.log('');

console.log('[2/5] Deploying SENDER (A) Pattern B contract ...');
const sender = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: PRIVATE_STATE_ID + '-pb',
  initialPrivateState: {},
});
const senderAddress = sender.deployTxData.public.contractAddress;
console.log(`      ✓ ${senderAddress}`);
console.log('');

console.log('[3/5] Deploying RECIPIENT (B) Pattern B contract ...');
const recipient = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: PRIVATE_STATE_ID + '-pb-recipient',
  initialPrivateState: {},
});
const recipientAddress = recipient.deployTxData.public.contractAddress;
console.log(`      ✓ ${recipientAddress}`);
console.log('');

console.log(`[4/5] Funding SENDER: depositing ${DEPOSIT_AMOUNT} of token into Pattern B \`held\` ...`);
const depositCoin = encodeShieldedCoinInfo(createShieldedCoinInfo(TOKEN_TYPE_HEX, DEPOSIT_AMOUNT));
const depositResult: any = await sender.callTx.deposit(depositCoin);
const depositTx = depositResult?.public?.txId ?? depositResult?.public?.transactionHash;
console.log(`      ✓ deposit tx: ${depositTx}`);
console.log('');

console.log(`[5/5] SENDER → RECIPIENT: sendShielded(${SEND_AMOUNT}) via Pattern B`);
console.log('      this is the call that the hypothesis predicts will land cleanly.');
console.log('');

try {
  const recipientArg = { bytes: hexToBytes32(recipientAddress.replace(/^0x/, '')) };
  const sendResult: any = await sender.callTx.send_to_contract(recipientArg, SEND_AMOUNT);
  const sendTx = sendResult?.public?.txId ?? sendResult?.public?.transactionHash;

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' ✓ HYPOTHESIS CONFIRMED: Pattern B contract→contract send LANDED.');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`tx hash: ${sendTx}`);
  console.log('');
  console.log('Software versions:');
  await reportVersions();
  process.exit(0);
} catch (e: any) {
  const msg = e?.message ?? String(e);
  const cause = e?.cause?.message ?? e?.cause?.cause?.message ?? '';
  const fullMsg = `${msg}\n${cause}`;
  const codeMatch = fullMsg.match(/Custom error[: ]+(\d+)/);

  console.log('═══════════════════════════════════════════════════════════════════');
  if (codeMatch && codeMatch[1] === '186') {
    console.log(' ✗ HYPOTHESIS REFUTED: Pattern B still hits Custom error: 186.');
    console.log('   This is a sharper finding — the canonical custody pattern');
    console.log('   used by midnight-contracts/dao also fails contract→contract.');
  } else if (codeMatch) {
    console.log(` ⚠ NEW ERROR CODE: ${codeMatch[1]} (single-call repro produces 186).`);
  } else {
    console.log(' ⚠ Failed without a recognised Custom error code; raw message below.');
  }
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Full error from node:');
  console.log(`  ${msg}`);
  if (cause) console.log(`  cause: ${cause}`);
  if (e?.stack) {
    console.log('');
    console.log('Stack:');
    console.log(`  ${e.stack}`);
  }
  console.log('');
  console.log('Software versions:');
  await reportVersions();
  process.exit(codeMatch && codeMatch[1] === '186' ? 0 : 1);
}

async function reportVersions(): Promise<void> {
  void defaultZkConfigPath; // re-export keeps utils.ts unchanged
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  for (const [name, version] of Object.entries(pkg.dependencies as Record<string, string>)) {
    if (name.startsWith('@midnight-ntwrk/')) console.log(`  ${name}: ${version}`);
  }
  console.log('  node image: see infra/docker-compose.yml (default: midnightntwrk/midnight-node:0.22.5)');
}
