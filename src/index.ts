/**
 * Entry point. Wires config, the settlement store, the guard and the HTTP
 * surface, then listens.
 *
 * Settlement is reachable only through the guard — never by calling the
 * scheme directly — because the guard is what prevents a retried request
 * from paying twice.
 */
import { loadConfig } from './config.ts';
import { buildFacilitator } from './facilitator.ts';
import { SettlementStore } from './store/settlement-store.ts';
import { SettlementGuard } from './settlement-guard.ts';
import { createFacilitatorServer } from './http/server.ts';

function main(): void {
  const config = loadConfig();

  const signerSecret = process.env['CLARA_SIGNER_SECRET'];
  if (!signerSecret) {
    console.error(
      'CLARA_SIGNER_SECRET is not set. Generate a key with `stellar keys generate`, ' +
        'fund it on testnet, and put its secret in .env (see .env.example). ' +
        'The key stays on this machine; it is never committed.'
    );
    process.exit(1);
  }

  const { facilitator, scheme } = buildFacilitator(config, signerSecret);

  const store = new SettlementStore(process.env['CLARA_DB'] ?? 'data/settlements.sqlite');
  const guard = new SettlementGuard(store, (payload, requirements) =>
    scheme.settle(payload as never, requirements as never)
  );

  const server = createFacilitatorServer({ facilitator, guard, store });

  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'listening',
        port: config.port,
        networks: config.networks,
        feesSponsored: config.areFeesSponsored,
      })
    );

    const pending = store.unresolved();
    if (pending.length > 0) {
      // Surfaced at boot because these are the records the Runbook's
      // resolve-by-hash procedure applies to. They must never be resubmitted.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'unresolved_settlements',
          count: pending.length,
          message: 'Resolve these by transaction hash. Do not resubmit.',
        })
      );
    }
  });

  const shutdown = (signal: string) => () => {
    console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

main();
