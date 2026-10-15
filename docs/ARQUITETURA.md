# Arquitetura

## Visão geral

```
                ┌────────────── navegador (painel) ───────────────┐
                │ Next.js App Router · React · TanStack Query · SSE│
                └───────────────▲───────────────────┬─────────────┘
                                │ /api/v1 (JSON)     │ /api/v1/events (SSE)
┌───────────────────────────────┴───────────────────▼──────────────────────────┐
│ WEB (Next.js, Node)                                                           │
│  rotas finas (src/app/api) → serviços de domínio (src/server/modules)          │
│  autenticação, CSRF, rate limit, validação Zod, permissões, auditoria          │
└──────────────┬──────────────────────────────┬─────────────────────────────────┘
               │ Prisma                        │ BullMQ / pub-sub
        ┌──────▼──────┐                 ┌──────▼──────┐
        │ PostgreSQL  │                 │    Redis    │  filas, eventos em tempo real,
        │  (dados)    │                 │             │  rate limit, heartbeat
        └──────▲──────┘                 └──────▲──────┘
               │                               │
┌──────────────┴───────────────────────────────┴─────────────────────────────────┐
│ WORKER (processo único)                                                         │
│  conexões WhatsApp (simulador · Cloud API oficial · Baileys não oficial)        │
│  fila whatsapp-inbound → pipeline de IA → serviços → ledger                      │
│  fila whatsapp-outbound → respostas/notificações (com limite de envio)          │
│  tarefas periódicas: recorrências, alertas, relatórios, retenção, backups       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- O **web** e o **worker** compartilham o mesmo código de domínio (`src/server`). Rodam em processos
  separados para que o WhatsApp, as filas e as tarefas longas não afetem o painel.
- Se o WhatsApp ou o Redis caírem, o painel continua funcionando e os dados continuam acessíveis. As
  mensagens ficam na fila e são reprocessadas quando a conexão voltar.

## Estrutura de pastas

```
prisma/
  schema.prisma            modelo de dados (≈ 45 tabelas) e convenções
  migrations/              migrations SQL (inclui CHECKs de integridade)
  seed.ts                  dados de DEMONSTRAÇÃO opcionais (SEED_DEMO=true)
scripts/
  setup.ts                 cria .env e gera segredos; testa banco e Redis
  backup.ts                backup/verificação manual (pg_dump)
src/
  app/
    (auth)/                login, cadastro, convite
    (app)/                 telas autenticadas: dashboard, transações, pendências, contas, cartões,
                           orçamentos, metas, contas a pagar, assistente, relatórios, categorias,
                           integrações (WhatsApp, IA), importação, configurações
    api/
      auth/                login, logout, cadastro, convite
      health/              verificação de saúde (banco, Redis, worker)
      v1/                  API REST do painel (≈ 120 rotas)
      webhooks/            entrada externa (WhatsApp Cloud API)
  components/
    ui/                    componentes base (estilo shadcn/ui sobre Radix)
    shared/ charts/ layout/ providers/
  features/<domínio>/      telas, formulários e hooks de dados de cada área
  lib/                     utilitários puros compartilhados (dinheiro, datas, rótulos)
    client/                cliente HTTP, chaves de consulta, tempo real (SSE)
  server/
    env.ts db.ts logger.ts errors.ts crypto.ts redis.ts events.ts rate-limit.ts storage/
    auth/                  sessões, senhas, permissões, contexto de serviço
    api/                   wrappers das rotas (authed/publicRoute), períodos
    modules/<domínio>/     REGRAS DE NEGÓCIO (únicas autorizadas a gravar dados financeiros)
    ai/
      nlu/                 motor local pt-BR (valores, datas, intenções, categorias)
      engine/              interpretação, validação, decisão por confiança, ações, respostas
      providers/           Anthropic, OpenAI, compatível com OpenAI (+ registro e logs)
      prompts/             prompts de sistema (interpretação e assistente)
      assistant/           ferramentas somente leitura + respostas locais
      transcription/       ffmpeg + API compatível com Whisper
      vision/              leitura de comprovantes + redação de dados sensíveis
      pipeline/            orquestra texto/áudio/imagem/documento de uma mensagem
    whatsapp/              provedores, ingestão, autorização, saída, sessão criptografada
    jobs/                  filas BullMQ e tarefas periódicas
  worker/                  processo do worker
  middleware.ts            redireciona para /login sem sessão
tests/
  unit/                    regras puras (dinheiro, faturas, NLU, importadores…)
  integration/             serviços contra PostgreSQL real (banco de teste isolado)
  e2e/                     Playwright (fluxos no navegador)
docs/                      documentação
```

## Princípios

1. **Regras de negócio só nos serviços** (`src/server/modules`). Rotas, telas, IA e WhatsApp chamam os
   mesmos serviços. Nenhum deles grava direto no banco.
2. **Contexto de serviço** (`ServiceContext`): toda função recebe `householdId`, membro, papel e fuso.
   Toda consulta filtra por `householdId`, o que isola as famílias.
3. **Ledger derivado**: os saldos vêm dos movimentos de caixa, recalculados de forma idempotente
   (ver [REGRAS_FINANCEIRAS.md](REGRAS_FINANCEIRAS.md)).
4. **Entradas não confiáveis**: corpo, query, mensagens e saídas de IA são validados com Zod antes de
   chegar aos serviços.
5. **Pendência em vez de suposição**: em caso de dúvida (ambiguidade, duplicidade, falha de
   transcrição, regra que não casou), o sistema cria um `PendingItem` e pergunta.
6. **Histórico**: exclusões são lógicas e toda alteração gera um `AuditLog` (antes/depois, ator,
   origem).
7. **Tempo real**: cada alteração publica um evento por família (Redis pub/sub). O painel recebe por
   SSE e invalida só as consultas afetadas (`EVENT_INVALIDATIONS`), sem recarregar a página.

## Modelo de dados (principais tabelas)

| Grupo | Tabelas |
|---|---|
| Identidade | `User`, `Session`, `Household`, `HouseholdSettings`, `HouseholdMember`, `Invitation` |
| Finanças | `Account`, `CreditCard`, `CreditCardStatement`, `Category`, `Subcategory`, `Merchant`, `FinancialRule`, `Transaction`, `TransactionAllocation`, `LedgerEntry`, `Installment` |
| Planejamento | `RecurringTransaction`, `ScheduledPayment`, `Budget`, `BudgetAlert`, `FinancialGoal`, `GoalContribution` |
| WhatsApp | `WhatsAppConnection`, `WhatsAppAuthState` (criptografado), `WhatsAppConnectionEvent`, `WhatsAppGroup`, `WhatsAppMessage`, `MessageProcessingJob`, `Attachment` |
| IA | `Clarification`, `AssistantConversation`, `AssistantMessage`, `AIProcessingLog`, `AIProviderCredential` (criptografado), `AITaskConfig` |
| Operação | `Notification`, `NotificationPreference`, `PendingItem`, `AuditLog`, `ImportBatch`, `ImportRow`, `ReportSchedule`, `Report`, `BackupRecord` |

Restrições importantes no banco:

- `Transaction(sourceMessageId, sourceIndex)` único: uma mensagem nunca gera o mesmo item duas vezes.
- `WhatsAppMessage(connectionId, externalId)` único: entrega repetida do WhatsApp é ignorada.
- `Attachment(householdId, sha256)` único: o mesmo comprovante não é processado duas vezes.
- `CHECK`s de valores positivos, dias de fechamento/vencimento válidos etc.

## Processamento de mensagens

1. **Ingestão** (`src/server/whatsapp/ingest.ts`): só aceita mensagens do **grupo selecionado**, de
   **remetentes autorizados** e com o **consentimento** registrado. Grava a mensagem (idempotente)
   e enfileira o processamento. Outras conversas não são lidas.
2. **Fila** `whatsapp-inbound` (BullMQ): tentativas com backoff exponencial. Falhas definitivas viram
   pendência com o botão "Reprocessar".
3. **Pipeline** (`src/server/ai/pipeline/handle-message.ts`): baixa a mídia → transcreve ou lê o
   comprovante → interpreta → valida → executa via serviços.
4. **Resposta** (fila `whatsapp-outbound`): confirma o que foi registrado, pede confirmação ou faz
   uma pergunta. As respostas usam o prefixo `WHATSAPP_BOT_PREFIX` e nunca são reprocessadas.
