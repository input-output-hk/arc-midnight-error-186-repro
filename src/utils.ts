// Wallet + provider plumbing for the Midnight devnet.
// Trimmed to the absolute minimum needed to deploy a contract and call a
// circuit. No history, no balance printing, no shielded helpers.

import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { FacadeState, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// @ts-expect-error required for wallet sync over GraphQL subscriptions
globalThis.WebSocket = WebSocket;

setNetworkId('undeployed' as any);

// Workaround for a ledger-v8 bug: MerkleTree::collapse panics on non-empty
// trees during shielded-state apply. Without this guard, the wallet's
// initial sync drops the genesis Dust UTXO silently, then fails the deploy
// transaction with `Wallet.InsufficientFunds: could not balance dust`.
// Drop on the day this is verified fixed upstream.
const _origTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};

const CONFIG = {
  indexer:     'http://localhost:8088/api/v4/graphql',
  indexerWS:   'ws://localhost:8088/api/v4/graphql/ws',
  node:        'http://localhost:9944',
  proofServer: 'http://127.0.0.1:6300',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'holder');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
export const HolderContract = await import(pathToFileURL(contractPath).href);
export const PRIVATE_STATE_ID = 'holder-state';

// `wallet-sdk-unshielded-wallet@3` removed `InMemoryTransactionHistoryStorage`
// — the new wallet-sdk-shielded and wallet-sdk-dust-wallet expect a storage
// object exposing `upsert`/`get`/`delete`/`list`. We don't need history for
// this repro, so a no-op stub is enough.
const NoopTxHistoryStorage = {
  upsert: async (..._args: unknown[]) => undefined,
  get:    async (..._args: unknown[]) => null,
  delete: async (..._args: unknown[]) => undefined,
  list:   async (..._args: unknown[]) => [] as unknown[],
  clear:  async (..._args: unknown[]) => undefined,
};

export function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid WALLET_SEED');

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');

  hdWallet.hdWallet.clear();
  return result.keys;
}

export async function createWallet(seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  // feeBlocksMargin: 100 is required for our k=10 contract on
  // midnight-node:0.22.5 — the SDK default of 5 trips
  // MalformedError::BalanceCheckOverspend at deploy time.
  const feeBlocksMargin = Number(process.env.FEE_BLOCKS_MARGIN ?? '100');

  const additionalFeeOverhead = 1n;

  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexer,
      indexerWsUrl: CONFIG.indexerWS,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
    costParameters: { feeBlocksMargin },
    txHistoryStorage: NoopTxHistoryStorage,
  };

  const wallet: WalletFacade = await (WalletFacade as any).init({
    configuration,
    shielded: (config: any) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: any) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config: any) =>
      DustWallet(config).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

export async function createProviders(walletCtx: Awaited<ReturnType<typeof createWallet>>) {
  const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const t0 = Date.now();
      const mark = (label: string): void => {
        const dt = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`      [balanceTx +${dt}s] ${label}`);
      };
      mark('balanceUnboundTransaction start');
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      mark('balanceUnboundTransaction done');
      mark('signRecipe start');
      const signed = await walletCtx.wallet.signRecipe(recipe, signFn);
      mark('signRecipe done');
      mark('finalizeRecipe start');
      const finalized = await walletCtx.wallet.finalizeRecipe(signed);
      mark('finalizeRecipe done');
      return finalized;
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: 'midnight-level-db',
      privateStateStoreName: PRIVATE_STATE_ID,
      // level-private-state-provider requires >= 16 characters.
      privateStoragePasswordProvider: () => 'Midnight-Error-186-Repro!',
      accountId: state.shielded.encryptionPublicKey.toHexString().slice(0, 16),
      walletProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

export function hexToBytes32(hex: string): Uint8Array {
  const cleanHex = hex.replace(/^0x/, '');
  const buffer = Buffer.from(cleanHex, 'hex');
  const bytes = new Uint8Array(32);
  bytes.set(buffer.subarray(0, Math.min(32, buffer.length)));
  return bytes;
}

// Wait until wallet state reports isSynced=true. Uses the proven rx pipe
// pattern (filter + first emission) rather than polling — the polling form
// can resolve early on a BehaviorSubject's cached value before the
// genesis state has finished applying, which led to a misleading
// "could not balance dust" downstream.
export async function syncWallet(
  walletCtx: Awaited<ReturnType<typeof createWallet>>,
  label: string,
): Promise<void> {
  process.stdout.write(`      syncing ${label} to network`);
  await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap(() => process.stdout.write(' .')),
      Rx.filter((state) => state.isSynced === true),
    ),
  );
  console.log('  done.');
}

export function printBalances(state: FacadeState): void {
  const fmt = (v: any) => (v === undefined || v === null ? '(none)' : String(v));
  const unshielded = Object.entries(state.unshielded.balances as Record<string, bigint>);
  const shielded = Object.entries(state.shielded.balances as Record<string, bigint>);
  let dust = '(unknown)';
  try {
    dust = fmt(
      state.dust?.capabilities?.coinsAndBalances?.getWalletBalance?.(state.dust.state, new Date()) ??
        state.dust?.walletBalance?.(new Date()),
    );
  } catch {}
  console.log(`      wallet: ${unshielded[0][1]} Night, ${shielded.length} Zswap, dust=${dust}`);
}
