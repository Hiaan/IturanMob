# Manual de instalação

Há duas formas de rodar o Finance AI:

- **Docker Compose**: recomendada para uso diário e produção. Sobe tudo com um comando.
- **Local**: para desenvolvimento. Roda Node.js na máquina e usa PostgreSQL e Redis.

## Requisitos

| Componente | Versão |
|---|---|
| Docker + Docker Compose v2 | 24+ (somente para a opção Docker) |
| Node.js | 20.11+ (recomendado 22) |
| pnpm | 10 (`corepack enable`) |
| PostgreSQL | 16 |
| Redis | 7 |
| ffmpeg | qualquer versão recente (só para transcrever áudios) |
| pg_dump/pg_restore | 16 ou superior (só para backups no formato do PostgreSQL) |

## Opção A: Docker Compose

```bash
git clone <repositório> finance-ai && cd finance-ai
cp .env.example .env
```

Gere os segredos. Sem Node instalado, use `openssl rand -base64 48` para o `SESSION_SECRET`,
`openssl rand -base64 32` para a `ENCRYPTION_KEY` e uma senha alfanumérica para o
`POSTGRES_PASSWORD`. Com Node instalado:

```bash
corepack enable && pnpm install && pnpm run setup
```

Depois, revise o `.env` (veja [CONFIGURACAO.md](CONFIGURACAO.md)) e suba a stack:

```bash
docker compose up -d --build
```

Isso sobe `postgres`, `redis`, `migrate` (aplica as migrations e encerra), `web` e `worker`.
Acompanhe com:

```bash
docker compose ps
docker compose logs -f web worker
curl http://localhost:3000/api/health   # {"status":"ok", ...}
```

Abra **http://localhost:3000/cadastro** e crie a família e o seu usuário (proprietário). O primeiro
cadastro é sempre liberado. Depois dele, os outros membros entram por **convite** (Configurações →
Membros).

Serviços opcionais:

```bash
docker compose --profile whisper up -d   # transcrição de áudio local (sem enviar áudio a terceiros)
docker compose --profile ollama up -d    # LLM local compatível com a API da OpenAI
```

## Opção B: desenvolvimento local

```bash
corepack enable
pnpm install
cp .env.example .env && pnpm run setup        # gera segredos e testa banco/Redis

# PostgreSQL e Redis: use os seus ou suba só esses dois pelo compose, publicando as portas:
docker compose up -d postgres redis           # (ou serviços locais equivalentes)

pnpm db:deploy                                # aplica as migrations
pnpm dev                                      # painel em http://localhost:3000
pnpm dev:worker                               # em outro terminal: WhatsApp, filas e tarefas
```

> O `docker-compose.yml` não publica as portas do PostgreSQL e do Redis por segurança. Para
> desenvolver com eles em contêiner, crie um `docker-compose.override.yml` local:
>
> ```yaml
> services:
>   postgres:
>     ports: ["5432:5432"]
>   redis:
>     ports: ["6379:6379"]
> ```
>
> e ajuste `DATABASE_URL` no `.env` para usar o usuário e a senha definidos em `POSTGRES_*`.

### Dados de demonstração (opcional)

Para avaliar a interface com dados de exemplo **fictícios** (identificados como tal):

```bash
SEED_DEMO=true pnpm db:seed
# login: demo@demo.invalid · senha: Demonstracao#2026
```

O seed se recusa a rodar com `NODE_ENV=production` e não bloqueia o primeiro cadastro real.

## Scripts

| Comando | O que faz |
|---|---|
| `pnpm dev` / `pnpm dev:worker` | Painel e worker em modo desenvolvimento |
| `pnpm build` / `pnpm start` / `pnpm worker` | Build e execução de produção sem Docker |
| `pnpm run setup` | Cria o `.env`, gera segredos e testa conexões |
| `pnpm db:deploy` | Aplica migrations pendentes |
| `pnpm db:migrate` | Cria uma nova migration (desenvolvimento) |
| `pnpm db:seed` | Seed de demonstração (com `SEED_DEMO=true`) |
| `pnpm backup` / `pnpm backup:verify` | Backup manual e verificação do último backup |
| `pnpm typecheck` | Verificação de tipos |
| `pnpm test:unit` / `pnpm test:integration` / `pnpm test:e2e` | Testes (ver [TESTES.md](TESTES.md)) |

## Primeiros passos no sistema

1. **Contas**: cadastre as contas bancárias com o saldo inicial e a data desse saldo.
2. **Cartões**: cadastre os cartões com os dias de fechamento e vencimento e a conta que paga a fatura.
3. **Membros**: convide o cônjuge e defina o papel e o telefone de cada um (para o WhatsApp).
4. **WhatsApp**: em Integrações → WhatsApp, teste no **simulador** e depois conecte:
   - a Cloud API oficial, em que cada membro conversa com o número comercial, sem grupo; ou
   - ciente dos riscos, o modo QR Code, que lê o grupo da família mas não é oficial.

   Selecione o grupo (no modo QR Code), autorize os remetentes e registre o consentimento.
5. **IA** (opcional): em Integrações → IA, cadastre uma chave e autorize o uso externo em
   Configurações → Privacidade e IA. Sem isso, o motor local em português continua funcionando.
6. Mande no grupo: `gastei 45,90 no mercado no pix`.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `Configuração inválida: SESSION_SECRET…` | Segredos não gerados. Rode `pnpm run setup`. |
| `/cadastro` diz que o cadastro está desativado | Já existe uma família. Use convite ou `ALLOW_REGISTRATION=true` temporariamente. |
| `/api/health` com `"status":"degraded"` | Redis fora ou worker parado. O painel funciona, mas o WhatsApp e as tarefas ficam parados. |
| Áudios viram pendência "transcrição indisponível" | `TRANSCRIPTION_PROVIDER=none` ou falta de autorização para áudio externo. |
| "Login bloqueado temporariamente" | Muitas tentativas erradas. Aguarde 15 minutos. |
