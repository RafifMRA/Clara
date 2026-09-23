/**
 * Builds the real facilitator: ExactStellarScheme registered into
 * x402Facilitator.
 *
 * Clara does not implement verification or settlement itself. Both live in
 * @x402/stellar (Apache-2.0), which already validates authorization-entry
 * structure, credential type, expiration, facilitator safety, absence of
 * sub-invocations, and the simulated transfer's sender, recipient, amount and
 * asset. Reimplementing that would be both worse and contrary to the RFP.
 *
 * What Clara adds sits around it: idempotent settlement, durable records, and
 * the HTTP surface.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { createEd25519Signer } from '@x402/stellar';
import type { ClaraConfig } from './config.ts';

export interface FacilitatorBundle {
  readonly facilitator: x402Facilitator;
  readonly scheme: ExactStellarScheme;
}

/**
 * @param config Networks, RPC endpoints, sponsorship and fee ceiling.
 * @param signerSecret The operational submission key. Read from the
 *   environment by the caller and never logged, persisted, or placed in
 *   configuration under version control.
 */
export function buildFacilitator(config: ClaraConfig, signerSecret: string): FacilitatorBundle {
  if (!signerSecret) {
    throw new Error(
      'A signer secret is required to settle. Set CLARA_SIGNER_SECRET; see .env.example.'
    );
  }

  const primaryNetwork = config.networks[0];
  if (!primaryNetwork) throw new Error('At least one network must be configured');

  const signer = createEd25519Signer(signerSecret, primaryNetwork);

  const scheme = new ExactStellarScheme([signer], {
    rpcConfig: { url: config.rpcUrls[primaryNetwork] as string },
    areFeesSponsored: config.areFeesSponsored,
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
  });

  const facilitator = new x402Facilitator();
  facilitator.register([...config.networks], scheme);

  return { facilitator, scheme };
}
