/**
 * The licence gate is a grant-critical control: AGPL anywhere in the
 * dependency path disqualifies the SCF submission. A gate that has never
 * been observed to fire is not a control, so this asserts both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(here, '..', 'scripts', 'licence-scan.js');
const FIXTURE = path.join(here, '..', 'node_modules', '__agpl_gate_fixture__');

function runScan() {
  try {
    return { code: 0, out: execFileSync('node', [SCAN], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function withFixtureLicence(licence, fn) {
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURE, 'package.json'),
    JSON.stringify({ name: '__agpl_gate_fixture__', version: '0.0.0', license: licence })
  );
  try {
    return fn();
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true });
  }
}

test('passes on the real dependency tree', () => {
  const { code, out } = runScan();
  assert.strictEqual(code, 0, `expected clean tree to pass:\n${out}`);
  assert.match(out, /no AGPL-family licence/);
});

test('fails when an AGPL package is present transitively', () => {
  withFixtureLicence('AGPL-3.0', () => {
    const { code, out } = runScan();
    assert.strictEqual(code, 1, 'gate must exit non-zero on AGPL');
    assert.match(out, /__agpl_gate_fixture__/);
  });
});

test('detects the GNU Affero spelling as well as the acronym', () => {
  withFixtureLicence('GNU Affero General Public License v3', () => {
    const { code } = runScan();
    assert.strictEqual(code, 1, 'gate must match the spelled-out Affero name');
  });
});

test('surfaces an undeclared licence without failing the build', () => {
  withFixtureLicence(undefined, () => {
    const { code, out } = runScan();
    assert.strictEqual(code, 0, 'an unknown licence is a question, not a verdict');
    assert.match(out, /needing a human decision/);
  });
});
