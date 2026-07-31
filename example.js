// Minimal runnable example: node example.js [url]
import handler from './src/check.js';

const target = process.argv[2] ?? 'example.com';

const res = await handler(
  new Request('https://local/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: target }),
  }),
  { ip: 'cli' }
);

const data = await res.json();
if (data.error) {
  console.error(data.error);
  process.exit(1);
}

console.log(`\n${data.title || data.url}`);
console.log(
  `${data.counts.pass} readable  ${data.counts.warn} worth fixing  ${data.counts.fail} missing\n`
);
for (const f of [...data.page, ...data.site]) {
  const mark = { pass: 'OK  ', warn: 'FIX ', fail: 'MISS', info: 'note' }[f.status];
  console.log(`  ${mark} ${f.label}: ${f.detail}`);
}
