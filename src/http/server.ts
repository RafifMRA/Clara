/**
 * The facilitator HTTP surface: /supported, /verify, /settle.
 *
 * Built on node:http rather than a framework, for the same reason the
 * settlement store uses node:sqlite — every dependency here lands in the
 * tree the licence gate scans and the path a third-party audit reviews.
 *
 * Conformance note: the acceptance bar for this work is an *unmodified*
 * canonical x402 client completing a payment end to end. So these handlers
 * return what the x402 specification says, not what would be most convenient
 * for Clara. In particular a payment that is rejected on its merits is a 200
 * carrying `success: false`, not an HTTP error — an HTTP error means the
 * request itself was malformed or Clara could not answer.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { SettlementStore, SettlementRecord } from '../store/settlement-store.ts';
import type { SettlementGuard } from '../settlement-guard.ts';

/** Just the part of x402Facilitator the HTTP layer needs, so tests can fake it. */
export interface FacilitatorPort {
  getSupported(): unknown;
  verify(payload: unknown, requirements: unknown): Promise<{
    isValid: boolean;
    invalidReason?: string | undefined;
    invalidMessage?: string | undefined;
    payer?: string | undefined;
  }>;
}

export interface ServerDeps {
  readonly facilitator: FacilitatorPort;
  readonly guard: SettlementGuard;
  readonly store: SettlementStore;
  /** Bytes; requests larger than this are refused before parsing. */
  readonly maxBodyBytes?: number;
}

interface SettleBody {
  paymentPayload?: unknown;
  paymentRequirements?: unknown;
  x402Version?: number;
}

const DEFAULT_MAX_BODY = 256 * 1024;

export function createFacilitatorServer(deps: ServerDeps): Server {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return createServer((req, res) => {
    handle(req, res, deps, maxBody).catch(error => {
      // A throw escaping a handler is a Clara defect, not a client error.
      // Never leak the message: it can carry internal detail.
      logUnexpected(error);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  maxBody: number
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /healthz':
      return send(res, 200, { status: 'ok' });

    case 'GET /supported':
      return send(res, 200, deps.facilitator.getSupported());

    case 'POST /verify':
      return handleVerify(req, res, deps, maxBody);

    case 'POST /settle':
      return handleSettle(req, res, deps, maxBody);

    default:
      return send(res, 404, { error: 'not_found' });
  }
}

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  maxBody: number
): Promise<void> {
  const body = await readBody(req, res, maxBody);
  if (body === undefined) return;

  const parsed = parseSettleBody(body);
  if ('error' in parsed) return send(res, 400, { error: parsed.error });

  const result = await deps.facilitator.verify(parsed.payload, parsed.requirements);
  // Verification outcomes are 200 either way: an invalid payment is a valid
  // answer to a well-formed question.
  return send(res, 200, result);
}

async function handleSettle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  maxBody: number
): Promise<void> {
  const body = await readBody(req, res, maxBody);
  if (body === undefined) return;

  const parsed = parseSettleBody(body);
  if ('error' in parsed) return send(res, 400, { error: parsed.error });

  const outcome = await deps.guard.settle(
    parsed.payload,
    parsed.requirements,
    networkOf(parsed.requirements)
  );

  switch (outcome.kind) {
    case 'settled':
      return send(res, 200, {
        success: true,
        transaction: outcome.txHash,
        network: networkOf(parsed.requirements) ?? '',
      });

    case 'failed':
      return send(res, 200, {
        success: false,
        errorReason: outcome.code,
        transaction: '',
        network: networkOf(parsed.requirements) ?? '',
      });

    case 'already_processed':
      return replay(res, outcome.record, networkOf(parsed.requirements));

    case 'indeterminate':
      // 202: the payment may have settled. The client must resolve by hash.
      // Returning a failure here would invite exactly the resubmission that
      // causes a double payment.
      return send(res, 202, {
        success: false,
        errorReason: 'settlement_pending',
        errorMessage:
          'Settlement was attempted and its outcome is not yet established. ' +
          'Resolve by transaction hash. Do not resubmit this payment.',
        transaction: deps.store.lookup(outcome.key)?.txHash ?? '',
        network: networkOf(parsed.requirements) ?? '',
      });
  }
}

/**
 * Replays the recorded outcome of a payment that was already decided.
 *
 * A retry receiving the original answer is what makes this endpoint
 * idempotent in the way a canonical client expects: same request, same
 * response, one payment.
 */
function replay(res: ServerResponse, record: SettlementRecord, network: string | undefined): void {
  const net = record.network ?? network ?? '';

  switch (record.state) {
    case 'confirmed':
      return send(res, 200, {
        success: true,
        transaction: record.txHash ?? '',
        network: net,
      });

    case 'failed':
      return send(res, 200, {
        success: false,
        errorReason: record.failureCode ?? 'settlement_failed',
        transaction: '',
        network: net,
      });

    case 'claimed':
      // A concurrent request holds the claim and has not finished. Reporting
      // either success or failure would be a guess.
      return send(res, 202, {
        success: false,
        errorReason: 'settlement_in_progress',
        errorMessage: 'This payment is being settled by a concurrent request. Poll, do not resubmit.',
        transaction: '',
        network: net,
      });

    case 'submitted':
    case 'unknown':
      return send(res, 202, {
        success: false,
        errorReason: 'settlement_pending',
        errorMessage:
          'This payment was already submitted and its outcome is not yet established. ' +
          'Resolve by transaction hash. Do not resubmit.',
        transaction: record.txHash ?? '',
        network: net,
      });
  }
}

function parseSettleBody(
  raw: string
): { payload: unknown; requirements: unknown } | { error: string } {
  let body: SettleBody;
  try {
    body = JSON.parse(raw) as SettleBody;
  } catch {
    return { error: 'invalid_json' };
  }
  if (body === null || typeof body !== 'object') return { error: 'invalid_body' };
  if (body.paymentPayload === undefined) return { error: 'missing_payment_payload' };
  if (body.paymentRequirements === undefined) return { error: 'missing_payment_requirements' };
  return { payload: body.paymentPayload, requirements: body.paymentRequirements };
}

function networkOf(requirements: unknown): string | undefined {
  if (requirements && typeof requirements === 'object' && 'network' in requirements) {
    const n = (requirements as { network?: unknown }).network;
    if (typeof n === 'string') return n;
  }
  return undefined;
}

/**
 * Reads a request body with a hard size ceiling.
 *
 * Returns undefined when it has already answered the request, so callers
 * stop rather than writing a second response.
 */
async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      send(res, 413, { error: 'payload_too_large' });
      req.destroy();
      return undefined;
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function logUnexpected(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: 'error', event: 'unhandled_request_error', message }));
}
