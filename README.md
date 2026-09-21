# Clara

Discovery and settlement layer for agent payments on Stellar.

Clara is an [x402](https://www.x402.org) payment facilitator plus a Stellar-native **Bazaar**: a searchable catalogue that lets an autonomous agent find a paid service, understand its price, and pay for it without a human having wired that integration first.

x402 settlement on Stellar already works. Discovery does not. That gap is what Clara fills.

Built for the `x402-facilitator-bazaar` RFP, targeting Stellar Community Fund Round 46 (submissions close **8 November 2026**).

---

## Status

Pre-implementation. The planning document set is complete and lives in [`docs/`](docs/); code is being built against it.

| Milestone | Scope | State |
|---|---|---|
| M1 | Facilitator: `/verify`, `/settle`, `/supported` | In progress |
| M2 | Bazaar: catalogue, `/discovery/resources`, `/discovery/search` | Not started |
| M3 | MCP server: search and paid-call tools | Not started |
| M4 | `scheme_upto_stellar.md` upstream contribution | Not started |
| M5 | Wire-level conformance + licence attestation | Not started |
| M6 | Third-party audit, then mainnet tag | Not started |

## What we build vs. what we inherit

An early survey of the upstream packages changed the shape of this project, and the distinction is worth stating plainly because it determines where the engineering effort belongs.

**Inherited (Apache-2.0, upstream — do not reimplement):**

- `@x402/stellar` → `ExactStellarScheme` already implements payment verification and settlement, including authorization-entry validation (structure, credential type, expiration, facilitator safety, no sub-invocations, payer signature) and simulation-event validation (exactly one transfer, matching sender/recipient/amount/asset).
- `@x402/core` → `x402Facilitator` orchestration, verify/settle lifecycle hooks, and a `PendingSettlementStore` interface.
- `@x402/extensions/bazaar` → the discovery **contract**: resource types for HTTP and MCP, route-template validation, metadata and tag sanitisation, and the `list` / `search` request and response shapes.

**Clara's own work:**

- The HTTP service that exposes the above as a conformant facilitator.
- Durable persistence behind `PendingSettlementStore` — settlement records that survive restart, so a settlement whose confirmation was missed is resolved by transaction hash rather than resubmitted.
- The catalogue: ingestion, integrity enforcement, revalidation, and takedown.
- **Search ranking** — the implementation behind `search(params)`. The interface is given upstream; the answer quality is not. This is the RFP's graded deliverable and the largest share of the work.
- Operations: observability, key handling, rate limiting, and the licence gate.

The practical consequence: the payment path is mostly integration, and Clara's differentiated value sits almost entirely in the Bazaar.

## Repository layout

```
docs/      13-document planning set (business case through change management)
scripts/   licence-scan.js — CI gate, fails the build on AGPL
src/       service code
test/      node:test suites
```

## Development

```bash
npm ci
npm run verify   # licence gate + typecheck + tests
```

### The licence gate

The RFP excludes AGPL anywhere in the dependency path. That is grant-disqualifying, so `npm run licence` walks the full installed tree — transitive dependencies included — and exits non-zero on any AGPL-family match. It runs in CI on every push, and its own tests assert that it fires, because a control never observed to fail is not a control.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
