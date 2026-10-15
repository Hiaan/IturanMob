# Convenções de código — Finance AI

Este documento descreve os padrões que **todo** módulo segue. Leia antes de alterar o código.

## Estrutura

```
prisma/                 schema.prisma, migrations, seed
src/
  app/                  Next.js (App Router): páginas e rotas de API
    (auth)/             login, cadastro, convite
    (app)/              área autenticada (shell com sidebar)
    api/v1/**           API REST interna (route handlers finos)
  components/ui/        componentes base (estilo shadcn/ui)
  components/           componentes compartilhados (layout, gráficos, formulários)
  features/<módulo>/    hooks TanStack Query e componentes de cada módulo (cliente)
  lib/                  utilitários puros compartilhados (dinheiro, datas, rótulos)
  server/               código exclusivamente de servidor
    auth/               sessão, contexto, permissões
    api/                wrapper das rotas (auth, CSRF, Zod, rate limit, erros)
    modules/<módulo>/   regras de negócio (service.ts, schemas, jobs.ts)
    ai/                 Financial Intelligence Engine (NLU local + provedores)
    whatsapp/           provedores, conexão, ingestão, envio
    jobs/               filas e tarefas periódicas
    storage/            arquivos criptografados em repouso
  worker/               processo do worker (WhatsApp + filas + agendador)
tests/unit|integration|e2e
```

## Regras fundamentais

1. **Dinheiro em centavos (`Int`)**. Use `src/lib/money.ts` (`formatBRL`, `parseAmountToCents`, `splitEvenly`). Nunca `float` para cálculo.
2. **Datas de calendário** são strings ISO `YYYY-MM-DD` na aplicação e `@db.Date` no banco (meia-noite UTC). Use `src/lib/dates.ts` (`isoToDate`, `dateToISO`, `todayISO(tz)`). "Hoje" é sempre calculado no fuso da família (`ctx.timezone`).
3. **Contexto de serviço** (`ServiceContext`): toda função de domínio recebe `ctx` e filtra por `ctx.householdId`. Isso garante o isolamento entre famílias. Processos do sistema usam `systemContext(householdId)`.
4. **Permissões**: `assertCan(ctx, "permissão")` no início das operações de escrita (`src/server/auth/permissions.ts`).
5. **Visibilidade**: contas/cartões privados são filtrados via `src/server/modules/visibility/scope.ts`.
6. **Transações financeiras** só são criadas/alteradas por `src/server/modules/transactions/service.ts` (`createTransaction`, `updateTransaction`, `deleteTransaction`, `restoreTransaction`, `confirmTransaction`). Esse serviço valida, gera o ledger (`LedgerEntry`) e as parcelas (`Installment`), cria pendências automáticas e registra auditoria. **Nunca** escreva diretamente nas tabelas `Transaction`, `LedgerEntry` ou `Installment`.
7. **Auditoria**: alterações relevantes chamam `audit(ctx, {...}, db)` (`src/server/modules/audit/service.ts`).
8. **Tempo real**: após mutações, `publishEvent(householdId, "<tipo>.changed", id)` (`src/server/events.ts`). Os eventos não carregam conteúdo sensível.
9. **Pendências**: situações que exigem atenção humana viram `PendingItem` via `createPendingItem` (`src/server/modules/pending/service.ts`). Nada falha silenciosamente.
10. **Validação**: entradas de API são validadas com Zod (schemas exportados pelos módulos). Erros de domínio usam as classes de `src/server/errors.ts` (mensagens em português).
11. **Logs**: `logger` de `src/server/logger.ts`. Nunca registre tokens, senhas, chaves, conteúdo de mensagens, transcrições ou dados financeiros detalhados.
12. **Segredos**: somente via variáveis de ambiente (`env()` de `src/server/env.ts`) ou criptografados no banco (`encryptString`).

## Rotas de API

Use os wrappers de `src/server/api/handler.ts`:

```ts
export const GET = authed({ query: schema }, async ({ ctx, query }) => service(ctx, query));
export const POST = authed({ body: schema, permission: "x:write" }, async ({ ctx, body }) => create(ctx, body));
```

- Resposta de sucesso: `{ data: ... }`. Erro: `{ error: { code, message, details } }`.
- Consultas complexas podem ser enviadas como JSON no parâmetro `q` (`?q={"start":"2026-10-01"}`).
- Mutações exigem mesma origem (proteção CSRF) e sessão válida (cookie httpOnly `fa_session`).

## Tarefas periódicas

`src/server/jobs/periodic.ts` lista as tarefas executadas pelo worker. Cada módulo exporta sua função em `src/server/modules/<módulo>/jobs.ts`. Todas devem ser **idempotentes**.

## Testes

- Unitários: `tests/unit/**/*.test.ts` (funções puras).
- Integração: `tests/integration/**/*.test.ts` — usam um PostgreSQL real (`TEST_DATABASE_URL`), limpam o banco com `resetDatabase()` e criam famílias com `createFamily()` (`tests/integration/helpers.ts`).
- E2E: `tests/e2e/**/*.spec.ts` (Playwright).

```bash
pnpm test                       # unit + integration
pnpm test:unit
TEST_DATABASE_URL=... pnpm test:integration
```
