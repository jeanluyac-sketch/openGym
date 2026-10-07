/* fork(claude-chat) — a small OAuth 2.1 authorization server, just enough for Claude's custom
 * connectors (https://claude.com/docs/connectors/building/authentication):
 *
 *   - RFC 8414 metadata and RFC 9728 protected-resource metadata
 *   - RFC 7591 Dynamic Client Registration, public clients only (no secrets exist here)
 *   - authorization code + PKCE S256, nothing else: no implicit, no password, no client
 *     credentials grant
 *   - refresh tokens that rotate on every use, with reuse detection (an old refresh token
 *     coming back revokes the whole grant)
 *
 * The person proves who they are with the session openGym already has: the consent page reads
 * the same signed cookie the app uses, so a passkey or a password sign-in is the login, and
 * this module never sees a credential. A grant is bound to the session version (`sv`) of the
 * profile it was made for, so "sign out everywhere" in the app revokes Claude too.
 *
 * Tokens are opaque random strings; only their SHA-256 is stored (store.js). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWindow } from '../../rate-limit.js';
import { createStore, sha256, randomToken } from './store.js';
import { langOf, strings, sendHtml, errorPage, signInPage, consentPage, connectionsPage } from './pages.js';

export const SCOPE = 'coach';
const ACCESS_TTL_S = Math.max(300, +(process.env.CHAT_BRIDGE_ACCESS_TTL || 3600) || 3600);
const REFRESH_TTL_MS = Math.max(1, +(process.env.CHAT_BRIDGE_REFRESH_DAYS || 60) || 60) * 86400000;
const CODE_TTL_MS = 5 * 60 * 1000;
const CONSENT_TTL_MS = 15 * 60 * 1000;
const MAX_FORM = 64 * 1024;

// Where Claude's hosted surfaces send the browser back to (claude.ai today, claude.com
// announced). Anything else must be listed in CHAT_BRIDGE_REDIRECTS, exactly.
export const DEFAULT_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
// Claude Code uses an RFC 8252 loopback redirect on an ephemeral port: allowed with the port
// ignored, and the consent page says so in a warning. CHAT_BRIDGE_LOOPBACK=0 turns it off.
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
const isLoopback = u => {
  if (!LOOPBACK.test(u)) return false;
  try { const p = new URL(u).port; return !p || (+p >= 1 && +p <= 65535); } catch { return false; }
};
const loopbackKey = u => { const m = LOOPBACK.exec(u); return m ? `${m[1]}${m[3] || '/'}` : null; };

const b64urlSha256 = v => crypto.createHash('sha256').update(v).digest('base64url');
const str = (v, max = 2048) => (typeof v === 'string' ? v.slice(0, max) : '');
const enabledFlag = v => !/^(0|false|no|off)$/i.test(String(v || ''));

/** x-www-form-urlencoded (what /token, /revoke and the consent form send) or JSON. */
export function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_FORM) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (type.includes('application/json')) {
        try {
          const v = raw ? JSON.parse(raw) : {};
          return resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch { return reject(Object.assign(new Error('invalid json'), { status: 400 })); }
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on('error', reject);
  });
}

export function createOAuth({ dataDir, origin, readSession, findUser, audit = () => {}, now = Date.now, env = process.env }) {
  const ORIGIN = String(origin).replace(/\/+$/, '');
  const MCP_URL = ORIGIN + '/api/mcp';
  const store = createStore(dataDir, { now });
  store.pruneUsers(uid => !!findUser(uid));   // profiles deleted since the last boot (no residue)
  const extraRedirects = String(env.CHAT_BRIDGE_REDIRECTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowLoopback = enabledFlag(env.CHAT_BRIDGE_LOOPBACK);
  // How long after a rotation the old refresh token is treated as a lost answer being retried.
  const REUSE_GRACE_MS = env.CHAT_BRIDGE_REUSE_GRACE_MS != null ? Math.max(0, +env.CHAT_BRIDGE_REUSE_GRACE_MS || 0) : 60000;

  // A key of its own for the consent and connections forms, derived from the instance secret
  // (the same way the Coach derives its encryption key) so it rotates with it.
  const secret = fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim();
  const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('opengym-chat-bridge-v1'), 32));
  const mac = parts => crypto.createHmac('sha256', KEY).update(parts.map(p => String(p ?? '')).join('\n')).digest('base64url');
  const macOk = (a, b) => { try { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; } };

  const codes = new Map();   // sha256(code) -> { clientId, uid, sv, redirectUri, challenge, resource, scope, exp }
  setInterval(() => { const t = now(); for (const [k, v] of codes) if (v.exp < t) codes.delete(k); }, 60000).unref();

  // Behind the bundled proxies every request arrives from the same address, so these are
  // instance-wide ceilings, not per-caller limits. Registration only ever blocks *new*
  // connections (and MAX_CLIENTS bounds what it can store). The token endpoint counts failures
  // only: a valid code or refresh token is never refused for somebody else's noise, and the
  // tokens are 256 random bits, so failures buy an attacker nothing but CPU.
  const REGISTER_BUDGET = createWindow({ max: 120, windowMs: 3600000 });
  const TOKEN_FAILS = createWindow({ max: 600, windowMs: 60000 });

  const redirectAllowed = u => DEFAULT_REDIRECTS.includes(u) || extraRedirects.includes(u) || (allowLoopback && isLoopback(u));
  const redirectRegistered = (client, u) => client.redirectUris.some(r =>
    r === u || (isLoopback(r) && isLoopback(u) && loopbackKey(r) === loopbackKey(u)));
  const resourceOk = r => !r || r === MCP_URL || r === MCP_URL + '/' || r === ORIGIN || r === ORIGIN + '/';
  const userOk = (uid, sv) => {
    const u = findUser(uid);
    return u && !u.disabled && (u.sv || 0) === sv ? u : null;
  };

  const oauthJson = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers });
    res.end(JSON.stringify(obj));
  };
  const oauthError = (res, status, error, description) => oauthJson(res, status, { error, ...(description ? { error_description: description } : {}) });

  function issueTokens() {
    return {
      access: randomToken('ogm_at_'), accessExp: now() + ACCESS_TTL_S * 1000,
      refresh: randomToken('ogm_rt_'), refreshExp: now() + REFRESH_TTL_MS
    };
  }
  const tokenResponse = t => ({ access_token: t.access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: t.refresh, scope: SCOPE });

  function redirectWith(res, redirectUri, params) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    u.searchParams.set('iss', ORIGIN);
    res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  /* ---------- metadata ---------- */
  const asMetadata = () => ({
    issuer: ORIGIN,
    authorization_endpoint: ORIGIN + '/api/oauth/authorize',
    token_endpoint: ORIGIN + '/api/oauth/token',
    registration_endpoint: ORIGIN + '/api/oauth/register',
    revocation_endpoint: ORIGIN + '/api/oauth/revoke',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/DuarteSantos8/openGym'
  });
  const prMetadata = () => ({
    resource: MCP_URL,
    resource_name: 'openGym',
    authorization_servers: [ORIGIN],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header']
  });
  const PR_METADATA_URL = ORIGIN + '/api/.well-known/oauth-protected-resource';

  /* ---------- the MCP endpoint's gate ---------- */
  function authenticate(req) {
    const challenge = extra => `Bearer resource_metadata="${PR_METADATA_URL}", scope="${SCOPE}"${extra || ''}`;
    const h = String(req.headers.authorization || '');
    if (!/^Bearer\s+/i.test(h)) return { ok: false, status: 401, header: challenge() };
    const token = h.replace(/^Bearer\s+/i, '').trim();
    const grant = token.startsWith('ogm_at_') ? store.byAccess(token) : null;
    const invalid = { ok: false, status: 401, header: challenge(', error="invalid_token"') };
    if (!grant || grant.accessExp < now()) return invalid;
    const user = userOk(grant.uid, grant.sv);
    if (!user) return invalid;
    store.touch(grant);
    return { ok: true, user, grant };
  }

  /* ---------- consent form helpers ---------- */
  const consentFields = (q, uid, sv) => {
    const exp = now() + CONSENT_TTL_MS;
    const f = {
      client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state || '', code_challenge: q.code_challenge,
      code_challenge_method: 'S256', resource: q.resource || '', scope: q.scope || '', exp: String(exp)
    };
    f.csrf = mac(['consent', uid, sv, f.client_id, f.redirect_uri, f.state, f.code_challenge, f.resource, f.scope, f.exp]);
    return f;
  };
  const consentValid = (f, uid, sv) => {
    if (!(+f.exp > now())) return false;
    return macOk(String(f.csrf || ''), mac(['consent', uid, sv, f.client_id, f.redirect_uri, f.state, f.code_challenge, f.resource, f.scope, f.exp]));
  };
  const connCsrf = (uid, sv, grantId) => mac(['connections', uid, sv, grantId]);

  /** Shared checks for GET and POST /authorize. Returns { error } to show as a page (never a
   *  redirect: an unknown client or an unregistered redirect URI must not be redirected to),
   *  { redirectError } for errors the client should receive, or { client, q }. */
  function checkAuthorize(q) {
    const client = store.client(str(q.client_id, 200));
    if (!client) return { error: 'unknown client_id' };
    const redirectUri = str(q.redirect_uri);
    if (!redirectUri || !redirectRegistered(client, redirectUri)) return { error: 'redirect_uri is not registered for this client' };
    const back = (error, description) => ({ redirectError: { redirectUri, params: { error, error_description: description, state: str(q.state, 1024) } } });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'only response_type=code is supported');
    if (!/^[A-Za-z0-9_-]{43}$/.test(str(q.code_challenge, 200))) return back('invalid_request', 'a PKCE code_challenge (S256) is required');
    if ((q.code_challenge_method || 'plain') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    if (!resourceOk(str(q.resource))) return back('invalid_target', 'unknown resource');
    return { client, q: { ...q, redirect_uri: redirectUri, state: str(q.state, 1024), resource: str(q.resource), scope: str(q.scope, 200) } };
  }

  const routes = {
    'GET /api/.well-known/oauth-authorization-server': async (req, res) => oauthJson(res, 200, asMetadata(), { 'Cache-Control': 'public, max-age=3600' }),
    'GET /api/.well-known/oauth-protected-resource': async (req, res) => oauthJson(res, 200, prMetadata(), { 'Cache-Control': 'public, max-age=3600' }),
    'GET /api/.well-known/oauth-protected-resource/api/mcp': async (req, res) => oauthJson(res, 200, prMetadata(), { 'Cache-Control': 'public, max-age=3600' }),

    /* ---------- RFC 7591 ---------- */
    'POST /api/oauth/register': async (req, res) => {
      if (REGISTER_BUDGET.take('all')) return oauthError(res, 429, 'temporarily_unavailable', 'too many registrations, try again later');
      let body;
      try { body = await readForm(req); } catch (e) { return oauthError(res, e.status || 400, 'invalid_client_metadata', e.message); }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(u => typeof u === 'string') : [];
      if (!uris.length || uris.length > 5) return oauthError(res, 400, 'invalid_redirect_uri', 'one to five redirect_uris are required');
      const bad = uris.find(u => !redirectAllowed(u));
      if (bad) return oauthError(res, 400, 'invalid_redirect_uri', `redirect URI not allowed on this server: ${bad.slice(0, 200)}`);
      const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
      if (grantTypes.some(g => !['authorization_code', 'refresh_token'].includes(g))) return oauthError(res, 400, 'invalid_client_metadata', 'only authorization_code and refresh_token are supported');
      const client = store.registerClient({ name: str(body.client_name, 100) || 'MCP client', redirectUris: uris });
      if (!client) return oauthError(res, 503, 'temporarily_unavailable', 'client registry is full');
      oauthJson(res, 201, {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      });
    },

    /* ---------- authorization endpoint ---------- */
    'GET /api/oauth/authorize': async (req, res) => {
      const lang = langOf(req);
      const url = new URL(req.url, 'http://x');
      const q = Object.fromEntries(url.searchParams);
      const c = checkAuthorize(q);
      if (c.error) return sendHtml(res, 400, errorPage(lang, c.error));
      if (c.redirectError) return redirectWith(res, c.redirectError.redirectUri, c.redirectError.params);
      const user = readSession(req);
      if (!user) {
        return sendHtml(res, 200, signInPage(lang, { appUrl: ORIGIN + '/', retryUrl: ORIGIN + '/api/oauth/authorize' + url.search }));
      }
      const redirect = new URL(c.q.redirect_uri);
      sendHtml(res, 200, consentPage(lang, {
        userName: user.name || user.id,
        clientName: c.client.name,
        redirectHost: redirect.host,
        loopback: isLoopback(c.q.redirect_uri),
        fields: consentFields(c.q, user.id, user.sv || 0),
        action: ORIGIN + '/api/oauth/authorize',
        manageUrl: ORIGIN + '/api/oauth/connections'
      }));
    },

    'POST /api/oauth/authorize': async (req, res) => {
      const lang = langOf(req);
      let f;
      try { f = await readForm(req); } catch (e) { return sendHtml(res, e.status || 400, errorPage(lang, e.message)); }
      const user = readSession(req);
      if (!user) return sendHtml(res, 401, errorPage(lang, strings(lang).signin_h));
      const c = checkAuthorize({ ...f, response_type: 'code' });
      if (c.error) return sendHtml(res, 400, errorPage(lang, c.error));
      if (c.redirectError) return redirectWith(res, c.redirectError.redirectUri, c.redirectError.params);
      if (!consentValid(f, user.id, user.sv || 0)) return sendHtml(res, 400, errorPage(lang, 'this page expired — start the connection again from Claude'));
      if (f.decision !== 'allow') {
        return redirectWith(res, c.q.redirect_uri, { error: 'access_denied', error_description: 'the user declined', state: c.q.state });
      }
      const code = randomToken('ogm_ac_');
      codes.set(sha256(code), {
        clientId: c.client.id, clientName: c.client.name, uid: user.id, sv: user.sv || 0, redirectUri: c.q.redirect_uri,
        challenge: c.q.code_challenge, resource: MCP_URL, exp: now() + CODE_TTL_MS
      });
      redirectWith(res, c.q.redirect_uri, { code, state: c.q.state });
    },

    /* ---------- token endpoint ---------- */
    'POST /api/oauth/token': async (req, res) => {
      let f;
      try { f = await readForm(req); } catch (e) { return oauthError(res, e.status || 400, 'invalid_request', e.message); }
      // Every refusal below goes through here, so only failures spend the budget.
      const fail = (status, error, description) => (TOKEN_FAILS.take('all')
        ? oauthError(res, 429, 'temporarily_unavailable', 'slow down')
        : oauthError(res, status, error, description));
      // A public client sends its id in the body. Some clients send it as HTTP Basic even with
      // no secret; accept that too (the secret part, if any, is ignored — none was issued).
      let clientId = str(f.client_id, 200);
      const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''));
      if (!clientId && basic) {
        try { clientId = decodeURIComponent(Buffer.from(basic[1], 'base64').toString('utf8').split(':')[0]); } catch { /* malformed */ }
      }
      const client = store.client(clientId);
      if (!client) return fail(401, 'invalid_client', 'unknown client');

      if (f.grant_type === 'authorization_code') {
        const key = sha256(str(f.code, 400));
        const c = codes.get(key);
        if (c && c.used) {
          // RFC 6749 §4.1.2: a code used twice revokes what it was exchanged for.
          if (c.used !== true) store.revoke(c.used);
          return fail(400, 'invalid_grant', 'code was already used');
        }
        if (c) codes.set(key, { ...c, used: true });       // one use, even a failed one
        if (!c || c.exp < now() || c.clientId !== client.id) return fail(400, 'invalid_grant', 'code is invalid or expired');
        if (str(f.redirect_uri) !== c.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri does not match');
        const verifier = str(f.code_verifier, 200);
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64urlSha256(verifier) !== c.challenge) return fail(400, 'invalid_grant', 'PKCE verification failed');
        if (!resourceOk(str(f.resource))) return fail(400, 'invalid_target', 'unknown resource');
        const user = userOk(c.uid, c.sv);
        if (!user) return fail(400, 'invalid_grant', 'the profile is no longer available');
        const t = issueTokens();
        store.pruneUsers(uid => !!findUser(uid));
        const g = store.createGrant({ uid: c.uid, sv: c.sv, clientId: client.id, clientName: c.clientName, scope: SCOPE, resource: MCP_URL }, t);
        codes.set(key, { ...c, used: g.id });
        audit(req, 'oauth.grant', { user, msg: client.name });
        return oauthJson(res, 200, tokenResponse(t));
      }

      if (f.grant_type === 'refresh_token') {
        const { grant, reused } = store.byRefresh(str(f.refresh_token, 400));
        if (!grant) return fail(400, 'invalid_grant', 'refresh token is invalid');
        if (reused) {
          // The same client retrying a refresh whose answer it lost (or two refreshes racing)
          // shows up as reuse within seconds of the rotation: refuse it, but keep the grant.
          if (grant.clientId === client.id && now() - (grant.rotatedAt || 0) < REUSE_GRACE_MS) {
            return fail(400, 'invalid_grant', 'refresh token was just rotated');
          }
          // Otherwise an old refresh token came back later: it leaked, or the client is broken.
          // Either way the whole grant goes.
          store.revoke(grant.id);
          audit(req, 'oauth.revoke', { uid: grant.uid, msg: 'refresh token reuse', ok: false });
          return fail(400, 'invalid_grant', 'refresh token is invalid');
        }
        if (grant.clientId !== client.id) return fail(400, 'invalid_grant', 'refresh token was issued to another client');
        if (grant.refreshExp < now()) { store.revoke(grant.id); return fail(400, 'invalid_grant', 'refresh token expired'); }
        if (!userOk(grant.uid, grant.sv)) { store.revoke(grant.id); return fail(400, 'invalid_grant', 'the profile signed out everywhere'); }
        const t = issueTokens();
        store.rotate(grant, t);
        return oauthJson(res, 200, tokenResponse(t));
      }

      return fail(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
    },

    /* ---------- RFC 7009 ---------- */
    'POST /api/oauth/revoke': async (req, res) => {
      let f;
      try { f = await readForm(req); } catch { f = {}; }
      const token = str(f.token, 400);
      const g = token.startsWith('ogm_rt_') ? store.byRefresh(token).grant : token.startsWith('ogm_at_') ? store.byAccess(token) : null;
      if (g) { store.revoke(g.id); audit(req, 'oauth.revoke', { uid: g.uid, msg: 'revoked by client' }); }
      res.writeHead(200, { 'Cache-Control': 'no-store' });
      res.end();
    },

    /* ---------- the person's own list ---------- */
    'GET /api/oauth/connections': async (req, res) => {
      const lang = langOf(req);
      const user = readSession(req);
      if (!user) return sendHtml(res, 200, signInPage(lang, { appUrl: ORIGIN + '/', retryUrl: ORIGIN + '/api/oauth/connections' }));
      const sv = user.sv || 0;
      const notice = new URL(req.url, 'http://x').searchParams.get('done') ? strings(lang).revoked : '';
      sendHtml(res, 200, connectionsPage(lang, {
        // A grant from before "sign out everywhere" (older sv) or past its refresh lifetime can
        // no longer be used; it is not a connection worth listing.
        grants: store.grantsOf(user.id).filter(g => g.sv === sv && g.refreshExp > now()), action: ORIGIN + '/api/oauth/connections/revoke',
        csrfFor: id => connCsrf(user.id, sv, id), csrfAll: connCsrf(user.id, sv, '*'), appUrl: ORIGIN + '/', notice
      }));
    },
    'POST /api/oauth/connections/revoke': async (req, res) => {
      const lang = langOf(req);
      let f;
      try { f = await readForm(req); } catch (e) { return sendHtml(res, e.status || 400, errorPage(lang, e.message)); }
      const user = readSession(req);
      if (!user) return sendHtml(res, 401, errorPage(lang, strings(lang).signin_h));
      const id = str(f.grant, 100);
      if (!macOk(String(f.csrf || ''), connCsrf(user.id, user.sv || 0, id))) return sendHtml(res, 400, errorPage(lang, 'this page expired — reload it'));
      if (id === '*') store.revokeUser(user.id);
      else if (store.grantsOf(user.id).some(g => g.id === id)) store.revoke(id);
      audit(req, 'oauth.revoke', { user, msg: id === '*' ? 'all' : 'one' });
      res.writeHead(303, { Location: ORIGIN + '/api/oauth/connections?done=1', 'Cache-Control': 'no-store' });
      res.end();
    }
  };

  return { routes, authenticate, store, MCP_URL, ORIGIN, PR_METADATA_URL, asMetadata, prMetadata };
}
