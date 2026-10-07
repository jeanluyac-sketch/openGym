# Notas do fork

Este repositório é um fork de [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)
com um único recurso a mais: **Coach pelo chat do Claude** (conector MCP remoto com OAuth),
descrito em [docs/CLAUDE_CHAT.md](docs/CLAUDE_CHAT.md). Licença: AGPL-3.0-or-later, como o original;
o código-fonte deste fork é público aqui.

## Regra de ouro

Mudar **o mínimo possível** nos arquivos do original. Tudo o que é novo mora em arquivos novos.
Cada linha alterada num arquivo do original é marcada com `fork(claude-chat)`.

## Arquivos do original que este fork altera

| Arquivo | Mudança | Se der conflito |
|---|---|---|
| `api/server.js` | 1 `import` de `./coach/chat-bridge/index.js` logo abaixo do `import { coachRoutes }`, e 2 linhas logo abaixo de `...coachRoutes(...)` na tabela `routes`, espalhando `chatBridgeRoutes({ dataDir: DATA, origin: ORIGIN, readSession, findUser, audit })`. | Aceite a versão do original e recoloque as 3 linhas nos mesmos lugares. Se `readSession`, `audit`, `db.users`, `DATA` ou `ORIGIN` mudarem de nome, ajuste os argumentos. |
| `api/coach/config.js` | Provedor `claude-chat` na tabela `PROVIDERS` (logo abaixo de `fixture`, com `chatOnly: true`) e `|| providerMeta(cfg).chatOnly` nos testes de `fixture` em `credentialFor()` e `isConnected()`. | Recoloque a linha da tabela e as duas condições. |
| `api/coach/adapters/index.js` | Adaptador `chatOnly` que não roda nada, registrado como `'claude-chat'` em `ADAPTERS`. | Recoloque o objeto e a chave. |
| `api/coach/core/validate.js` | Em `validatePlan()`, uma linha aceita `restSec` (15–600 s) por exercício, logo após a linha do `sg`. | Recoloque a linha. |
| `api/coach/jobs.js` | Em `enqueue()`, primeira linha recusa jobs quando o provedor é `chatOnly` (`CoachError('chat', CHAT_ONLY_MESSAGE)`). Função nova `submitProposal()` antes da seção `decisions`. Usa `readUser`, `writeUser`, `inflight`, `onProposal`, `hashPlan`, `payloadLib.canonicalPlan`, `PENDING_DAYS`, `HISTORY_MAX`, `CoachError`. | Aceite a versão do original e recoloque a função. Se o formato de `pending` mudou em `execute()`, copie o novo formato (é o mesmo objeto, sem a parte do provedor). |

## Arquivos novos (não conflitam)

- `api/coach/chat-bridge/` — `index.js` (tabela de rotas), `oauth.js` (servidor OAuth 2.1),
  `store.js` (clientes e concessões em `./data/oauth.json`), `mcp.js` (endpoint MCP e
  ferramentas), `pages.js` (páginas de login/consentimento/conexões).
- `api/test/chat-bridge.test.js`, `api/test/chat-bridge-store.test.js`.
- `.github/workflows/fork-sync.yml` — sincronização semanal com o original.
- `docs/CLAUDE_CHAT.md`, `FORK_NOTES.md`.

`api/Dockerfile` não precisa mudar: ele já copia `coach/` inteiro.

## Dependências do código do original

O conector reaproveita, sem copiar: `coach/core/payload.js` (`build`, `canonicalPlan`,
`langTag`), `coach/core/validate.js` (`validatePlan`, `validateReview`, `CHANGE_TYPES`),
`coach/core/library.js` (`LIBRARY`), `coach/core/prompts.js` (`PROMPTS`), `coach/handle.js`,
`coach/config.js` (`isEnabled`, `isConnected`), `coach/jobs.js` (`readState`, `readUser`,
`status`), `rate-limit.js` (`createWindow`). Se o original renomear algum desses, os testes
`api/test/chat-bridge*.test.js` falham e a sincronização para antes de publicar.

## Como a atualização funciona

1. Toda segunda, `fork-sync.yml` junta o `main` do original ao `main` deste fork.
2. Sem conflito e com todos os testes passando: publica no `main`, dispara
   `docker-publish.yml` (imagens `ghcr.io/<dono-do-fork>/opengym-api:edge` e `opengym-web:edge`),
   e o servidor baixa as imagens novas na madrugada seguinte.
3. Com conflito: nada é publicado; abre uma issue `sync-conflict` listando os arquivos.
4. Testes falhando: o resultado vai para o branch `sync/upstream`; issue `sync-tests-failed`.
5. Se o original mudou arquivos de `.github/workflows/`, o robô não tem permissão para gravar;
   issue `sync-manual` pede um clique em **Sync fork → Update branch**.

## Voltar para o original

No servidor, apague `docker-compose.override.yml` (que aponta as imagens para este fork) e rode
`docker compose pull && docker compose up -d`. Os dados continuam compatíveis: o fork só
acrescenta `./data/oauth.json`, que o original ignora.
