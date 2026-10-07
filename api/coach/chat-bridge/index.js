/* fork(claude-chat) — Claude chat connector: OAuth + remote MCP, as one route table.
 *
 * server.js spreads chatBridgeRoutes(...) into its own table, next to the Coach routes, and
 * that one line (plus its import) is the whole footprint of this fork in server.js. Everything
 * else lives under api/coach/chat-bridge/, which api/Dockerfile already copies with coach/.
 *
 * CHAT_BRIDGE=0 removes every route (they answer 404 like any unknown path).
 * See docs/CLAUDE_CHAT.md. */
import { createOAuth } from './oauth.js';
import { mcpRoutes } from './mcp.js';

export const CHAT_BRIDGE_ON = !/^(0|false|no|off)$/i.test(process.env.CHAT_BRIDGE || '');

export function chatBridgeRoutes({ dataDir, origin, readSession, findUser, audit }) {
  if (!CHAT_BRIDGE_ON) return {};
  const oauth = createOAuth({ dataDir, origin, readSession, findUser, audit });
  return { ...oauth.routes, ...mcpRoutes({ oauth }) };
}
