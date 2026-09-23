/**
 * HTTP surface tests. The important ones are the /settle retry cases: a
 * client that retries must never cause a second payment, and must receive an
 * answer a canonical x402 client can act on.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import type { AddressInfo } from 'node:net';
import { createFacilitatorServer, type FacilitatorPort } from '../src/http/server.ts';
import { SettlementStore } from '../src/store/settlement-store.ts';
import { SettlementGuard, type SchemeSettleResult } from '../src/settlement-guard.ts';

const REQUIREMENTS = { scheme: 'exact', network: 'stellar:testnet', payTo: 'GABC', maxAmountRequired: '10000' };
const PAYLOAD = { x402Version: 2, scheme: 'exact', payload: { authEntry: 'AAAA' } };

function fakeFacilitator(verify?: FacilitatorPort['verify']): FacilitatorPort {
  return {
    getSupported: () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet', extra: { areFeesSponsored: true } }],
      extensions: [],
      signers: {},
    }),
    verify: verify ?? (async () => ({ isValid: true, payer: 'GPAYER' })),
  };
}

async function harness(
  settleResult: SchemeSettleResult | (() => Promise<SchemeSettleResult>),
  verify?: FacilitatorPort['verify']
) {
  const store = new SettlementStore(':memory:');
  let settleCalls = 0;
  const guard = new SettlementGuard(store, async () => {
    settleCalls += 1;
    return typeof settleResult === 'function' ? settleResult() : settleResult;
  });
  const server = createFacilitatorServer({ facilitator: fakeFacilitator(verify), guard, store });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    get settleCalls() { return settleCalls; },
    store,
    async post(path: string, body: unknown) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) as any };
    },
    async get(path: string) {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json().catch(() => null) as any };
    },
    async close() {
      await new Promise<void>(r => server.close(() => r()));
      store.close();
    },
  };
}

const settleBody = { x402Version: 2, paymentPayload: PAYLOAD, paymentRequirements: REQUIREMENTS };

test('GET /supported reports kinds and sponsorship', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  const res = await h.get('/supported');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.kinds[0].scheme, 'exact');
  assert.strictEqual(res.body.kinds[0].extra.areFeesSponsored, true);
  await h.close();
});

test('GET /healthz responds', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  assert.strictEqual((await h.get('/healthz')).status, 200);
  await h.close();
});

test('unknown route is 404', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  assert.strictEqual((await h.get('/nope')).status, 404);
  await h.close();
});

test('POST /verify returns the verification result as 200', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  const res = await h.post('/verify', settleBody);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.isValid, true);
  await h.close();
});

test('an invalid payment is 200 with isValid false, not an HTTP error', async () => {
  // A canonical client reads isValid; an HTTP error would break it.
  const h = await harness({ success: true, transaction: 'tx' }, async () => ({
    isValid: false,
    invalidReason: 'invalid_exact_stellar_payload_amount_mismatch',
  }));
  const res = await h.post('/verify', settleBody);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.isValid, false);
  assert.strictEqual(res.body.invalidReason, 'invalid_exact_stellar_payload_amount_mismatch');
  await h.close();
});

test('malformed JSON is rejected', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  const res = await h.post('/settle', '{not json');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_json');
  assert.strictEqual(h.settleCalls, 0, 'a malformed request must never reach settlement');
  await h.close();
});

test('a body missing paymentPayload is rejected', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  const res = await h.post('/settle', { paymentRequirements: REQUIREMENTS });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'missing_payment_payload');
  assert.strictEqual(h.settleCalls, 0);
  await h.close();
});

test('POST /settle returns the transaction hash', async () => {
  const h = await harness({ success: true, transaction: 'tx_settled' });
  const res = await h.post('/settle', settleBody);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.transaction, 'tx_settled');
  assert.strictEqual(res.body.network, 'stellar:testnet');
  await h.close();
});

test('retrying a settled payment replays the original response and pays once', async () => {
  const h = await harness({ success: true, transaction: 'tx_settled' });

  const first = await h.post('/settle', settleBody);
  const second = await h.post('/settle', settleBody);

  assert.strictEqual(h.settleCalls, 1, 'the network must be touched once');
  assert.strictEqual(second.status, 200);
  assert.deepStrictEqual(second.body, first.body,
    'a retry must receive the identical answer, so a canonical client sees idempotency');
  await h.close();
});

test('retrying a rejected payment replays the rejection without resubmitting', async () => {
  const h = await harness({ success: false, errorReason: 'insufficient_funds' });

  const first = await h.post('/settle', settleBody);
  const second = await h.post('/settle', settleBody);

  assert.strictEqual(h.settleCalls, 1);
  assert.strictEqual(first.body.success, false);
  assert.strictEqual(second.body.errorReason, 'insufficient_funds');
  await h.close();
});

test('an indeterminate settlement is 202 and tells the client not to resubmit', async () => {
  const h = await harness({ success: false, errorReason: 'confirmation_timeout', transaction: 'tx_maybe' });
  const res = await h.post('/settle', settleBody);

  assert.strictEqual(res.status, 202, 'not a failure: the payment may have settled');
  assert.strictEqual(res.body.errorReason, 'settlement_pending');
  assert.strictEqual(res.body.transaction, 'tx_maybe', 'the hash must be returned to resolve against');
  assert.match(res.body.errorMessage, /[Dd]o not resubmit/);
  await h.close();
});

test('retrying an indeterminate settlement still does not resubmit', async () => {
  const h = await harness({ success: false, errorReason: 'confirmation_timeout', transaction: 'tx_maybe' });
  await h.post('/settle', settleBody);
  const retry = await h.post('/settle', settleBody);

  assert.strictEqual(h.settleCalls, 1, 'an unresolved payment must never be submitted again');
  assert.strictEqual(retry.status, 202);
  assert.strictEqual(retry.body.transaction, 'tx_maybe');
  await h.close();
});

test('concurrent settle requests submit once', async () => {
  const h = await harness(
    () => new Promise(r => setTimeout(() => r({ success: true, transaction: 'tx_race' }), 25))
  );

  const results = await Promise.all(Array.from({ length: 8 }, () => h.post('/settle', settleBody)));

  assert.strictEqual(h.settleCalls, 1, 'eight concurrent requests, one payment');
  assert.strictEqual(results.filter(r => r.status === 200 && r.body.success).length, 1);
  // The losers are told it is in progress, never given a false failure.
  assert.ok(results.filter(r => r.status === 202).length === 7);
  await h.close();
});

test('a different payment settles independently', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  await h.post('/settle', settleBody);
  const other = await h.post('/settle', {
    ...settleBody,
    paymentPayload: { ...PAYLOAD, payload: { authEntry: 'BBBB' } },
  });
  assert.strictEqual(other.status, 200);
  assert.strictEqual(h.settleCalls, 2);
  await h.close();
});

test('an oversized body is refused before settlement', async () => {
  const h = await harness({ success: true, transaction: 'tx' });
  const res = await fetch(`${h.base}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...settleBody, pad: 'x'.repeat(300 * 1024) }),
  }).catch(() => null);
  assert.ok(res === null || res.status === 413);
  assert.strictEqual(h.settleCalls, 0);
  await h.close();
});
