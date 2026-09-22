/**
 * Durable settlement records.
 *
 * Why this exists
 * ---------------
 * `ExactStellarScheme.settle()` performs no idempotency of its own, and
 * `@x402/core`'s `InMemoryPendingSettlementStore` is per-process with lazy
 * TTL pruning — by its own documentation it only helps when a retry happens
 * to land back on the same process. Neither is sufficient here.
 *
 * A facilitator that proxies `settle()` naively will submit the same payment
 * twice when a client retries a request whose response was lost. On Stellar
 * that is a second real transfer of real value, and Clara cannot reverse it.
 * The Runbook (document 10, section 3) states the operating rule this class
 * enforces in code: a settlement whose confirmation was not observed is
 * resolved by transaction hash, never resubmitted.
 *
 * The mechanism is an atomic claim. The first caller to present a payload
 * digest wins the right to submit; every later caller is handed the existing
 * record instead, whatever state it is in. Correctness depends on that claim
 * being atomic, which is why it is a single conditional INSERT rather than a
 * read followed by a write.
 *
 * Backed by `node:sqlite` deliberately: it adds no dependency to the tree the
 * licence gate scans and no third-party code to the path a security audit
 * must review.
 */
import { DatabaseSync } from 'node:sqlite';
import type { PendingSettlementStore } from '@x402/core/facilitator';

/**
 * Lifecycle of a single settlement, keyed by payload digest.
 *
 * `unknown` is the state that matters most operationally. It means a
 * submission was attempted and its disposition was never established — the
 * payment may or may not have settled. It is deliberately distinct from
 * `failed`, which asserts the payment provably did not broadcast. Collapsing
 * the two would invite exactly the resubmission the Runbook forbids.
 */
export type SettlementState = 'claimed' | 'submitted' | 'confirmed' | 'failed' | 'unknown';

export interface SettlementRecord {
  readonly key: string;
  readonly state: SettlementState;
  /** Present once the transaction has been broadcast. */
  readonly txHash: string | undefined;
  /** Enumerated machine code, present only when state is `failed`. */
  readonly failureCode: string | undefined;
  readonly network: string | undefined;
  readonly claimedAt: number;
  readonly updatedAt: number;
}

export type ClaimOutcome =
  /** Caller holds the claim and is the only party permitted to submit. */
  | { readonly claimed: true }
  /** Someone already claimed this digest; act on `record` instead of submitting. */
  | { readonly claimed: false; readonly record: SettlementRecord };

interface Row {
  key: string;
  state: string;
  tx_hash: string | null;
  failure_code: string | null;
  network: string | null;
  claimed_at: number;
  updated_at: number;
}

function toRecord(row: Row): SettlementRecord {
  return {
    key: row.key,
    state: row.state as SettlementState,
    txHash: row.tx_hash ?? undefined,
    failureCode: row.failure_code ?? undefined,
    network: row.network ?? undefined,
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

export class SettlementStore implements PendingSettlementStore {
  private readonly db: DatabaseSync;

  /**
   * @param location Filesystem path, or `:memory:` for tests.
   */
  constructor(location: string) {
    this.db = new DatabaseSync(location);
    // WAL keeps readers from blocking the settle path; FULL synchronous is
    // the right trade here because losing a settlement record after a crash
    // is precisely the condition that leads to a double payment.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        key          TEXT PRIMARY KEY,
        state        TEXT NOT NULL,
        tx_hash      TEXT,
        failure_code TEXT,
        network      TEXT,
        claimed_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      ) STRICT
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS settlements_state_idx
        ON settlements (state, updated_at)
    `);
  }

  /**
   * Atomically claims the right to submit `key`.
   *
   * Records are never expired or pruned. A TTL here would reintroduce the
   * double-payment window this class exists to close: a digest that aged out
   * would be claimable a second time.
   */
  claim(key: string, network?: string): ClaimOutcome {
    const now = Date.now();
    const inserted = this.db
      .prepare(
        `INSERT INTO settlements (key, state, tx_hash, failure_code, network, claimed_at, updated_at)
         VALUES (?, 'claimed', NULL, NULL, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(key, network ?? null, now, now);

    if (inserted.changes === 1) return { claimed: true };

    const existing = this.lookup(key);
    if (!existing) {
      // The row must exist: the INSERT reported a conflict. Absence means
      // concurrent deletion, which no code path should perform.
      throw new Error(`settlement ${key} conflicted on insert but is absent`);
    }
    return { claimed: false, record: existing };
  }

  /** Records that the transaction was broadcast but is not yet confirmed. */
  markSubmitted(key: string, txHash: string): void {
    this.update(key, 'submitted', { txHash });
  }

  markConfirmed(key: string, txHash: string): void {
    this.update(key, 'confirmed', { txHash });
  }

  /**
   * Marks a settlement terminally failed.
   *
   * Only for failures that provably did not broadcast. A failure of unknown
   * disposition must stay `submitted`, because marking it failed invites a
   * resubmission of a payment that may already have settled.
   */
  markFailed(key: string, failureCode: string): void {
    this.update(key, 'failed', { failureCode });
  }

  /**
   * Marks a settlement whose disposition could not be established — the
   * submission was attempted but neither success nor provable non-broadcast
   * was observed. An operator must resolve these against the network.
   */
  markUnknown(key: string, failureCode: string): void {
    this.update(key, 'unknown', { failureCode });
  }

  lookup(key: string): SettlementRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM settlements WHERE key = ?')
      .get(key) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /**
   * Settlements an operator must resolve against the network: broadcast but
   * unconfirmed, or attempted with an unestablished disposition. These are
   * the records the Runbook's "resolve by transaction hash, never resubmit"
   * rule applies to.
   */
  unresolved(): SettlementRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM settlements
          WHERE state IN ('submitted', 'unknown')
          ORDER BY updated_at ASC`
      )
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  close(): void {
    this.db.close();
  }

  private update(
    key: string,
    state: SettlementState,
    fields: { txHash?: string; failureCode?: string }
  ): void {
    const result = this.db
      .prepare(
        `UPDATE settlements
            SET state = ?,
                tx_hash = COALESCE(?, tx_hash),
                failure_code = COALESCE(?, failure_code),
                updated_at = ?
          WHERE key = ?`
      )
      .run(state, fields.txHash ?? null, fields.failureCode ?? null, Date.now(), key);

    if (result.changes === 0) {
      throw new Error(`cannot transition unknown settlement ${key} to ${state}`);
    }
  }

  // ---- PendingSettlementStore conformance -------------------------------
  // Lets Clara's store be handed to any upstream code expecting the
  // interface. `get` intentionally reports only broadcast transactions: a
  // claimed-but-unsubmitted settlement has no hash to report, and a failed
  // one must not be presented as pending.

  async get(key: string): Promise<string | undefined> {
    const record = this.lookup(key);
    if (!record) return undefined;
    if (record.state === 'submitted' || record.state === 'confirmed') return record.txHash;
    return undefined;
  }

  async set(key: string, txHash: string): Promise<void> {
    if (!this.lookup(key)) this.claim(key);
    this.markSubmitted(key, txHash);
  }

  /**
   * Interface conformance only.
   *
   * Upstream's contract is that `delete` removes the pending entry once a
   * settlement is confirmed or terminally failed. Clara does not erase the
   * row, because the row is the evidence that this digest was already paid;
   * deleting it would make the digest claimable again. Callers that reach
   * here without having recorded an outcome get a terminal state rather than
   * a silent no-op, so a forgotten transition surfaces as a visible `failed`
   * record instead of an invisible replay window.
   */
  async delete(key: string): Promise<void> {
    const record = this.lookup(key);
    if (!record) return;
    if (record.state === 'confirmed' || record.state === 'failed' || record.state === 'unknown') {
      return;
    }
    if (record.txHash) {
      this.markConfirmed(key, record.txHash);
      return;
    }
    this.markFailed(key, 'settlement_abandoned');
  }
}
