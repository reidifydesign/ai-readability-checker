#!/usr/bin/env node
/**
 * ai-readability-checker <url>
 *
 * Exits 1 if anything failed, so it works in CI. Warnings do not fail the run:
 * a warning is a judgement call and a build should not break on one.
 */
import { check } from '../src/check.js';

const MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
const COLOUR = { pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', info: '\x1b[90m' };
const RESET = '\x1b[0m';
const colour = process.stdout.isTTY && !process.env.NO_COLOR;

const url = process.argv[2];
if (!url || url === '--help' || url === '-h') {
  console.log(`
  ai-readability-checker <url>

  Reads a page the way a crawler that does not run JavaScript does,
  and reports what it finds. No score out of 100, no rendering.

    npx ai-readability-checker example.com
    npx ai-readability-checker https://example.com/pricing --json

  Exits 1 if any check fails.
`);
  process.exit(url ? 0 : 1);
}

const asJson = process.argv.includes('--json');

try {
  const result = await check(url);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const tally = { pass: 0, warn: 0, fail: 0, info: 0 };
    console.log(`\n  ${result.url}\n`);
    for (const f of result.findings) {
      tally[f.status] = (tally[f.status] || 0) + 1;
      const tag = colour ? `${COLOUR[f.status]}${MARK[f.status]}${RESET}` : MARK[f.status];
      console.log(`  ${tag}  ${f.label}`);
      console.log(`        ${f.detail}\n`);
    }
    console.log(`  ${tally.fail} failing, ${tally.warn} warning, ${tally.pass} passing\n`);
    if (tally.fail === 0 && tally.warn === 0) {
      console.log('  Nothing blocking. That is rare.\n');
    }
  }
  process.exit(result.findings.some((f) => f.status === 'fail') ? 1 : 0);
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
