/**
 * Idempotency key derivation.
 *
 * The settlement store keys on a digest of the payment, so the digest
 * decides what counts as "the same payment". Two properties matter, and they
 * pull in opposite directions:
 *
 *   Stability — a client retrying the identical payment must produce the
 *   identical digest, or the retry is treated as a new payment and pays
 *   twice. This is why the digest is computed over a canonical form with
 *   sorted keys: JSON property order is not guaranteed across serialisers,
 *   and an order-sensitive hash would silently defeat replay protection.
 *
 *   Specificity — two genuinely different payments must not collide. The
 *   digest therefore covers the requirements alongside the payload, so the
 *   same signed authorization entry presented against different terms is not
 *   mistaken for a retry.
 *
 * The digest is not a security boundary on its own. The authorization entry
 * carries its own signature and ledger-based expiration, both validated
 * upstream by ExactStellarScheme. The digest exists to make Clara's own
 * submission decision idempotent.
 */
import { createHash } from 'node:crypto';

/**
 * Serialises a value with object keys in a stable order.
 *
 * Arrays keep their order: sequence is meaningful in a payload, so reordering
 * one would be a different payment, not the same one presented differently.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }

  // Bytes may arrive as a Buffer or Uint8Array; hash the content, not the
  // structural JSON shape a plain stringify would produce.
  if (value instanceof Uint8Array) {
    return `"b64:${Buffer.from(value).toString('base64')}"`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/**
 * Computes the settlement idempotency key for a payment.
 *
 * @param payload The payment payload as received.
 * @param requirements The requirements it is being settled against.
 * @returns A hex SHA-256 digest, stable across retries of the same payment.
 */
export function settlementKey(payload: unknown, requirements: unknown): string {
  return createHash('sha256')
    .update('clara.settlement.v1\n')
    .update(canonicalise({ payload, requirements }))
    .digest('hex');
}
