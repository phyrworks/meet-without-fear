// Runs healthcheck.cjs for real. Needs a reachable Postgres and the `pg` package:
//   HEALTHCHECK_TEST_DATABASE_URL=postgres://... node infra/aws/healthcheck.test.cjs
// (falls back to DATABASE_URL; skips with exit 0 if neither is set). Only SELECT 1 is run.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const script = path.join(__dirname, 'healthcheck.cjs');
const dbUrl = process.env.HEALTHCHECK_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) { console.log('healthcheck test skipped: no database URL'); process.exit(0); }

function run(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

function serve(status) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => { res.statusCode = status; res.end('{}'); });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/health` }));
  });
}

(async () => {
  const ok = await serve(200);
  const bad = await serve(503);
  try {
    let r = await run({ HEALTHCHECK_URL: ok.url, DATABASE_URL: dbUrl });
    assert.equal(r.code, 0, 'healthy HTTP + reachable DB -> exit 0');
    assert.ok(!r.out.includes(dbUrl), 'must not print connection details');

    r = await run({ HEALTHCHECK_URL: ok.url, APP_DATABASE_URL: dbUrl, DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' });
    assert.equal(r.code, 0, 'APP_DATABASE_URL takes precedence over DATABASE_URL');

    r = await run({ HEALTHCHECK_URL: ok.url, DATABASE_URL: 'postgres://u:secretpw@127.0.0.1:1/none' });
    assert.equal(r.code, 1, 'unreachable DB -> exit 1');
    assert.ok(!r.out.includes('secretpw'), 'must not print connection details');

    r = await run({ HEALTHCHECK_URL: bad.url, DATABASE_URL: dbUrl });
    assert.equal(r.code, 1, 'HTTP 503 -> exit 1');

    r = await run({ HEALTHCHECK_URL: 'http://127.0.0.1:1/health', DATABASE_URL: dbUrl });
    assert.equal(r.code, 1, 'HTTP unreachable -> exit 1');

    console.log('healthcheck.cjs checks passed');
  } finally {
    ok.server.close(); bad.server.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
