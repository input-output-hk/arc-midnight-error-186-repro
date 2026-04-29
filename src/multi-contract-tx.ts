
import type { Contract } from '@midnight-ntwrk/compact-js/effect/Contract';
import {
  type AlignedValue,
  type ContractAddress,
  ContractState as LedgerContractState,
  communicationCommitmentRandomness,
  LedgerParameters as LedgerLedgerParameters,
  PreTranscript,
  PrePartitionContractCall,
  QueryContext as LedgerQueryContext,
  type PreProof,
  Transaction,
  type UnprovenTransaction,
} from '@midnight-ntwrk/ledger-v8';
import {
  type ContractProviders,
  type ContractStates,
  type FoundContract,
  getPublicStates,
  getStates,
  type PublicContractStates,
  type ScopedTransactionOptions,
  submitTx,
  type TransactionContext,
  type UnsubmittedCallTxData,
} from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  type AnyProvableCircuitId,
  type FinalizedTxData,
  type PrivateStateId,
  SucceedEntirely,
} from '@midnight-ntwrk/midnight-js-types';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { ChargedState } from '@midnight-ntwrk/onchain-runtime-v3';

const SDK_TYPE_ID = Symbol.for('@midnight-ntwrk/midnight-js#Transaction');
const SDK_SUBMIT = Symbol.for('@midnight-ntwrk/midnight-js#Transaction/Submit');
const SDK_MERGE_UNSUBMITTED = Symbol.for('@midnight-ntwrk/midnight-js#Transaction/MergeUnsubmittedCallTxData');
const SDK_CACHE_STATES = Symbol.for('@midnight-ntwrk/midnight-js#Transaction/CacheStates');
const SDK_GET_STATES_FOR_IDENTITY = Symbol.for('@midnight-ntwrk/midnight-js#Transaction/GetCurrentStatesForIdentity');

export interface MultiCachedStateIdentity {
  readonly contractAddress: string;
  readonly privateStateId?: PrivateStateId;
}

const identityKey = (i: MultiCachedStateIdentity): string =>
  `${i.contractAddress} ${i.privateStateId ?? ''}`;

interface InFlightCall {
  readonly identity: MultiCachedStateIdentity;
  readonly circuitId: AnyProvableCircuitId;
  readonly contractStateBytes: Uint8Array;
  readonly ledgerParametersBytes: Uint8Array;
  readonly callData: UnsubmittedCallTxData<Contract.Any, AnyProvableCircuitId>;
}

interface CachedStatesEntry {
  readonly identity: MultiCachedStateIdentity;
  states: ContractStates<unknown> | PublicContractStates;
}

export interface MultiContractTransactionContext {
  readonly [SDK_TYPE_ID]: unknown;
  for<C extends Contract.Any, PCK extends Contract.ProvableCircuitId<C> = Contract.ProvableCircuitId<C>>(
    contract: FoundContract<C>,
  ): TransactionContext<C, PCK>;
  asContextFor<C extends Contract.Any, PCK extends Contract.ProvableCircuitId<C> = Contract.ProvableCircuitId<C>>(): TransactionContext<C, PCK>;
  getInFlightCalls(): readonly InFlightCall[];
}

type Bundler = (calls: readonly InFlightCall[]) => UnprovenTransaction;

export interface MultiContractInternalOptions {
  readonly __bundler?: Bundler;
}

class MultiContractTransactionContextImpl implements MultiContractTransactionContext {
  readonly [SDK_TYPE_ID] = SDK_TYPE_ID;

  private readonly providers: ContractProviders<Contract.Any, AnyProvableCircuitId>;
  private readonly options?: ScopedTransactionOptions;
  private readonly bundler: Bundler;

  private readonly cachedStatesByIdentity: Map<string, CachedStatesEntry> = new Map();
  private readonly inFlightCalls: InFlightCall[] = [];

  private lastUnsubmittedCall:
    | [UnsubmittedCallTxData<Contract.Any, AnyProvableCircuitId>, PrivateStateId?]
    | undefined = undefined;

  constructor(
    providers: ContractProviders<Contract.Any, AnyProvableCircuitId>,
    options?: ScopedTransactionOptions,
    internalOptions?: MultiContractInternalOptions,
  ) {
    this.providers = providers;
    this.options = options;
    this.bundler = internalOptions?.__bundler ?? bundleIntoSingleIntent;
  }

  getAdditionalMappings(): ScopedTransactionOptions['additionalCoinEncPublicKeyMappings'] {
    return this.options?.additionalCoinEncPublicKeyMappings;
  }

  getCurrentStates(): ContractStates<unknown> | PublicContractStates | undefined {
    if (this.inFlightCalls.length === 0) return undefined;
    const lastIdentity = this.inFlightCalls[this.inFlightCalls.length - 1].identity;
    return this.cachedStatesByIdentity.get(identityKey(lastIdentity))?.states;
  }

  getLastUnsubmittedCallTxDataToTransact():
    | [UnsubmittedCallTxData<Contract.Any, AnyProvableCircuitId>, PrivateStateId?]
    | undefined {
    return this.lastUnsubmittedCall;
  }

  [SDK_GET_STATES_FOR_IDENTITY](identity: MultiCachedStateIdentity): ContractStates<unknown> | PublicContractStates | undefined {
    return this.cachedStatesByIdentity.get(identityKey(identity))?.states;
  }

  [SDK_CACHE_STATES](
    states: ContractStates<unknown> | PublicContractStates,
    identity: MultiCachedStateIdentity,
  ): void {
    this.cachedStatesByIdentity.set(identityKey(identity), { identity, states });
  }

  [SDK_MERGE_UNSUBMITTED](
    circuitId: AnyProvableCircuitId,
    callData: UnsubmittedCallTxData<Contract.Any, AnyProvableCircuitId>,
    privateStateId?: PrivateStateId,
  ): void {
    const identity = this.identityForCall(callData, privateStateId);

    const cached = this.cachedStatesByIdentity.get(identityKey(identity));
    if (!cached) {
      throw new Error(
        `No cached state for identity ${identityKey(identity)} at merge time. ` +
          'The SDK is expected to populate the cache via [CacheStates] before [MergeUnsubmittedCallTxData]; ' +
          'this invariant is violated.',
      );
    }
    const contractStateBytes: Uint8Array = cached.states.contractState.serialize();
    const ledgerParametersBytes: Uint8Array = (cached.states.ledgerParameters as { serialize(): Uint8Array }).serialize();

    this.inFlightCalls.push({
      identity,
      circuitId,
      contractStateBytes,
      ledgerParametersBytes,
      callData,
    });
    this.lastUnsubmittedCall = [callData, privateStateId];
    const nextContractState = cached.states.contractState;
    nextContractState.data = new ChargedState(callData.public.nextContractState);
    const nextStates: ContractStates<unknown> | PublicContractStates =
      'privateState' in cached.states
        ? {
            contractState: nextContractState,
            zswapChainState: cached.states.zswapChainState,
            ledgerParameters: cached.states.ledgerParameters,
            privateState: callData.private.nextPrivateState,
          }
        : {
            contractState: nextContractState,
            zswapChainState: cached.states.zswapChainState,
            ledgerParameters: cached.states.ledgerParameters,
          };
    this.cachedStatesByIdentity.set(identityKey(identity), { identity, states: nextStates });
  }

  async [SDK_SUBMIT](): Promise<unknown> {
    return this.submit();
  }

  async submit(): Promise<BundledFinalizedTxData> {
    if (this.inFlightCalls.length === 0) {
      throw new Error('No calls were submitted within the multi-contract scope.');
    }

    const mergedTx = this.bundler(this.inFlightCalls);
    const circuitIds = this.inFlightCalls.map((c) => c.circuitId);

    const subStart = Date.now();
    const subMark = (label: string): void => {
      const dt = ((Date.now() - subStart) / 1000).toFixed(2);
      console.log(`      [submit +${dt}s] ${label}`);
    };

    subMark(`assembled bundled tx; ${circuitIds.length} call(s); circuitIds=${JSON.stringify(circuitIds)}`);
    subMark('proofProvider.proveTx start');
    const provenTx = await this.providers.proofProvider.proveTx(mergedTx);
    subMark('proofProvider.proveTx done');

    try {
      console.log('      [submit] provenTx structure:');
      console.log(
        (provenTx as unknown as { toString(compact?: boolean): string }).toString(false),
      );
    } catch (err) {
      console.log(`      [submit] provenTx.toString failed: ${String(err)}`);
    }
    try {
      const intentsMap = (provenTx as unknown as { intents?: Map<number, unknown> }).intents;
      const intentSegments = intentsMap ? Array.from(intentsMap.keys()) : [];
      // Probe segment 0 (the guaranteed segment, where the dust balancer
      // looks for the fee imbalance) AND every segment carrying an intent.
      const segmentsToProbe = [0, ...intentSegments.filter((s) => s !== 0)];
      for (const seg of segmentsToProbe) {
        try {
          const imb = (provenTx as unknown as {
            imbalances(segment: number, fees?: bigint): Map<unknown, bigint>;
          }).imbalances(seg, 0n);
          const entries = Array.from(imb.entries())
            .map(([t, v]) => `${JSON.stringify(t)}=${v.toString()}`)
            .join(', ');
          console.log(`      [submit] segment ${seg} imbalances (fees=0): ${entries || '(empty)'}`);
        } catch (err) {
          console.log(`      [submit] segment ${seg} imbalances probe failed: ${String(err)}`);
        }
      }
    } catch (err) {
      console.log(`      [submit] imbalances probe failed: ${String(err)}`);
    }

    try {
      const ledgerParams = LedgerLedgerParameters.deserialize(this.inFlightCalls[0].ledgerParametersBytes);
      const feeFns = provenTx as unknown as {
        cost(params: unknown, enforceTimeToDismiss?: boolean): unknown;
        fees(params: unknown, enforceTimeToDismiss?: boolean): bigint;
        feesWithMargin(params: unknown, n: number): bigint;
      };
      try {
        console.log(`      [submit] fees(params, false) = ${feeFns.fees(ledgerParams, false).toString()}`);
      } catch (err) {
        console.log(`      [submit] fees(params, false) probe failed: ${String(err)}`);
      }
      for (const margin of [0, 5, 10, 50, 100]) {
        try {
          console.log(`      [submit] feesWithMargin(params, ${margin}) = ${feeFns.feesWithMargin(ledgerParams, margin).toString()}`);
        } catch (err) {
          console.log(`      [submit] feesWithMargin(params, ${margin}) probe failed: ${String(err)}`);
        }
      }
    } catch (err) {
      console.log(`      [submit] fee probe failed: ${String(err)}`);
    }

    const toSubmit = await this.providers.walletProvider.balanceTx(provenTx);
    const txId = await this.providers.midnightProvider.submitTx(toSubmit);
    const finalizedTxData: FinalizedTxData =
      await this.providers.publicDataProvider.watchForTxData(txId);

    void submitTx;

    if (finalizedTxData.status !== SucceedEntirely) {
      const err = new Error(
        `Bundled multi-contract transaction failed: status=${finalizedTxData.status}, ` +
          `circuits=${JSON.stringify(circuitIds)}`,
      );
      (err as unknown as { finalizedTxData: FinalizedTxData }).finalizedTxData = finalizedTxData;
      throw err;
    }

    const latestByPsId = new Map<PrivateStateId, InFlightCall>();
    for (const c of this.inFlightCalls) {
      if (c.identity.privateStateId !== undefined) {
        latestByPsId.set(c.identity.privateStateId, c);
      }
    }

    const psp = this.providers.privateStateProvider;
    if (psp) {
      for (const [psId, call] of latestByPsId) {
        await psp.set(psId, call.callData.private.nextPrivateState);
      }
    } else if (latestByPsId.size > 0) {
      throw new Error(
        'In-flight calls referenced privateStateIds but providers.privateStateProvider is undefined.',
      );
    }

    return {
      public: finalizedTxData,
      calls: this.inFlightCalls,
    };
  }

  for<C extends Contract.Any, PCK extends Contract.ProvableCircuitId<C> = Contract.ProvableCircuitId<C>>(
    _contract: FoundContract<C>,
  ): TransactionContext<C, PCK> {
    return this as unknown as TransactionContext<C, PCK>;
  }

  asContextFor<C extends Contract.Any, PCK extends Contract.ProvableCircuitId<C> = Contract.ProvableCircuitId<C>>(): TransactionContext<C, PCK> {
    return this as unknown as TransactionContext<C, PCK>;
  }

  getInFlightCalls(): readonly InFlightCall[] {
    return this.inFlightCalls;
  }

  private identityForCall(
    _callData: UnsubmittedCallTxData<Contract.Any, AnyProvableCircuitId>,
    privateStateId: PrivateStateId | undefined,
  ): MultiCachedStateIdentity {
    let candidate: MultiCachedStateIdentity | undefined;
    for (const entry of this.cachedStatesByIdentity.values()) {
      if (entry.identity.privateStateId === privateStateId) {
        candidate = entry.identity;
      }
    }
    if (!candidate) {
      throw new Error(
        `Cannot recover identity for in-flight call: no cached states match privateStateId=${String(
          privateStateId,
        )}. The SDK's caching protocol may have changed.`,
      );
    }
    return candidate;
  }
}

const bundleIntoSingleIntent = (calls: readonly InFlightCall[]): UnprovenTransaction => {
  if (calls.length === 0) {
    throw new Error('Cannot bundle: in-flight call list is empty.');
  }

  const ledgerParams = LedgerLedgerParameters.deserialize(calls[0].ledgerParametersBytes);

  const prePartitionCalls = calls.map((call) => {
    const ledgerState = LedgerContractState.deserialize(call.contractStateBytes);
    const op = ledgerState.operation(call.circuitId);
    if (!op) {
      throw new Error(
        `ContractOperation '${String(call.circuitId)}' is undefined for the cached state of contract ${
          call.identity.contractAddress
        }.`,
      );
    }

    const queryContext = new LedgerQueryContext(
      ledgerState.data,
      call.identity.contractAddress as ContractAddress,
    );
    const preTranscript = new PreTranscript(queryContext, call.callData.public.publicTranscript);

    return new PrePartitionContractCall(
      call.identity.contractAddress as ContractAddress,
      call.circuitId,
      op,
      preTranscript,
      call.callData.private.privateTranscriptOutputs,
      call.callData.private.input,
      call.callData.private.output,
      communicationCommitmentRandomness(),
      String(call.circuitId),
    );
  });

  const empty = Transaction.fromParts(getNetworkId());
  return empty.addCalls(
    { tag: 'random' },
    prePartitionCalls,
    ledgerParams,
    ttlOneHour(),
  ) as UnprovenTransaction;
};

export interface BundledFinalizedTxData {
  readonly public: FinalizedTxData;
  readonly calls: readonly InFlightCall[];
}

export const withMultiContractScopedTransaction = async (
  providers: ContractProviders<Contract.Any, AnyProvableCircuitId>,
  fn: (txCtx: MultiContractTransactionContext) => Promise<void>,
  options?: ScopedTransactionOptions,
  internalOptions?: MultiContractInternalOptions,
): Promise<BundledFinalizedTxData> => {
  const ctx = new MultiContractTransactionContextImpl(providers, options, internalOptions);

  try {
    await fn(ctx);
  } catch (err: unknown) {
    const wrapped = new Error(
      `Unexpected error executing multi-contract scoped transaction '${
        options?.scopeName ?? '<unnamed>'
      }': ${String(err)}`,
      { cause: err },
    );
    providers?.loggerProvider?.error?.call(providers.loggerProvider, wrapped.message);
    throw wrapped;
  }

  try {
    return await ctx.submit();
  } catch (err: unknown) {
    if (err instanceof Error && (err as unknown as { finalizedTxData?: unknown }).finalizedTxData) {
      throw err;
    }
    const wrapped = new Error(
      `Unexpected error submitting multi-contract scoped transaction '${
        options?.scopeName ?? '<unnamed>'
      }': ${String(err)}`,
      { cause: err },
    );
    providers?.loggerProvider?.error?.call(providers.loggerProvider, wrapped.message);
    throw wrapped;
  }
};

export { bundleIntoSingleIntent, getPublicStates, getStates };
