/* fork(claude-chat) — persistent OAuth state for the Claude chat connector.
 *
 * Two lists in ./data/oauth.json, written the same way server.js writes db.json (temp file,
 * rename, 0600):
 *
 *   clients  what Claude registered through Dynamic Client Registration (RFC 7591). Public
 *            clients only — no secret is ever issued — so a client is nothing but an id, a
 *            name and the redirect URIs it may be sent back to.
 *   grants   one per "Allow" on the consent page: which profile, which client, and the
 *            SHA-256 of the current access and refresh tokens. A token itself is never stored,
 *            so a backup of ./data (which the daily backup takes) cannot be replayed.
 *
 * Registration is unauthenticated by design (that is what DCR is), so the client list is
 * bounded and pruned: a client that never got a grant is dropped after a day, and past
 * MAX_CLIENTS the oldest unused one makes room. Grants are bounded per profile.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_CLIENTS = 100;
export const MAX_GRANTS_PER_USER = 20;
const UNUSED_CLIENT_MS = 24 * 3600 * 1000;
// lastUsedAt is bookkeeping for the connections page, not security: written at most this often
// so a chat that calls ten tools in a row does not rewrite the file ten times.
const TOUCH_MS = 10 * 60 * 1000;

export const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
export const randomToken = prefix => prefix + crypto.randomBytes(32).toString('base64url');
export const randomId = () => crypto.randomBytes(12).toString('base64url');

export function createStore(dataDir, { now = Date.now } = {}) {
  const file = path.join(dataDir, 'oauth.json');
  let data = { clients: [], grants: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      clients: Array.isArray(raw.clients) ? raw.clients.filter(c => c && typeof c.id === 'string') : [],
      grants: Array.isArray(raw.grants) ? raw.grants.filter(g => g && typeof g.id === 'string') : []
    };
  } catch { /* absent on a fresh instance */ }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const hasGrant = clientId => data.grants.some(g => g.clientId === clientId);
  function pruneClients() {
    const t = now();
    data.clients = data.clients.filter(c => hasGrant(c.id) || t - c.createdAt < UNUSED_CLIENT_MS);
  }

  return {
    file,

    /* ---------- clients ---------- */
    registerClient({ name, redirectUris }) {
      pruneClients();
      if (data.clients.length >= MAX_CLIENTS) {
        // Make room with the oldest client nobody ever authorised; one that holds a grant is
        // somebody's working connection and is never evicted to make room for a stranger.
        const idx = data.clients.findIndex(c => !hasGrant(c.id));
        if (idx < 0) return null;
        data.clients.splice(idx, 1);
      }
      const client = { id: 'ogc_' + randomId(), name: String(name || 'MCP client').slice(0, 100), redirectUris, createdAt: now() };
      data.clients.push(client);
      save();
      return client;
    },
    client: id => data.clients.find(c => c.id === id) || null,

    /* ---------- grants ---------- */
    createGrant({ uid, sv, clientId, clientName, scope, resource }, tokens) {
      const g = {
        id: randomId(), uid, sv, clientId, clientName: String(clientName || '').slice(0, 100), scope, resource,
        createdAt: now(), lastUsedAt: now(),
        accessHash: sha256(tokens.access), accessExp: tokens.accessExp,
        refreshHash: sha256(tokens.refresh), refreshExp: tokens.refreshExp,
        prevRefreshHash: null
      };
      // Expired grants are dead weight; drop them whenever a new one is made.
      data.grants = data.grants.filter(x => x.refreshExp > now());
      data.grants.push(g);
      const mine = data.grants.filter(x => x.uid === uid).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      while (mine.length > MAX_GRANTS_PER_USER) {
        const old = mine.shift();
        data.grants = data.grants.filter(x => x !== old);
      }
      save();
      return g;
    },
    byAccess: token => {
      const h = sha256(token);
      return data.grants.find(g => g.accessHash === h) || null;
    },
    /** { grant, reused } — `reused` when the token is the refresh token this grant rotated away
     *  from: somebody is replaying an old one, so the caller revokes the whole grant. */
    byRefresh: token => {
      const h = sha256(token);
      const g = data.grants.find(x => x.refreshHash === h);
      if (g) return { grant: g, reused: false };
      const old = data.grants.find(x => x.prevRefreshHash === h);
      return old ? { grant: old, reused: true } : { grant: null, reused: false };
    },
    rotate(grant, tokens) {
      grant.prevRefreshHash = grant.refreshHash;
      grant.accessHash = sha256(tokens.access);
      grant.accessExp = tokens.accessExp;
      grant.refreshHash = sha256(tokens.refresh);
      grant.refreshExp = tokens.refreshExp;
      grant.lastUsedAt = now();
      grant.rotatedAt = now();
      save();
    },
    touch(grant) {
      if (now() - (grant.lastUsedAt || 0) < TOUCH_MS) return;
      grant.lastUsedAt = now();
      save();
    },
    revoke(grantId) {
      const before = data.grants.length;
      data.grants = data.grants.filter(g => g.id !== grantId);
      if (data.grants.length !== before) { pruneClients(); save(); return true; }
      return false;
    },
    revokeUser(uid) {
      const before = data.grants.length;
      data.grants = data.grants.filter(g => g.uid !== uid);
      if (data.grants.length !== before) { pruneClients(); save(); }
      return before - data.grants.length;
    },
    /** Drop grants of profiles that no longer exist (an admin deleted them). */
    pruneUsers(exists) {
      const before = data.grants.length;
      data.grants = data.grants.filter(g => exists(g.uid));
      if (data.grants.length !== before) { pruneClients(); save(); }
    },
    grantsOf: uid => data.grants.filter(g => g.uid === uid).sort((a, b) => b.createdAt - a.createdAt),
    _data: () => data
  };
}
