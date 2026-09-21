/**
 * Network and asset configuration.
 *
 * Values here are deliberately explicit rather than inferred. The decimals
 * constant in particular is the one the Test Plan (document 9, section 3)
 * calls out as a dedicated negative-test case: USDC on Stellar uses seven
 * decimals, not the six that is common on other networks. Getting it wrong
 * yields a payment that looks correct and is short by two orders of
 * magnitude, which is exactly the class of defect that is expensive and
 * silent.
 */

/** CAIP-2 network identifiers, as used across the x402 packages. */
export const NETWORKS = {
  testnet: 'stellar:testnet',
  pubnet: 'stellar:pubnet',
} as const;

export type ClaraNetwork = (typeof NETWORKS)[keyof typeof NETWORKS];

/**
 * USDC decimals on Stellar.
 *
 * Not six. See the note above. Amounts are handled throughout Clara as
 * integer base units in string form; this constant exists for display and
 * validation, never to drive floating-point arithmetic.
 */
export const STELLAR_USDC_DECIMALS = 7;

/** Testnet USDC issuer, per the Stellar x402 quickstart documentation. */
export const TESTNET_USDC_ISSUER =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Default Soroban RPC endpoints. Overridable per deployment. */
export const DEFAULT_RPC_URLS: Record<ClaraNetwork, string> = {
  [NETWORKS.testnet]: 'https://soroban-testnet.stellar.org',
  [NETWORKS.pubnet]: 'https://mainnet.sorobanrpc.com',
};

export interface ClaraConfig {
  /** Networks this deployment serves. Phase 0 is testnet only. */
  readonly networks: readonly ClaraNetwork[];
  /** Soroban RPC URL per network. */
  readonly rpcUrls: Readonly<Record<string, string>>;
  /**
   * Whether this deployment pays network fees on behalf of payers.
   * Surfaced to clients through the supported endpoint so a client can
   * determine, before paying, whether it must fund its own fees.
   * Advertised as a service characteristic, never a contractual
   * commitment (document 11, section 5).
   */
  readonly areFeesSponsored: boolean;
  /**
   * Safety ceiling in stroops for a single settlement's network fee.
   * Verification rejects a payment whose simulation-derived fee exceeds
   * this, which bounds the damage from fee-sponsorship abuse
   * (document 7, threat: fee-sponsorship abuse).
   */
  readonly maxTransactionFeeStroops: number;
  readonly port: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Builds configuration from the environment.
 *
 * Secrets are read from the environment and never logged. The operational
 * submission key is resolved separately at signer construction, so it never
 * passes through this object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClaraConfig {
  const networks: ClaraNetwork[] = (env['CLARA_NETWORKS'] ?? NETWORKS.testnet)
    .split(',')
    .map(n => n.trim())
    .filter((n): n is ClaraNetwork => n === NETWORKS.testnet || n === NETWORKS.pubnet);

  if (networks.length === 0) {
    throw new Error(
      `CLARA_NETWORKS must list at least one of: ${NETWORKS.testnet}, ${NETWORKS.pubnet}`
    );
  }

  const rpcUrls: Record<string, string> = {};
  for (const network of networks) {
    const override = env[`CLARA_RPC_URL_${network === NETWORKS.testnet ? 'TESTNET' : 'PUBNET'}`];
    rpcUrls[network] = override ?? DEFAULT_RPC_URLS[network];
  }

  return {
    networks,
    rpcUrls,
    areFeesSponsored: env['CLARA_SPONSOR_FEES'] !== 'false',
    maxTransactionFeeStroops: Number(env['CLARA_MAX_FEE_STROOPS'] ?? 50_000),
    port: Number(env['PORT'] ?? 4021),
  };
}

export { requireEnv };
