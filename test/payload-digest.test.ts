/**
 * The digest decides what counts as "the same payment". A digest that is
 * unstable pays twice; a digest that is too coarse accepts a different
 * payment as a retry. Both directions are tested.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { settlementKey, canonicalise } from '../src/payload-digest.ts';

const REQUIREMENTS = {
  scheme: 'exact',
  network: 'stellar:testnet',
  maxAmountRequired: '10000',
  payTo: 'GABC123',
  asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
};

const PAYLOAD = {
  x402Version: 2,
  scheme: 'exact',
  network: 'stellar:testnet',
  payload: { authEntry: 'AAAAAgAAAA...', expirationLedger: 1234567 },
};

test('the same payment yields the same key', () => {
  assert.strictEqual(
    settlementKey(PAYLOAD, REQUIREMENTS),
    settlementKey(PAYLOAD, REQUIREMENTS)
  );
});

test('key ordering does not change the key', () => {
  // A retry serialised by a different client library must still be a retry.
  const reordered = {
    network: 'stellar:testnet',
    payload: { expirationLedger: 1234567, authEntry: 'AAAAAgAAAA...' },
    scheme: 'exact',
    x402Version: 2,
  };
  assert.strictEqual(
    settlementKey(PAYLOAD, REQUIREMENTS),
    settlementKey(reordered, REQUIREMENTS),
    'property order must not affect the digest'
  );
});

test('a different authorization entry is a different payment', () => {
  const other = { ...PAYLOAD, payload: { ...PAYLOAD.payload, authEntry: 'DIFFERENT' } };
  assert.notStrictEqual(settlementKey(PAYLOAD, REQUIREMENTS), settlementKey(other, REQUIREMENTS));
});

test('the same entry against different terms is not a retry', () => {
  const raisedPrice = { ...REQUIREMENTS, maxAmountRequired: '20000' };
  assert.notStrictEqual(
    settlementKey(PAYLOAD, REQUIREMENTS),
    settlementKey(PAYLOAD, raisedPrice),
    'requirements must participate in the digest'
  );
});

test('a changed recipient is a different payment', () => {
  const redirected = { ...REQUIREMENTS, payTo: 'GATTACKER' };
  assert.notStrictEqual(
    settlementKey(PAYLOAD, REQUIREMENTS),
    settlementKey(PAYLOAD, redirected)
  );
});

test('array order is significant', () => {
  assert.notStrictEqual(canonicalise({ a: [1, 2] }), canonicalise({ a: [2, 1] }));
});

test('byte payloads hash by content, not by structure', () => {
  const asBuffer = canonicalise({ sig: Buffer.from([1, 2, 3]) });
  const asTyped = canonicalise({ sig: new Uint8Array([1, 2, 3]) });
  assert.strictEqual(asBuffer, asTyped, 'Buffer and Uint8Array of equal bytes must agree');
  assert.notStrictEqual(asBuffer, canonicalise({ sig: new Uint8Array([3, 2, 1]) }));
  // A plain stringify would turn both into {"0":1,"1":2,"2":3} and lose this.
  assert.match(asBuffer, /b64:/);
});

test('undefined fields do not alter the key', () => {
  const withUndefined = { ...PAYLOAD, extra: undefined };
  assert.strictEqual(
    settlementKey(PAYLOAD, REQUIREMENTS),
    settlementKey(withUndefined, REQUIREMENTS)
  );
});

test('null and absent are distinguished', () => {
  assert.notStrictEqual(canonicalise({ a: null }), canonicalise({}));
});

test('the key is a hex sha-256 digest', () => {
  assert.match(settlementKey(PAYLOAD, REQUIREMENTS), /^[0-9a-f]{64}$/);
});

test('nested key ordering is normalised at every depth', () => {
  const deepA = { outer: { x: 1, inner: { p: 'a', q: 'b' } } };
  const deepB = { outer: { inner: { q: 'b', p: 'a' }, x: 1 } };
  assert.strictEqual(canonicalise(deepA), canonicalise(deepB));
});
