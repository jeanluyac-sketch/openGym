# Coach pelo chat do Claude (fork)

> Recurso deste fork, não do openGym original. Veja `FORK_NOTES.md` na raiz.

Este fork deixa você usar o **Claude no chat** (claude.ai, app do celular ou desktop, com a
sua assinatura) como treinador do openGym — sem chave de API. O Claude conversa com você,
lê o seu perfil e o seu histórico pelo conector, monta o plano usando só exercícios que existem
no app e o envia como **proposta do Coach**. Você revisa e aplica no app, e pode desfazer.

## Como funciona

```
Você ── conversa ──▶ Claude (claude.ai)
                       │  conector personalizado (MCP remoto, OAuth)
                       ▼
           https://SEU-DOMINIO/api/mcp  (dentro da api do openGym)
                       │  mesmo construtor de contexto e mesmo validador do Coach
                       ▼
           proposta pendente ──▶ tela Coach do app ──▶ você aplica / desfaz
```

- **Nada é aplicado sem você.** As ferramentas de escrita só criam uma proposta, a mesma que um
  provedor de IA do Coach criaria. Ela passa pelo validador do Coach (lista fechada de mudanças,
  exercícios conferidos contra a biblioteca real) antes de chegar ao app.
- **O Claude não toca** no seu histórico de treinos, no seu peso nem nas configurações.
- **Login:** o Claude pede autorização uma vez; você confirma numa página do próprio openGym,
  logado com a sua conta (senha ou passkey). Só o hash dos tokens fica guardado, em
  `./data/oauth.json`.

## Ferramentas que o Claude recebe

| Ferramenta | O que faz |
|---|---|
| `get_coach_context` | Regras do Coach + seu perfil, plano, histórico e a biblioteca filtrada pelo seu equipamento — exatamente o que o Coach embutido manda a um provedor. |
| `search_exercises` | Busca no catálogo completo (1.324 exercícios) e nos seus exercícios próprios. |
| `propose_plan` | Envia um plano novo como proposta (substitui a proposta pendente, se houver). |
| `propose_changes` | Envia ajustes ao plano atual (trocar exercício, séries, repetições, dias…). |
| `get_proposal_status` | Diz se a proposta ainda está esperando, ou se foi aplicada/descartada. |

## Configuração (uma vez)

1. **Ligue o Coach no app** (só administradores): *Configurações → Admin dashboard → AI Coach*.
   Qualquer provedor serve (por exemplo Gemini com chave gratuita). Ele é necessário porque é
   a tela do Coach que mostra a proposta.
2. **Abra a tela Coach** no app, aceite o aviso e responda às perguntas (objetivo, dias,
   equipamento, limitações). O Claude usa essas respostas; dá para complementar no chat.
3. **Encaminhe `/.well-known/` para a api.** O Claude descobre o servidor de autorização em
   `https://SEU-DOMINIO/.well-known/oauth-authorization-server`, na raiz do domínio, e o
   nginx do contêiner `web` só repassa `/api/`. No Caddy:

   ```caddy
   SEU-DOMINIO {
       @oauth path /.well-known/oauth-authorization-server* /.well-known/oauth-protected-resource*
       handle @oauth {
           rewrite * /api{path}
           reverse_proxy localhost:8080
       }
       handle {
           reverse_proxy localhost:8080
       }
   }
   ```

   Teste: `curl https://SEU-DOMINIO/.well-known/oauth-authorization-server` deve devolver JSON.
4. **Adicione o conector no Claude** (pelo site claude.ai — o app do celular usa os conectores
   já adicionados, mas não adiciona novos): *Configurações → Conectores → Adicionar conector
   personalizado*. Nome: `openGym`. URL: `https://SEU-DOMINIO/api/mcp`. Deixe os campos de
   OAuth em branco. Clique em **Conectar**, entre no openGym se pedir, e clique em **Permitir**.
   Disponível nos planos Pro, Max, Team e Enterprise do Claude.

## Uso

Numa conversa com o conector ligado, por exemplo:

> Monta um treino novo de 4 dias pra hipertrofia, 60 minutos, sem agachamento livre por causa
> do joelho.

O Claude lê o contexto, monta o plano, envia, e avisa. Abra o app → **Coach**: a proposta
aparece como cartão; aplique, ou peça ajustes (no chat do Claude ou no próprio Coach).

## Revogar o acesso

- Página `https://SEU-DOMINIO/api/oauth/connections` (logado): lista e revoga conexões.
- *Sair de todos os dispositivos* no app também derruba o acesso do Claude.
- No claude.ai, remover o conector apaga o token do lado do Claude.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `CHAT_BRIDGE` | ligado | `0` remove todas as rotas do conector (respondem 404). |
| `CHAT_BRIDGE_ACCESS_TTL` | `3600` | Validade do token de acesso, em segundos. |
| `CHAT_BRIDGE_REFRESH_DAYS` | `60` | Validade do token de renovação (renova a cada uso). |
| `CHAT_BRIDGE_REDIRECTS` | — | URIs de retorno extras aceitas no registro, separadas por vírgula. |
| `CHAT_BRIDGE_LOOPBACK` | ligado | `0` recusa retornos para `localhost` (usados pelo Claude Code). |
| `CHAT_BRIDGE_REUSE_GRACE_MS` | `60000` | Janela em que reenviar um token de renovação recém-trocado não derruba a conexão. |

O endereço público vem de `ORIGIN`, como o resto do app.

## Rotas

`GET /api/.well-known/oauth-authorization-server`, `GET /api/.well-known/oauth-protected-resource`
(e `/api/mcp` no fim), `POST /api/oauth/register`, `GET|POST /api/oauth/authorize`,
`POST /api/oauth/token`, `POST /api/oauth/revoke`, `GET /api/oauth/connections`,
`POST /api/oauth/connections/revoke`, `POST /api/mcp` (MCP Streamable HTTP, JSON; `GET` e
`DELETE` respondem 405).

## Problemas comuns

- **"Couldn't reach the MCP server" no Claude:** confira o passo 3 (`/.well-known/` na raiz).
- **O Claude diz que o Coach está desligado:** passo 1.
- **A proposta não aparece:** abra a tela Coach; se o app pedir as perguntas iniciais, responda
  (passo 2). A proposta expira em 14 dias.
- **"the in-app Coach is working on a request right now":** o Coach do app está processando um
  pedido; espere um minuto.
