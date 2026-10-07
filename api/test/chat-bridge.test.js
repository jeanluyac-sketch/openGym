/* fork(claude-chat) — the Claude chat connector end to end, against the real server.js in a
   child: discovery, dynamic registration, the consent page, PKCE, the token endpoint with
   rotation and reuse detection, the MCP endpoint and its tools, and the proposal landing in
   the same place the Coach's own proposals do. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, sampleState } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'https://gym.example.test';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const UID = 'u_chat_1';

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
// ORIGIN is https, so the server names its cookie __Host-gymsid; it still accepts the legacy name.
const cookie = (uid = UID, sv = 0) => `__Host-gymsid=${mintSession(uid, sv)}`;

async function startServer(t, { coach = true, provider = 'fixture', env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-chat-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: UID, name: 'Jean', created: new Date().toISOString() }, { id: 'u_other', name: 'Other', created: new Date().toISOString() }],
    creds: [], subs: [], invites: []
  }));
  fs.writeFileSync(path.join(dataDir, `state-${UID}.json`), JSON.stringify(sampleState({ lang: 'pt-BR' })));
  if (coach) fs.writeFileSync(path.join(dataDir, 'coach.json'), JSON.stringify({ enabled: true, provider }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'gym.example.test', AUDIT_LOG: '1', ...env }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  return h;
}

const form = obj => new URLSearchParams(obj).toString();
const hiddenFields = html => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
  .map(m => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')]));
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

/** Register, consent, exchange: the whole connector handshake. Returns tokens + client id. */
async function connect(h, { sv = 0 } = {}) {
  const reg = await fetch(`${h.api}/api/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' })
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-123', scope: 'coach offline_access', resource: ORIGIN + '/api/mcp'
  });
  const page = await fetch(`${h.api}/api/oauth/authorize?${q}`, { headers: { Cookie: cookie(UID, sv), 'Accept-Language': 'pt-BR' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Permitir que o Claude acesse seu treino/);
  const fields = hiddenFields(html);
  const allow = await fetch(`${h.api}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie(UID, sv), 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: form({ ...fields, decision: 'allow' })
  });
  assert.equal(allow.status, 302);
  const loc = new URL(allow.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, CALLBACK);
  assert.equal(loc.searchParams.get('state'), 'st-123');
  assert.equal(loc.searchParams.get('iss'), ORIGIN);
  const code = loc.searchParams.get('code');
  const tok = await fetch(`${h.api}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: ORIGIN + '/api/mcp' })
  });
  assert.equal(tok.status, 200, await tok.clone().text());
  const tokens = await tok.json();
  return { client, tokens, code, verifier };
}

let rpcId = 0;
async function rpc(h, token, method, params) {
  const r = await fetch(`${h.api}/api/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) })
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text(), headers: r.headers };
}
const toolJson = r => JSON.parse(r.body.result.content[0].text);

test('discovery: metadata documents and the 401 that points at them', async t => {
  const h = await startServer(t);
  const as = await (await fetch(`${h.api}/api/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, ORIGIN);
  assert.equal(as.token_endpoint, ORIGIN + '/api/oauth/token');
  assert.equal(as.registration_endpoint, ORIGIN + '/api/oauth/register');
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  for (const p of ['/api/.well-known/oauth-protected-resource', '/api/.well-known/oauth-protected-resource/api/mcp']) {
    const pr = await (await fetch(h.api + p)).json();
    assert.equal(pr.resource, ORIGIN + '/api/mcp');
    assert.deepEqual(pr.authorization_servers, [ORIGIN]);
  }
  const r = await fetch(`${h.api}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer resource_metadata="https:\/\/gym\.example\.test\/api\/\.well-known\/oauth-protected-resource"/);
  // A session cookie is not a way in: the MCP endpoint takes connector tokens only.
  const c = await fetch(`${h.api}/api/mcp`, { method: 'POST', headers: { Cookie: cookie(), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(c.status, 401);
});

test('registration accepts Claude\'s callbacks and loopback, refuses anything else', async t => {
  const h = await startServer(t);
  const reg = uris => fetch(`${h.api}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: uris }) });
  assert.equal((await reg(['https://claude.ai/api/mcp/auth_callback'])).status, 201);
  assert.equal((await reg(['https://claude.com/api/mcp/auth_callback'])).status, 201);
  assert.equal((await reg(['http://localhost:51234/callback'])).status, 201);
  const bad = await reg(['https://evil.example/cb']);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_redirect_uri');
  assert.equal((await reg([])).status, 400);
});

test('authorize: unknown client and unregistered redirect are pages, never redirects; no session asks to sign in', async t => {
  const h = await startServer(t);
  const { challenge } = pkce();
  const base = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: CALLBACK, state: 's' };
  const r1 = await fetch(`${h.api}/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'nope' })}`, { redirect: 'manual', headers: { Cookie: cookie() } });
  assert.equal(r1.status, 400);
  const client = await (await fetch(`${h.api}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).json();
  const r2 = await fetch(`${h.api}/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })}`, { redirect: 'manual', headers: { Cookie: cookie() } });
  assert.equal(r2.status, 400, 'a redirect URI the client did not register');
  // PKCE missing: the client is told, through its own redirect.
  const r3 = await fetch(`${h.api}/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id, code_challenge: '' })}`, { redirect: 'manual', headers: { Cookie: cookie() } });
  assert.equal(r3.status, 302);
  assert.equal(new URL(r3.headers.get('location')).searchParams.get('error'), 'invalid_request');
  // Signed out: the page asks for a sign-in and offers to come back.
  const r4 = await fetch(`${h.api}/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id })}`, { headers: { 'Accept-Language': 'en' } });
  assert.equal(r4.status, 200);
  assert.match(await r4.text(), /Sign in to openGym first/);
  // A consent POST from another site is refused by the server's own CSRF gate.
  const r5 = await fetch(`${h.api}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
    body: form({ client_id: client.client_id, decision: 'allow' })
  });
  assert.equal(r5.status, 403);
  // A consent POST whose form was made for somebody else (or tampered) is refused.
  const page = await (await fetch(`${h.api}/api/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id })}`, { headers: { Cookie: cookie() } })).text();
  const fields = hiddenFields(page);
  const r6 = await fetch(`${h.api}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie('u_other'), 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: form({ ...fields, decision: 'allow' })
  });
  assert.equal(r6.status, 400);
  // Deny goes back to Claude with access_denied.
  const r7 = await fetch(`${h.api}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: form({ ...fields, decision: 'deny' })
  });
  assert.equal(r7.status, 302);
  assert.equal(new URL(r7.headers.get('location')).searchParams.get('error'), 'access_denied');
});

test('token endpoint: PKCE, one-use codes, rotation and reuse detection', async t => {
  const h = await startServer(t, { env: { CHAT_BRIDGE_REUSE_GRACE_MS: '0' } });
  const { client, tokens, code, verifier } = await connect(h);
  assert.match(tokens.access_token, /^ogm_at_/);
  assert.match(tokens.refresh_token, /^ogm_rt_/);
  assert.equal(tokens.token_type, 'Bearer');
  // The code is spent, and using it again revokes what it produced (RFC 6749 §4.1.2).
  const again = await fetch(`${h.api}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier })
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, 'invalid_grant');
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401, 'the replayed code took its grant with it');
  const second = await connect(h);
  tokens.access_token = second.tokens.access_token; tokens.refresh_token = second.tokens.refresh_token;
  client.client_id = second.client.client_id;
  // Nothing is stored in clear.
  const stored = fs.readFileSync(path.join(h.dataDir, 'oauth.json'), 'utf8');
  assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token));
  assert.equal(fs.statSync(path.join(h.dataDir, 'oauth.json')).mode & 0o777, 0o600);

  const refresh = rt => fetch(`${h.api}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id })
  });
  const r1 = await refresh(tokens.refresh_token);
  assert.equal(r1.status, 200);
  const t2 = await r1.json();
  assert.notEqual(t2.refresh_token, tokens.refresh_token);
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401, 'the rotated-away access token is dead');
  assert.equal((await rpc(h, t2.access_token, 'ping')).status, 200);
  // The old refresh token comes back: the whole grant goes.
  const r2 = await refresh(tokens.refresh_token);
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, 'invalid_grant');
  assert.equal((await rpc(h, t2.access_token, 'ping')).status, 401);
  assert.equal((await refresh(t2.refresh_token)).status, 400);
});

test('MCP: initialize, tools, a proposal that lands where the Coach shows it', async t => {
  const h = await startServer(t);
  const { tokens } = await connect(h);
  const at = tokens.access_token;

  const init = await rpc(h, at, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  const note = await fetch(`${h.api}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  assert.equal(note.status, 202);
  const odd = await rpc(h, at, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(odd.body.result.protocolVersion, '2025-11-25');

  const list = await rpc(h, at, 'tools/list');
  const names = list.body.result.tools.map(x => x.name);
  assert.deepEqual(names, ['get_coach_context', 'search_exercises', 'propose_plan', 'propose_changes', 'get_proposal_status']);

  const ctx = toolJson(await rpc(h, at, 'tools/call', { name: 'get_coach_context', arguments: { task: 'create' } }));
  assert.equal(ctx.task, 'create');
  assert.equal(ctx.coachEnabled, true);
  assert.match(ctx.rules, /Every exercise you name must come from the `library`/);
  assert.match(ctx.rules, /through the chat connector/);
  assert.equal(ctx.payload.coachProfile.daysPerWeek, 3);
  assert.equal(ctx.payload.meta.lang, 'pt-BR');
  assert.ok(ctx.payload.library.length > 20);
  assert.ok(!JSON.stringify(ctx).includes(UID), 'the payload carries a handle, never the uid');

  const found = toolJson(await rpc(h, at, 'tools/call', { name: 'search_exercises', arguments: { query: 'bench press', equipment: 'barbell', limit: 5 } }));
  assert.ok(found.count >= 1 && found.results.every(r => /bench press/.test(r.name) && r.equipment === 'barbell'));

  const ids = ctx.payload.library.filter(e => !e.custom).slice(0, 6).map(e => e.id);
  const ex = id => ({ id, sets: 3, mode: 'reps', reps: 10, prog: 'linear', why: 'base' });
  const plan = {
    coach_contract: 1, opengym_plan: 1, name: 'Plano do Claude', summary: 'Três dias de corpo inteiro.', basedOn: 'perfil',
    week: { 1: 'a', 3: 'b', 5: 'a' },
    routines: [
      { id: 'a', name: 'Treino A', emoji: 'dumbbell', prog: 'linear', why: 'A', ex: ids.slice(0, 3).map(ex) },
      { id: 'b', name: 'Treino B', emoji: 'barbell', prog: 'linear', why: 'B', ex: ids.slice(3, 6).map(ex) }
    ],
    customEx: []
  };

  // An invented id: refused, nothing sent, the errors come back to fix.
  const bad = await rpc(h, at, 'tools/call', { name: 'propose_plan', arguments: { plan: { ...plan, routines: [{ ...plan.routines[0], ex: [ex('9999999')] }, plan.routines[1]] } } });
  assert.equal(bad.body.result.isError, true);
  assert.match(toolJson(bad).errors.join('\n'), /9999999/);
  const twoDays = await rpc(h, at, 'tools/call', { name: 'propose_plan', arguments: { plan: { ...plan, week: { 1: 'a', 3: 'b' } } } });
  assert.equal(twoDays.body.result.isError, true, 'the profile asked for three days');

  const sent = await rpc(h, at, 'tools/call', { name: 'propose_plan', arguments: { plan } });
  assert.ok(!sent.body.result.isError, sent.body.result.content[0].text);
  const res = toolJson(sent);
  assert.equal(res.sent, true);
  assert.equal(res.days, 3);

  // The app's own status route now shows it as the pending proposal.
  const st = await (await fetch(`${h.api}/api/coach/status`, { headers: { Cookie: cookie() } })).json();
  assert.equal(st.pending.id, res.proposalId);
  assert.equal(st.pending.kind, 'create');
  assert.equal(st.pending.source, 'claude-chat');
  assert.equal(st.pending.bundle.routines.length, 2);
  assert.match(st.pending.planHash, /^[0-9a-f]{16}$/);

  // A second proposal replaces it, and the first is recorded as superseded.
  const sent2 = toolJson(await rpc(h, at, 'tools/call', { name: 'propose_plan', arguments: { plan: { ...plan, name: 'Plano 2' } } }));
  const status = toolJson(await rpc(h, at, 'tools/call', { name: 'get_proposal_status', arguments: {} }));
  assert.equal(status.pending.id, sent2.proposalId);
  assert.equal(status.pending.source, 'claude-chat');
  assert.ok(status.recent.some(x => x.outcome === 'superseded'));

  // Review changes against the current plan: a rep change on the routine that exists.
  const review = {
    coach_contract: 1, summary: 'Mais repetições no primeiro exercício.', evidence: { from: '2026-07-01', to: '2026-07-20' },
    changes: [{ id: 'c1', type: 'reps', target: { routineId: 'r1', exId: '0001' }, before: 10, after: 12, why: 'Fechou as séries com folga.' }]
  };
  const rv = await rpc(h, at, 'tools/call', { name: 'propose_changes', arguments: { review } });
  const rvBody = toolJson(rv);
  if (rv.body.result.isError) assert.fail('review refused: ' + JSON.stringify(rvBody.errors));
  assert.equal(rvBody.kind, 'review');

  // Unknown tool and unknown method.
  assert.equal((await rpc(h, at, 'tools/call', { name: 'drop_tables' })).body.error.code, -32602);
  assert.equal((await rpc(h, at, 'resources/read', {})).body.error.code, -32601);
  // GET is not a stream here.
  assert.equal((await fetch(`${h.api}/api/mcp`, { headers: { Authorization: `Bearer ${at}` } })).status, 405);
});

test('with the Coach off, proposals are refused with what to do; reading still works', async t => {
  const h = await startServer(t, { coach: false });
  const { tokens } = await connect(h);
  const ctx = toolJson(await rpc(h, tokens.access_token, 'tools/call', { name: 'get_coach_context', arguments: {} }));
  assert.equal(ctx.coachEnabled, false);
  assert.match(ctx.warning, /Admin dashboard/);
  const r = await rpc(h, tokens.access_token, 'tools/call', { name: 'propose_plan', arguments: { plan: {} } });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /Coach is switched off/);
});

test('"sign out everywhere" and the connections page both end a connection', async t => {
  const h = await startServer(t);
  const { tokens } = await connect(h);
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 200);
  const out = await fetch(`${h.api}/api/logout/all`, { method: 'POST', headers: { Cookie: cookie(), 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(out.status, 200);
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401, 'the grant was made for session version 0');

  // Connect again as version 1, then revoke from the connections page.
  const second = await connect(h, { sv: 1 });
  const page = await fetch(`${h.api}/api/oauth/connections`, { headers: { Cookie: cookie(UID, 1), 'Accept-Language': 'pt-BR' } });
  const html = await page.text();
  assert.match(html, /Conexões do Claude/);
  const forms = [...html.matchAll(/<form class="inline"[^>]*>(.*?)<\/form>/g)].map(m => hiddenFields(m[1]));
  assert.ok(forms.length >= 1);
  const rv = await fetch(`${h.api}/api/oauth/connections/revoke`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie(UID, 1), 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
    body: form({ grant: forms[0].grant, csrf: forms[0].csrf })   // newest first
  });
  assert.equal(rv.status, 303);
  assert.equal((await rpc(h, second.tokens.access_token, 'ping')).status, 401);
  // RFC 7009 revocation answers 200 whatever the token was.
  assert.equal((await fetch(`${h.api}/api/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ token: 'nonsense' }) })).status, 200);
  assert.match(fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8'), /"ev":"oauth\.grant"/);
});

test('a refresh retried right after rotation is refused without ending the connection', async t => {
  const h = await startServer(t);
  const { client, tokens } = await connect(h);
  const refresh = rt => fetch(`${h.api}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id })
  });
  const t2 = await (await refresh(tokens.refresh_token)).json();
  const retry = await refresh(tokens.refresh_token);
  assert.equal(retry.status, 400);
  assert.equal((await retry.json()).error, 'invalid_grant');
  assert.equal((await rpc(h, t2.access_token, 'ping')).status, 200, 'the grant survives a lost-answer retry');
  // Notifications never run anything: a tools/call without an id is ignored.
  const r = await fetch(`${h.api}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t2.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'propose_plan', arguments: { plan: {} } } }) });
  assert.equal(r.status, 202);
  // An impossible loopback port is refused at registration instead of a 500 later.
  const bad = await fetch(`${h.api}/api/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:99999/callback'] }) });
  assert.equal(bad.status, 400);
});

test('provider "Claude (chat)": the Coach is on with no model; in-app jobs point to the chat, chat proposals land', async t => {
  const h = await startServer(t, { provider: 'claude-chat' });
  const cfg = await (await fetch(`${h.api}/api/config`, { headers: { Cookie: cookie() } })).json();
  assert.ok(cfg.coach, 'the Coach UI exists on this instance');
  const job = await fetch(`${h.api}/api/coach/plan`, { method: 'POST', headers: { Cookie: cookie(), 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' });
  assert.equal(job.status, 400);
  const body = await job.json();
  assert.equal(body.code, 'chat');
  assert.match(body.error, /chat do Claude/);
  const { tokens } = await connect(h);
  const ctx = toolJson(await rpc(h, tokens.access_token, 'tools/call', { name: 'get_coach_context', arguments: {} }));
  assert.equal(ctx.coachEnabled, true);
  const st = await (await fetch(`${h.api}/api/coach/status`, { headers: { Cookie: cookie() } })).json();
  assert.equal(st.pending, null);
});

test('a plan carries each exercise\'s own rest, clamped to the picker\'s range', async () => {
  const { validatePlan } = await import('../coach/core/validate.js');
  const plan = { week: { 1: 'a' }, routines: [{ id: 'a', name: 'A', ex: [
    { id: '0025', sets: 3, mode: 'reps', reps: 8, restSec: 180 },
    { id: '0031', sets: 3, mode: 'reps', reps: 12, restSec: 5 },
    { id: '0043', sets: 3, mode: 'reps', reps: 8, restSec: 90.5 }
  ] }] };
  const v = validatePlan(plan, {});
  assert.ok(v.ok);
  assert.deepEqual(v.bundle.routines[0].ex.map(e => e.restSec), [180, undefined, undefined]);
});
