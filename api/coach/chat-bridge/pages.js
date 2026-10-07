/* fork(claude-chat) — the three small HTML pages the OAuth flow needs: "sign in first",
 * "allow Claude?", and "your connections". Server-rendered on purpose: they are reached by a
 * top-level navigation from claude.ai, before the app has loaded, and adding screens to the
 * React app would put this fork's changes inside files upstream edits every week.
 *
 * Every value that came from a request is escaped. The page carries its own CSP on top of the
 * frame-ancestors nginx already sends: no script at all, inline styles only. */

export const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const T = {
  pt: {
    title: 'Conectar o Claude ao openGym',
    signin_h: 'Entre no openGym primeiro',
    signin_p: 'Para autorizar o Claude, você precisa estar conectado ao seu perfil do openGym neste navegador.',
    signin_open: 'Abrir o openGym e entrar',
    signin_then: 'Depois de entrar, volte para esta aba e clique em continuar.',
    signin_continue: 'Já entrei — continuar',
    consent_h: 'Permitir que o Claude acesse seu treino?',
    consent_who: 'Perfil',
    consent_client: 'Aplicativo',
    consent_back: 'Depois de permitir, você volta para',
    consent_can: 'O Claude poderá:',
    can1: 'ler seu plano, seus treinos registrados, seu peso e seu perfil do Coach;',
    can2: 'consultar a biblioteca de exercícios do app;',
    can3: 'enviar propostas de plano para o Coach — você revisa e aplica no app, e pode desfazer.',
    cannot: 'O Claude não pode apagar treinos, mudar configurações nem aplicar nada sozinho.',
    allow: 'Permitir',
    deny: 'Recusar',
    manage: 'Gerenciar conexões',
    loopback: 'Atenção: este pedido volta para um programa no próprio computador (localhost). Só permita se foi você que iniciou a conexão agora, pelo Claude Code.',
    err_h: 'Não foi possível continuar',
    conn_h: 'Conexões do Claude',
    conn_none: 'Nenhuma conexão ativa.',
    conn_created: 'Conectado em',
    conn_used: 'Último uso',
    conn_revoke: 'Revogar',
    conn_revoke_all: 'Revogar todas',
    conn_back: 'Voltar ao openGym',
    revoked: 'Conexão revogada.'
  },
  en: {
    title: 'Connect Claude to openGym',
    signin_h: 'Sign in to openGym first',
    signin_p: 'To authorise Claude you need to be signed in to your openGym profile in this browser.',
    signin_open: 'Open openGym and sign in',
    signin_then: 'Once signed in, come back to this tab and press continue.',
    signin_continue: 'I am signed in — continue',
    consent_h: 'Allow Claude to access your training?',
    consent_who: 'Profile',
    consent_client: 'Application',
    consent_back: 'After you allow it you go back to',
    consent_can: 'Claude will be able to:',
    can1: 'read your plan, your logged workouts, your body weight and your Coach profile;',
    can2: 'search the app’s exercise library;',
    can3: 'send plan proposals to the Coach — you review and apply them in the app, and can undo.',
    cannot: 'Claude cannot delete workouts, change settings or apply anything on its own.',
    allow: 'Allow',
    deny: 'Deny',
    manage: 'Manage connections',
    loopback: 'Careful: this request returns to a program on this computer (localhost). Only allow it if you just started the connection yourself, from Claude Code.',
    err_h: 'Cannot continue',
    conn_h: 'Claude connections',
    conn_none: 'No active connections.',
    conn_created: 'Connected',
    conn_used: 'Last used',
    conn_revoke: 'Revoke',
    conn_revoke_all: 'Revoke all',
    conn_back: 'Back to openGym',
    revoked: 'Connection revoked.'
  }
};

export const langOf = req => (/^\s*pt\b/i.test(String(req.headers['accept-language'] || '')) ? 'pt' : 'en');
export const strings = lang => T[lang] || T.en;

const STYLE = `
  :root { color-scheme: light dark; --bg:#0f1115; --card:#181b22; --fg:#e8eaf0; --muted:#9aa3b2; --accent:#a3e635; --line:#2a2f3a; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f6f8; --card:#fff; --fg:#14161a; --muted:#5b6472; --accent:#4d7c0f; --line:#e3e6eb; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--fg);
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; }
  main { width:100%; max-width:460px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:24px; }
  h1 { font-size:1.3rem; margin:0 0 12px; }
  p, li { color:var(--fg); } .muted { color:var(--muted); font-size:.92rem; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:12px 0; } dt { color:var(--muted); } dd { margin:0; word-break:break-all; }
  ul { padding-left:20px; } .warn { border-left:3px solid #f59e0b; padding:8px 12px; background:rgba(245,158,11,.1); border-radius:6px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
  button, .btn { appearance:none; border:1px solid var(--line); background:transparent; color:var(--fg); padding:10px 16px; border-radius:10px;
         font:inherit; cursor:pointer; text-decoration:none; display:inline-block; }
  .primary { background:var(--accent); border-color:var(--accent); color:#0b0d10; font-weight:600; }
  table { width:100%; border-collapse:collapse; margin-top:8px; } td { padding:8px 4px; border-top:1px solid var(--line); vertical-align:top; font-size:.92rem; }
  form.inline { display:inline; }
`;

export function page(lang, title, body) {
  return `<!doctype html><html lang="${lang === 'pt' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    // same-origin, not no-referrer: with no-referrer a form POST from these pages carries
    // `Origin: null`, and where Sec-Fetch-Site is missing (older Safari, a proxy stripping it)
    // the server's CSRF gate falls back to the Origin and refuses Allow and Revoke.
    'Referrer-Policy': 'same-origin'
  });
  res.end(html);
}

const hidden = fields => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');

export function errorPage(lang, message) {
  const s = strings(lang);
  return page(lang, s.err_h, `<h1>${esc(s.err_h)}</h1><p>${esc(message)}</p>`);
}

export function signInPage(lang, { appUrl, retryUrl }) {
  const s = strings(lang);
  return page(lang, s.title, `<h1>${esc(s.signin_h)}</h1><p>${esc(s.signin_p)}</p>`
    + `<div class="row"><a class="btn primary" href="${esc(appUrl)}" target="_blank" rel="noopener">${esc(s.signin_open)}</a></div>`
    + `<p class="muted">${esc(s.signin_then)}</p>`
    + `<div class="row"><a class="btn" href="${esc(retryUrl)}">${esc(s.signin_continue)}</a></div>`);
}

export function consentPage(lang, { userName, clientName, redirectHost, loopback, fields, action, manageUrl }) {
  const s = strings(lang);
  return page(lang, s.title, `<h1>${esc(s.consent_h)}</h1>`
    + `<dl><dt>${esc(s.consent_who)}</dt><dd>${esc(userName)}</dd>`
    + `<dt>${esc(s.consent_client)}</dt><dd>${esc(clientName)}</dd>`
    + `<dt>${esc(s.consent_back)}</dt><dd><strong>${esc(redirectHost)}</strong></dd></dl>`
    + (loopback ? `<p class="warn">${esc(s.loopback)}</p>` : '')
    + `<p>${esc(s.consent_can)}</p><ul><li>${esc(s.can1)}</li><li>${esc(s.can2)}</li><li>${esc(s.can3)}</li></ul>`
    + `<p class="muted">${esc(s.cannot)}</p>`
    + `<form method="post" action="${esc(action)}">${hidden(fields)}`
    + `<div class="row"><button class="primary" type="submit" name="decision" value="allow">${esc(s.allow)}</button>`
    + `<button type="submit" name="decision" value="deny">${esc(s.deny)}</button></div></form>`
    + `<p class="muted" style="margin-top:16px"><a href="${esc(manageUrl)}">${esc(s.manage)}</a></p>`);
}

const fmtTime = (lang, ms) => {
  try { return new Date(ms).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'; }
  catch { return new Date(ms).toISOString(); }
};

export function connectionsPage(lang, { grants, action, csrfFor, csrfAll, appUrl, notice }) {
  const s = strings(lang);
  const rows = grants.map(g => `<tr><td><strong>${esc(g.clientName || 'Claude')}</strong><br>`
    + `<span class="muted">${esc(s.conn_created)}: ${esc(fmtTime(lang, g.createdAt))}<br>${esc(s.conn_used)}: ${esc(fmtTime(lang, g.lastUsedAt))}</span></td>`
    + `<td style="text-align:right"><form class="inline" method="post" action="${esc(action)}">${hidden({ grant: g.id, csrf: csrfFor(g.id) })}`
    + `<button type="submit">${esc(s.conn_revoke)}</button></form></td></tr>`).join('');
  return page(lang, s.conn_h, `<h1>${esc(s.conn_h)}</h1>`
    + (notice ? `<p class="muted">${esc(notice)}</p>` : '')
    + (grants.length ? `<table>${rows}</table>`
      + `<form method="post" action="${esc(action)}">${hidden({ grant: '*', csrf: csrfAll })}<div class="row"><button type="submit">${esc(s.conn_revoke_all)}</button></div></form>`
      : `<p class="muted">${esc(s.conn_none)}</p>`)
    + `<div class="row"><a class="btn" href="${esc(appUrl)}">${esc(s.conn_back)}</a></div>`);
}
