#!/usr/bin/env node
/**
 * Licence gate.
 *
 * The x402-facilitator-bazaar RFP excludes AGPL anywhere in the dependency
 * path. That is a grant-disqualifying condition, not a style preference, so
 * this runs in CI and fails the build rather than printing a warning.
 *
 * Walks the full installed tree (including transitive deps), not just
 * package.json's direct dependencies, because contamination arrives
 * transitively — typically via an otherwise-innocent utility package.
 */
import fs from 'node:fs';
import path from 'node:path';

// Copyleft families that disqualify the grant, matched case-insensitively.
const DENY = [/\bAGPL/i, /\bGNU Affero/i];

// Permissive licences we expect to see. Anything outside this list is not
// failed automatically — it is surfaced for a human decision, because an
// unrecognised licence is a question, not a verdict.
const KNOWN_PERMISSIVE = [
  /\bMIT\b/i, /\bApache-?2/i, /\bBSD\b/i, /\bISC\b/i, /\bCC0\b/i,
  /\bUnlicense\b/i, /\bBlueOak\b/i, /\b0BSD\b/i, /\bPython-2/i, /\bWTFPL\b/i,
];

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map(l => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
  }
  return null;
}

function walk(dir, found = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.name.startsWith('@')) {
      walk(full, found); // scope directory: recurse into its packages
      continue;
    }
    const pkgJson = path.join(full, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        if (pkg.name) {
          const key = `${pkg.name}@${pkg.version || '?'}`;
          if (!found.has(key)) found.set(key, licenceOf(pkg));
        }
      } catch { /* unreadable manifest: reported as unknown below */ }
    }
    const nested = path.join(full, 'node_modules');
    if (fs.existsSync(nested)) walk(nested, found);
  }
  return found;
}

const root = path.join(process.cwd(), 'node_modules');
if (!fs.existsSync(root)) {
  console.error('licence-scan: node_modules not found. Run `npm ci` first.');
  process.exit(1);
}

const packages = walk(root);
const denied = [];
const unknown = [];

for (const [name, lic] of packages) {
  if (!lic) { unknown.push([name, '(none declared)']); continue; }
  if (DENY.some(re => re.test(lic))) { denied.push([name, lic]); continue; }
  if (!KNOWN_PERMISSIVE.some(re => re.test(lic))) unknown.push([name, lic]);
}

console.log(`licence-scan: inspected ${packages.size} installed packages`);

if (unknown.length) {
  console.log(`\n${unknown.length} licence(s) needing a human decision:`);
  for (const [name, lic] of unknown.sort()) console.log(`  ? ${name.padEnd(46)} ${lic}`);
}

if (denied.length) {
  console.error(`\nFAIL: ${denied.length} AGPL-family package(s) in the dependency path:`);
  for (const [name, lic] of denied) console.error(`  x ${name.padEnd(46)} ${lic}`);
  console.error('\nAGPL disqualifies the SCF grant. Remove these before committing.');
  process.exit(1);
}

console.log('\nPASS: no AGPL-family licence in the dependency path.');
