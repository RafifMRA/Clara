/**
 * Settlement idempotency guard.
 *
 * `ExactStellarScheme.settle()` submits whatever it is given. It performs no
 * idempotency of its own, and nothing upstream wires a settlement store in
 * automatically. A facilitator that proxies it directly will therefore submit
 * the same payment a second time whenever a client retries a request whose
 * response was lost — a second real transfer that Clara cannot reverse.
 *
 * This guard is the only path through which settlement may be invoked. It
 * grants at most one submission per payment digest, for the lifetime of the
 * store, and hands every later caller the recorded outcome instead.
 *
 * The rule it encodes, from the Runbook (document 10, section 3): a
 * settlement whose confirmation was not observed is resolved by transaction
 * hash, never resubmitted.
 */
import type { SettlementRecord, SettlementStore } from './store/settlement-store.ts';
import { settlementKey } from './payload-digest.ts';

/** What the underlying scheme returns on a settle attempt. */
export interface SchemeSettleResult {
  readonly success: boolean;
  readonly transaction?: string | undefined;
  readonly errorReason?: string | undefined;
  readonly network?: string | undefined;
}

export type GuardedSettleOutcome =
  /** This call performed the submission. */
  | { readonly kind: 'settled'; readonly key: string; readonly txHash: string }
  /** Submission was attempted and provably did not broadcast. */
  | { readonly kind: 'failed'; readonly key: string; readonly code: string }
  /**
   * A prior call already decided this digest. The caller must act on
   * `record` — poll its hash if present — and must never retry the payment.
   */
  | { readonly kind: 'already_processed'; readonly key: string; readonly record: SettlementRecord }
  /**
   * Submission was attempted and its disposition could not be established.
   * The payment may have settled. Resolve against the network.
   */
  | { readonly kind: 'indeterminate'; readonly key: string; readonly code: string };

/**
 * Error causes that prove no transaction reached the network.
 *
 * Deliberately a narrow allow-list rather than a deny-list. Anything not
 * provably pre-broadcast is treated as indeterminate, because the cost of
 * wrongly assuming a payment failed is a double payment, whereas the cost of
 * wrongly assuming it may have settled is an operator having to check a
 * transaction hash.
 */
const PROVABLY_PRE_BROADCAST = new Set([
  'insufficient_funds',
  'invalid_exact_stellar_payload',
  'invalid_exact_stellar_payload_authorization',
  'invalid_exact_stellar_payload_recipient_mismatch',
  'invalid_exact_stellar_payload_amount_mismatch',
  'invalid_exact_stellar_payload_asset_mismatch',
  'invalid_exact_stellar_payload_expired',
  'simulation_failed',
  'unsupported_scheme',
  'invalid_network',
]);

export type SettleFn = (
  payload: unknown,
  requirements: unknown
) => Promise<SchemeSettleResult>;

export class SettlementGuard {
  // Declared explicitly rather than as constructor parameter properties:
  // those require code generation, and Clara's sources are run directly by
  // Node's strip-only TypeScript support in development and test.
  readonly #store: SettlementStore;
  readonly #settleFn: SettleFn;

  constructor(store: SettlementStore, settleFn: SettleFn) {
    this.#store = store;
    this.#settleFn = settleFn;
  }

  /**
   * Settles a payment at most once.
   *
   * @param payload The payment payload, already verified.
   * @param requirements The requirements it settles against.
   * @param network Optional network label, recorded for operator context.
   */
  async settle(
    payload: unknown,
    requirements: unknown,
    network?: string
  ): Promise<GuardedSettleOutcome> {
    const key = settlementKey(payload, requirements);

    // The claim is the whole safety property. It is atomic, and it refuses a
    // digest in any prior state — including `failed`, so that a rejected
    // payment cannot be retried into a second submission attempt.
    const claim = this.#store.claim(key, network);
    if (!claim.claimed) {
      return { kind: 'already_processed', key, record: claim.record };
    }

    let result: SchemeSettleResult;
    try {
      result = await this.#settleFn(payload, requirements);
    } catch (error) {
      // A thrown error carries no disposition: the request may have reached
      // the network before the failure. Never treated as a clean failure.
      const code = errorCode(error);
      this.#store.markUnknown(key, code);
      return { kind: 'indeterminate', key, code };
    }

    if (result.success) {
      const txHash = result.transaction;
      if (!txHash) {
        // Success without a hash leaves nothing to resolve against, which is
        // worse than a failure: record it for operator attention rather than
        // reporting a settlement we cannot evidence.
        this.#store.markUnknown(key, 'settled_without_transaction_hash');
        return { kind: 'indeterminate', key, code: 'settled_without_transaction_hash' };
      }
      this.#store.markConfirmed(key, txHash);
      return { kind: 'settled', key, txHash };
    }

    const reason = result.errorReason ?? 'settlement_failed';

    // A hash alongside a failure means it did reach the network; its true
    // outcome must be established on-chain, not from this response.
    if (result.transaction) {
      this.#store.markSubmitted(key, result.transaction);
      this.#store.markUnknown(key, reason);
      return { kind: 'indeterminate', key, code: reason };
    }

    if (PROVABLY_PRE_BROADCAST.has(reason)) {
      this.#store.markFailed(key, reason);
      return { kind: 'failed', key, code: reason };
    }

    this.#store.markUnknown(key, reason);
    return { kind: 'indeterminate', key, code: reason };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) {
    // Normalised for metric labels; the full message goes to logs, not here.
    return `settle_threw:${error.message.slice(0, 80).replace(/\s+/g, '_')}`;
  }
  return 'settle_threw';
}
