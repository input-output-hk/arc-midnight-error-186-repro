
import * as fs from 'node:fs';
import { firstValueFrom } from 'rxjs';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import {
  createWallet,
  createProviders,
  HolderContract,
  zkConfigPath,
  PRIVATE_STATE_ID,
  hexToBytes32,
  syncWallet,
  printBalances,
} from './utils.js';
import { withMultiContractScopedTransaction } from './multi-contract-tx.js';
import { ContractAddress } from "@midnight-ntwrk/ledger-v8";

const SEED = process.env.WALLET_SEED;
if (!SEED) {
  console.error('ERROR: WALLET_SEED is not set. Source ./infra/.env first or run via repro.sh.');
  process.exit(1);
}

if (!fs.existsSync(`${zkConfigPath}/contract/index.js`)) {
  console.error('ERROR: contract not compiled. Run `npm run compile` first.');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log(' Midnight node — sendUnshielded contract→contract repro (error 186)');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('');

const compiled = CompiledContract.make('holder', HolderContract.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

console.log('[1/5] Spinning up wallet, providers ...');
const walletCtx = await createWallet(SEED);
await syncWallet(walletCtx, 'wallet');
const initialState = await firstValueFrom(walletCtx.wallet.state());
printBalances(initialState);
const providers = await createProviders(walletCtx);
console.log('');

console.log('[2/5] Deploying SENDER contract ...');
const sender = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: PRIVATE_STATE_ID,
  initialPrivateState: {},
});
const senderAddress = sender.deployTxData.public.contractAddress;
console.log(`      ✓ ${senderAddress}`);
console.log('');
await printBalance(providers, senderAddress, 'Sender');

console.log('[3/5] Deploying RECIPIENT contract ...');
const recipient = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: PRIVATE_STATE_ID + '-recipient',
  initialPrivateState: {},
});
const recipientAddress = recipient.deployTxData.public.contractAddress;
console.log(`      ✓ ${recipientAddress}`);
console.log('');
await printBalance(providers, recipientAddress, 'Recipient');

// Genesis Night color on the dev chain.
const NIGHT_COLOR = '0'.repeat(64);
const DEPOSIT_AMOUNT = 1000n;
const SEND_AMOUNT = 100n;

console.log(`[4/5] Funding SENDER: depositing ${DEPOSIT_AMOUNT} Night from user wallet ...`);
const depositResult = await sender.callTx.deposit_unshielded(hexToBytes32(NIGHT_COLOR), DEPOSIT_AMOUNT);
const depositTx = depositResult?.public?.txId ?? depositResult?.public?.txHash;
console.log(`      ✓ deposit tx: ${depositTx}`);
console.log('');
await printBalance(providers, senderAddress, 'Sender');
await printBalance(providers, recipientAddress, 'Recipient');

console.log(`[5/5] SENDER → RECIPIENT: sendUnshielded(${SEND_AMOUNT} Night)`);
console.log('      this is the call that triggers error 186.');
console.log('');

const t0 = Date.now();
const mark = (label: string): void => {
    const dt = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`      [+${dt}s] ${label}`);
};

try {
    const recipientArg = { bytes: hexToBytes32(recipientAddress.replace(/^0x/, '')) };

    mark('entering withMultiContractScopedTransaction');
    const bundled = await withMultiContractScopedTransaction(
        providers,
        async (txCtx) => {
            mark('before sender.send_unshielded_to_contract await');
            await sender.callTx.send_unshielded_to_contract(
                txCtx.for(sender),
                hexToBytes32(NIGHT_COLOR),
                SEND_AMOUNT,
                recipientArg,
            );
            mark('after sender.send_unshielded_to_contract returned (CallResult queued)');
            mark('before recipient.receive_unshielded_from_contract await');
            await recipient.callTx.receive_unshielded_from_contract(
                txCtx.for(recipient),
                hexToBytes32(NIGHT_COLOR),
                SEND_AMOUNT,
            );
            mark('after recipient.receive_unshielded_from_contract returned (CallResult queued)');
            mark('exiting fn — ctx.submit() will run next (prove → balance → submit → watch)');
        },
        {scopeName: 'sender_send + recipient_receive (single intent)'},
    );
    mark('withMultiContractScopedTransaction resolved');

    const sendTx = bundled.public.txId ?? bundled.public.txHash;

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' UNEXPECTED: the contract→contract send SUCCEEDED.');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`tx hash: ${sendTx}`);
  await printBalance(providers, senderAddress, 'Sender');
  await printBalance(providers, recipientAddress, 'Recipient');
  console.log('');
  console.log('If you are seeing this, error 186 may be FIXED on your build.');
  console.log('Please report your software versions:');
  await reportVersions();
  process.exit(0);
} catch (e: any) {
  const msg = e?.message ?? String(e);
  const cause = e?.cause?.message ?? e?.cause?.cause?.message ?? '';
  const fullMsg = `${msg}\n${cause}`;
  const codeMatch = fullMsg.match(/Custom error[: ]+(\d+)/);

  console.log('═══════════════════════════════════════════════════════════════════');
  if (codeMatch && codeMatch[1] === '186') {
    console.log(' ✓ REPRODUCED: error 186 is present.');
  } else if (codeMatch) {
    console.log(` ⚠ Unexpected error code: ${codeMatch[1]} (expected 186).`);
  } else {
    console.log(' ⚠ Failed, but the error code does not match the expected 186.');
  }
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Full error from node:');
  console.log(`  ${msg}`);
  if (cause) console.log(`  cause: ${cause}`);
  console.log('');
  console.log('Software versions:');
  await reportVersions();
  process.exit(codeMatch && codeMatch[1] === '186' ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────

async function reportVersions(): Promise<void> {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  for (const [name, version] of Object.entries(pkg.dependencies as Record<string, string>)) {
    if (name.startsWith('@midnight-ntwrk/')) console.log(`  ${name}: ${version}`);
  }
  console.log('  node image: see infra/docker-compose.yml (default: midnightntwrk/midnight-node:0.22.5)');
}

async function printBalance(providers: Awaited<ReturnType<typeof createProviders>>, address: ContractAddress, label: string): Promise<void> {
    const state = await providers.publicDataProvider.queryContractState(address);
    console.log(`  ${label} contract.balance:`, state?.balance);
}
