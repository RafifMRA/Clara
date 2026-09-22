/**
 * The settlement store is the control that prevents a retried request from
 * paying twice. Its tests are written primarily as attempts to defeat it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettlementStore } from '../src/store/settlement-store.ts';

const DIGEST = 'a1b2c3d4e5f6';

function store() {
  return new SettlementStore(':memory:');
}

test('first claim on a digest is granted', () => {
  const s = store();
  assert.deepStrictEqual(s.claim(DIGEST), { claimed: true });
  s.close();
});

test('a second claim is refused and returns the existing record', () => {
  const s = store();
  s.claim(DIGEST);
  const outcome = s.claim(DIGEST);
  assert.strictEqual(outcome.claimed, false);
  assert.ok(!outcome.claimed && outcome.record.state === 'claimed');
  s.close();
});

test('only one of many competing claims wins', () => {
  const s = store();
  const granted = Array.from({ length: 50 }, () => s.claim(DIGEST)).filter(o => o.claimed);
  assert.strictEqual(granted.length, 1, 'exactly one caller may submit a given digest');
  s.close();
});

test('a submitted settlement cannot be claimed again', () => {
  const s = store();
  s.claim(DIGEST);
  s.markSubmitted(DIGEST, 'tx_abc');

  const retry = s.claim(DIGEST);
  assert.strictEqual(retry.claimed, false, 'retry must never win the claim');
  assert.ok(!retry.claimed && retry.record.txHash === 'tx_abc',
    'retry must be handed the existing hash to resolve against');
  s.close();
});

test('a confirmed settlement cannot be claimed again', () => {
  const s = store();
  s.claim(DIGEST);
  s.markSubmitted(DIGEST, 'tx_abc');
  s.markConfirmed(DIGEST, 'tx_abc');
  assert.strictEqual(s.claim(DIGEST).claimed, false);
  s.close();
});

test('a failed settlement is still not re-claimable', () => {
  // A terminal failure means this digest was decided. Re-claiming it would
  // let a client retry into a second submission.
  const s = store();
  s.claim(DIGEST);
  s.markFailed(DIGEST, 'simulation_failed');
  const retry = s.claim(DIGEST);
  assert.strictEqual(retry.claimed, false);
  assert.ok(!retry.claimed && retry.record.failureCode === 'simulation_failed');
  s.close();
});

test('records survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-store-'));
  const file = path.join(dir, 'settlements.sqlite');
  try {
    const first = new SettlementStore(file);
    first.claim(DIGEST);
    first.markSubmitted(DIGEST, 'tx_durable');
    first.close();

    // A process restart is the exact scenario the in-memory store fails.
    const second = new SettlementStore(file);
    assert.strictEqual(second.claim(DIGEST).claimed, false,
      'a restart must not reopen the replay window');
    assert.strictEqual(second.lookup(DIGEST)?.txHash, 'tx_durable');
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unresolved lists broadcast settlements awaiting confirmation', () => {
  const s = store();
  s.claim('pending-one');
  s.markSubmitted('pending-one', 'tx_1');
  s.claim('done');
  s.markSubmitted('done', 'tx_2');
  s.markConfirmed('done', 'tx_2');
  s.claim('untouched');

  const keys = s.unresolved().map(r => r.key);
  assert.deepStrictEqual(keys, ['pending-one'],
    'only broadcast-but-unconfirmed settlements need operator resolution');
  s.close();
});

test('transitioning an unknown settlement is an error, not a silent insert', () => {
  const s = store();
  assert.throws(() => s.markSubmitted('never-claimed', 'tx_x'), /unknown settlement/);
  s.close();
});

test('get reports a hash only once broadcast', async () => {
  const s = store();
  s.claim(DIGEST);
  assert.strictEqual(await s.get(DIGEST), undefined, 'claimed but unsubmitted has no hash');
  s.markSubmitted(DIGEST, 'tx_abc');
  assert.strictEqual(await s.get(DIGEST), 'tx_abc');
  s.close();
});

test('get does not present a failed settlement as pending', async () => {
  const s = store();
  s.claim(DIGEST);
  s.markFailed(DIGEST, 'simulation_failed');
  assert.strictEqual(await s.get(DIGEST), undefined);
  s.close();
});

test('delete preserves the record rather than reopening the digest', async () => {
  const s = store();
  s.claim(DIGEST);
  s.markSubmitted(DIGEST, 'tx_abc');

  await s.delete(DIGEST);

  assert.ok(s.lookup(DIGEST), 'the row is the evidence this digest was paid');
  assert.strictEqual(s.claim(DIGEST).claimed, false,
    'delete must not make a paid digest claimable again');
  s.close();
});

test('delete without a recorded outcome marks it failed rather than vanishing', async () => {
  const s = store();
  s.claim(DIGEST);
  await s.delete(DIGEST);
  assert.strictEqual(s.lookup(DIGEST)?.state, 'failed');
  assert.strictEqual(s.lookup(DIGEST)?.failureCode, 'settlement_abandoned');
  s.close();
});

test('distinct digests are independent', () => {
  const s = store();
  assert.strictEqual(s.claim('digest-a').claimed, true);
  assert.strictEqual(s.claim('digest-b').claimed, true);
  s.close();
});
