// Local-replica smoke (infra/local/smoke.sh runs it). The production smoke,
// infra/aws/smoke.cjs, needs a Clerk token, real Ably and asserts the E2E
// bypass is REJECTED; on the replica the bypass is on by design, so this
// variant checks the same layers through the one local origin instead:
// health, the web export, auth (none / bad bypass / bypass), the E2E seeder,
// reads as both partners, an SSE message turn with the mocked AI and its
// persistence, the /realtime WebSocket upgrade, and E2E cleanup.
// Prints one JSON line per check; the last line carries the ids smoke.sh needs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const base = process.env.MWF_LOCAL_ORIGIN || 'http://127.0.0.1:18180';
const tag = crypto.randomBytes(4).toString('hex');
const user = (n) => ({ email: `smoke-${n}-${tag}@e2e.test`, name: `Smoke ${n.toUpperCase()}` });
const ok = (check, extra = {}) => console.log(JSON.stringify({ check, ok: true, ...extra }));

async function req(path, { as, body, method } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as) Object.assign(headers, { 'x-e2e-user-id': as.id, 'x-e2e-user-email': as.email });
  const r = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'), headers,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}

(async () => {
  const health = await req('/health');
  assert.equal(health.status, 200, 'GET /health');
  ok('health');

  const page = await fetch(base + '/session/anything').then(async (r) => ({ status: r.status, html: await r.text() }));
  assert.equal(page.status, 200, 'SPA fallback');
  assert.match(page.html, /<div id="root">/, 'web export index.html');
  const bundle = page.html.match(/src="(\/_expo\/static\/js\/web\/[^"]+\.js)"/);
  assert.ok(bundle, 'bundle script tag');
  const js = await fetch(base + bundle[1]).then((r) => r.text());
  assert.ok(js.includes(base), `bundle targets ${base}`);
  ok('web-export', { bundle: bundle[1] });

  // No Clerk on the replica: a request with neither bypass headers nor a
  // token fails closed with 500 "Authentication not configured" (production,
  // with CLERK_SECRET_KEY, answers 401). Either way it must not succeed.
  const anon = await req('/api/auth/me');
  assert.ok(anon.status === 401 || (anon.status === 500 && /Authentication not configured/.test(JSON.stringify(anon.data))),
    `no credentials must be refused: ${anon.status} ${JSON.stringify(anon.data)}`);
  const bad = await req('/api/auth/me', { as: { id: 'not-a-uuid', email: 'x@e2e.test' } });
  assert.equal(bad.status, 401, 'non-uuid bypass id → 401');
  ok('auth-rejections');

  const seeded = await req('/api/e2e/seed-session', { body: { userA: user('a'), userB: user('b'), targetStage: 'EMPATHY_SHARED_A' } });
  assert.equal(seeded.status, 201, `seed-session: ${JSON.stringify(seeded.data).slice(0, 300)}`);
  const s = seeded.data.data;
  ok('seed-session', { sessionId: s.session.id });

  const listA = await req('/api/sessions', { as: s.userA });
  assert.equal(listA.status, 200);
  assert.ok(JSON.stringify(listA.data).includes(s.session.id), 'A lists the seeded session');
  const stateB = await req(`/api/sessions/${s.session.id}/state`, { as: s.userB });
  assert.equal(stateB.status, 200, `B reads state: ${JSON.stringify(stateB.data).slice(0, 300)}`);
  ok('reads-as-both-partners');

  // A message turn on a fresh session of A's own (as the production smoke does).
  const solo = { id: crypto.randomUUID(), email: `smoke-solo-${tag}@e2e.test` };
  const created = await req('/api/sessions', { as: solo, body: { inviteName: 'Local smoke (unshared)', forceCreate: true } });
  assert.ok(created.status === 200 || created.status === 201, `create session: ${created.status} ${JSON.stringify(created.data).slice(0, 300)}`);
  const sid = created.data.data.session.id;
  const content = `Local replica smoke ${tag}: I feel a little nervous about a familiar routine changing.`;
  const t0 = Date.now();
  const r = await fetch(`${base}/api/sessions/${sid}/messages/stream`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', 'x-e2e-user-id': solo.id, 'x-e2e-user-email': solo.email },
    body: JSON.stringify({ content }),
  });
  assert.equal(r.status, 200, 'stream status');
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  let sse = ''; let chunks = 0; let first = null;
  for await (const c of r.body) { first ??= Date.now() - t0; chunks++; sse += Buffer.from(c).toString(); }
  const events = [...sse.matchAll(/^event:\s*(.+)$/gm)].map((m) => m[1]);
  assert.ok(!events.includes('error'), `SSE error event: ${sse.slice(0, 400)}`);
  assert.ok(events.length > 0, 'SSE events');
  const history = await req(`/api/sessions/${sid}/messages`, { as: solo });
  assert.equal(history.status, 200);
  assert.ok(JSON.stringify(history.data).includes(content), 'user message persists and reads back decrypted');
  ok('sse-turn', { chunks, firstChunkMs: first, totalMs: Date.now() - t0, events: [...new Set(events)] });

  const close = await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/realtime');
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS timeout')); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'invalid' })));
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
    ws.on('error', reject);
  });
  assert.equal(close, 1008, 'WebSocket upgrade through Caddy, invalid auth closed 1008');
  ok('realtime-websocket', { close });

  // Hand the plaintext marker to smoke.sh (it checks the column at rest), then clean up there.
  console.log(JSON.stringify({ check: 'done', ok: true, tag, soloSessionId: sid, marker: `Local replica smoke ${tag}` }));
})().catch((e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
