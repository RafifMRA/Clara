/**
 * These tests are written as attempts to make Clara pay twice. Each one is a
 * scenario a client or a network can actually produce.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { SettlementStore } from '../src/store/settlement-store.ts';
import { SettlementGuard, type SchemeSettleResult } from '../src/settlement-guard.ts';

const PAYLOAD = { scheme: 'exact', payload: { authEntry: 'AAAA', expirationLedger: 99 } };
const REQUIREMENTS = { scheme: 'exact', maxAmountRequired: '10000', payTo: 'GABC' };

/** A settle function that records how many times it was actually invoked. */
function spy(result: SchemeSettleResult | (() => Promise<SchemeSettleResult>)) {
  const calls: number[] = [];
  const fn = async () => {
    calls.push(Date.now());
    return typeof result === 'function' ? result() : result;
  };
  return { fn, get count() { return calls.length; } };
}

function harness(result: SchemeSettleResult | (() => Promise<SchemeSettleResult>)) {
  const store = new SettlementStore(':memory:');
  const settle = spy(result);
  return { store, settle, guard: new SettlementGuard(store, settle.fn) };
}

test('a successful settlement reports its hash', async () => {
  const { guard, settle, store } = harness({ success: true, transaction: 'tx_ok' });
  const out = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(out.kind, 'settled');
  assert.ok(out.kind === 'settled' && out.txHash === 'tx_ok');
  assert.strictEqual(settle.count, 1);
  store.close();
});

test('a retry of a settled payment does not submit again', async () => {
  const { guard, settle, store } = harness({ success: true, transaction: 'tx_ok' });

  await guard.settle(PAYLOAD, REQUIREMENTS);
  const retry = await guard.settle(PAYLOAD, REQUIREMENTS);

  assert.strictEqual(settle.count, 1, 'the network must be touched exactly once');
  assert.strictEqual(retry.kind, 'already_processed');
  assert.ok(retry.kind === 'already_processed' && retry.record.txHash === 'tx_ok',
    'the retry must be handed the hash to resolve against');
  store.close();
});

test('concurrent identical settlements submit once', async () => {
  const { guard, settle, store } = harness(
    () => new Promise(resolve => setTimeout(() => resolve({ success: true, transaction: 'tx_race' }), 20))
  );

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, () => guard.settle(PAYLOAD, REQUIREMENTS))
  );

  assert.strictEqual(settle.count, 1, 'ten concurrent callers must produce one submission');
  assert.strictEqual(outcomes.filter(o => o.kind === 'settled').length, 1);
  assert.strictEqual(outcomes.filter(o => o.kind === 'already_processed').length, 9);
  store.close();
});

test('a provably pre-broadcast failure is recorded as failed', async () => {
  const { guard, store } = harness({ success: false, errorReason: 'insufficient_funds' });
  const out = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(out.kind, 'failed');
  assert.strictEqual(store.lookup(out.key)?.state, 'failed');
  store.close();
});

test('a failed payment cannot be retried into a second submission', async () => {
  const { guard, settle, store } = harness({ success: false, errorReason: 'simulation_failed' });

  await guard.settle(PAYLOAD, REQUIREMENTS);
  const retry = await guard.settle(PAYLOAD, REQUIREMENTS);

  assert.strictEqual(settle.count, 1, 'a rejected digest must not reach the network twice');
  assert.strictEqual(retry.kind, 'already_processed');
  store.close();
});

test('an unrecognised failure reason is indeterminate, not failed', async () => {
  // Deny-listing would be unsafe here: an unknown reason might still have
  // broadcast, so it must not be presented as a clean failure.
  const { guard, store } = harness({ success: false, errorReason: 'some_new_upstream_reason' });
  const out = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(out.kind, 'indeterminate');
  assert.strictEqual(store.lookup(out.key)?.state, 'unknown');
  store.close();
});

test('a thrown error is indeterminate and never retried', async () => {
  const store = new SettlementStore(':memory:');
  let calls = 0;
  const guard = new SettlementGuard(store, async () => {
    calls += 1;
    throw new Error('socket hang up');
  });

  const first = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(first.kind, 'indeterminate', 'a timeout may have broadcast');

  const retry = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(calls, 1, 'an indeterminate payment must not be resubmitted');
  assert.strictEqual(retry.kind, 'already_processed');
  store.close();
});

test('a failure carrying a transaction hash is indeterminate', async () => {
  // The hash proves it reached the network; the response is not authoritative.
  const { guard, store } = harness({
    success: false,
    transaction: 'tx_maybe',
    errorReason: 'confirmation_timeout',
  });
  const out = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(out.kind, 'indeterminate');
  const record = store.lookup(out.key);
  assert.strictEqual(record?.state, 'unknown');
  assert.strictEqual(record?.txHash, 'tx_maybe', 'the hash must be retained for resolution');
  store.close();
});

test('success without a hash is indeterminate rather than reported settled', async () => {
  const { guard, store } = harness({ success: true });
  const out = await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(out.kind, 'indeterminate');
  assert.strictEqual(store.lookup(out.key)?.failureCode, 'settled_without_transaction_hash');
  store.close();
});

test('a different payment still settles independently', async () => {
  const { guard, settle, store } = harness({ success: true, transaction: 'tx_ok' });
  await guard.settle(PAYLOAD, REQUIREMENTS);
  const other = await guard.settle(
    { ...PAYLOAD, payload: { authEntry: 'BBBB', expirationLedger: 100 } },
    REQUIREMENTS
  );
  assert.strictEqual(other.kind, 'settled');
  assert.strictEqual(settle.count, 2, 'distinct payments must each settle');
  store.close();
});

test('the same entry against raised terms is not treated as a retry', async () => {
  const { guard, settle, store } = harness({ success: true, transaction: 'tx_ok' });
  await guard.settle(PAYLOAD, REQUIREMENTS);
  const out = await guard.settle(PAYLOAD, { ...REQUIREMENTS, maxAmountRequired: '99999' });
  assert.strictEqual(out.kind, 'settled');
  assert.strictEqual(settle.count, 2);
  store.close();
});

test('indeterminate settlements surface for operator resolution', async () => {
  const { guard, store } = harness({ success: false, errorReason: 'confirmation_timeout', transaction: 'tx_x' });
  await guard.settle(PAYLOAD, REQUIREMENTS);
  assert.strictEqual(store.unresolved().length, 1,
    'the Runbook needs these listed to resolve by hash');
  store.close();
});
