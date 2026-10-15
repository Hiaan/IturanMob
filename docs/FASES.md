# Fases do projeto e critérios de aceite

Cada fase tem critérios objetivos, verificados por testes automatizados (unitários, de integração ou
e2e) ou por um procedimento manual descrito aqui. "✅" = critério atendido e verificado nesta versão.

## Fase 1: Fundação

| Critério | Verificação | |
|---|---|---|
| Cadastro da família cria proprietário, preferências e categorias padrão | `tests/integration/ledger.test.ts` (helpers) e e2e `auth.spec.ts` | ✅ |
| Login/logout com sessão segura, bloqueio após 8 falhas, rate limit | e2e `auth.spec.ts`, revisão de `src/server/auth` | ✅ |
| Contas com saldo inicial; saldo sempre derivado do ledger | `ledger.test.ts` → "recalcula saldos" | ✅ |
| Transação criar/editar/excluir/restaurar com auditoria | `ledger.test.ts`, `ai-pipeline.test.ts` | ✅ |
| Isolamento entre famílias em todas as consultas | `ledger.test.ts` → "isolamento", `ai-pipeline*.test.ts` | ✅ |
| Dashboard inicial com dados reais e estados vazios | e2e `finance-flow.spec.ts` | ✅ |

## Fase 2: WhatsApp

| Critério | Verificação | |
|---|---|---|
| Adaptador com provedores intercambiáveis (simulador, Cloud API, Baileys) | `whatsapp-*.test.ts`, `docs/WHATSAPP.md` | ✅ |
| QR Code exibido quando o provedor suporta, com aviso de risco do modo não oficial | Integrações → WhatsApp | ✅ |
| Somente o grupo selecionado e remetentes autorizados com consentimento são processados | `whatsapp-ingest.test.ts` | ✅ |
| Processamento assíncrono com fila, tentativas e recuperação após falha | `whatsapp-processor.test.ts`, `whatsapp-redis-down.test.ts` | ✅ |
| Mensagem de texto vira lançamento e recebe confirmação no grupo | `whatsapp-processor.test.ts`, e2e `whatsapp-simulator.spec.ts` | ✅ |
| Entrega repetida da mesma mensagem não duplica | `whatsapp-ingest.test.ts`, `ai-pipeline.test.ts` | ✅ |

## Fase 3: Inteligência artificial

| Critério | Verificação | |
|---|---|---|
| Interpretação em pt-BR: valores (inclusive por extenso), datas relativas, parcelas, pessoas, contas, cartões | `nlu-*.test.ts`, `local-engine.test.ts` | ✅ |
| Classificação automática por categoria/subcategoria e regras da família | `local-engine.test.ts`, `ai-pipeline.test.ts` | ✅ |
| Extração estruturada validada por esquema; valor precisa constar na mensagem | `ai-pipeline-guards.test.ts` | ✅ |
| Confiança → automático / confirmação / esclarecimento | `ai-pipeline.test.ts` | ✅ |
| Correção e exclusão de um lançamento por mensagem; exclusão em massa recusada | `ai-pipeline.test.ts` | ✅ |
| Provedores Anthropic/OpenAI/compatível configuráveis por tarefa, com fallback local | Integrações → IA; `ai-pipeline-guards.test.ts` | ✅ |

## Fase 4: Áudio e comprovantes

| Critério | Verificação | |
|---|---|---|
| Áudio transcrito (API compatível com Whisper) e interpretado; várias despesas por áudio | `ai-pipeline.test.ts` (transcrição simulada no teste) | ✅ |
| Foto de comprovante lida por modelo de visão; dados sensíveis do cartão descartados | `ai-pipeline.test.ts` (visão simulada no teste) | ✅ |
| Comprovante repetido não gera novo lançamento | `ai-pipeline.test.ts` | ✅ |
| Falhas (sem transcrição, imagem ilegível, provedor fora) viram pendência explicada | `ai-pipeline.test.ts`, Pendências | ✅ |

> A transcrição e a visão reais dependem de credenciais (ou do perfil `whisper`). Nos testes, os
> provedores externos são substituídos por dublês. Nenhum teste simula estar conectado a um serviço real.

## Fase 5: Gestão avançada

| Critério | Verificação | |
|---|---|---|
| Cartões com fechamento/vencimento; compra na fatura correta | `billing.test.ts` | ✅ |
| Parcelamentos e faturas futuras; centavos de resto na 1ª parcela | `billing.test.ts`, `ledger.test.ts` | ✅ |
| Pagar fatura não duplica despesas | `ledger.test.ts` | ✅ |
| Transferências soma zero, fora de receitas/despesas | `ledger.test.ts` | ✅ |
| Orçamentos com alertas por limiar, uma vez por mês | `budgets.test.ts` | ✅ |
| Metas com contribuições/resgates (alocação ou transferência) | `goals.test.ts` | ✅ |
| Recorrências geram ocorrências; lançamento automático; contas a pagar | `recurring.test.ts`, `recurring-schedule.test.ts`, `bills.test.ts` | ✅ |

## Fase 6: Dashboards e relatórios

| Critério | Verificação | |
|---|---|---|
| Gráficos (categorias, mensal, pessoas, formas de pagamento, orçamento, fluxo) com alternativa em tabela | Dashboard; e2e `finance-flow.spec.ts` | ✅ |
| Filtros (período, pessoa, conta, cartão, categoria, regime) | Dashboard | ✅ |
| Comparativos com origem do cálculo | `/api/v1/analytics/compare`, Relatórios | ✅ |
| Relatórios semanal/mensal com PDF/XLSX/CSV e agendamento | `reports.test.ts`, `exports.test.ts` | ✅ |
| Importação CSV/OFX/XLSX com conciliação e desfazer | `imports.test.ts`, `import-parsers.test.ts` | ✅ |
| Atualização em tempo real sem recarregar a página | SSE `/api/v1/events` + invalidação por evento | ✅ |

## Fase 7: Assistente financeiro

| Critério | Verificação | |
|---|---|---|
| Chat no painel e perguntas pelo grupo | Assistente IA; `ai-pipeline.test.ts` (consulta) | ✅ |
| Ferramentas somente leitura validadas; sem SQL gerado por IA | `src/server/ai/assistant/tools.ts`; `ai-pipeline-guards.test.ts` | ✅ |
| Respostas mostram período e origem; não afirmam hábitos sem dados | `local-engine.test.ts`, análise de gastos atípicos | ✅ |
| Projeção de fluxo de caixa com hipóteses e incerteza | `/api/v1/analytics/cashflow` | ✅ |

## Fase 8: Finalização

| Critério | Verificação | |
|---|---|---|
| Testes unitários, de integração e e2e dos fluxos críticos (22 cenários obrigatórios) | [TESTES.md](TESTES.md) | ✅ |
| Segurança: CSRF, rate limit, criptografia, redação de logs, permissões | [SEGURANCA.md](SEGURANCA.md) | ✅ |
| Logs estruturados e health check | `/api/health`, pino | ✅ |
| Backups automáticos com verificação de integridade | `backups.test.ts` | ✅ |
| Docker Compose (postgres, redis, migrate, web, worker + opcionais) e `.env.example` | `docker-compose.yml`, `Dockerfile` | ✅ |
| Documentação: instalação, configuração, execução, deploy | `docs/` | ✅ |

## Verificação desta versão

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` (TypeScript estrito, projeto inteiro) | 0 erros |
| `pnpm test` (unitários + integração, PostgreSQL e Redis reais) | 28 arquivos, **314 testes** passando (173 unitários + 141 de integração) |
| `pnpm test:e2e` (Playwright, servidor de desenvolvimento) | **9 testes** passando |
| e2e contra o build de produção (contêiner standalone) | 9 testes passando |
| Build Docker (`pnpm install`, `next build`, `pnpm prune --prod`) dentro do contêiner | OK |
| Contêiner web de produção: páginas, 47 rotas GET da API, relatórios PDF/XLSX/CSV, exportação integral, recálculo do ledger | OK, sem erros no log |
| Worker com dependências de produção: heartbeat, tarefas periódicas, encerramento gracioso | OK |
| `docker compose config` (incluindo os perfis `whisper` e `ollama`) | válido |

O passo `apk add` das imagens (ffmpeg, pg_dump 16, tini) não pôde ser executado no ambiente em que
este projeto foi desenvolvido, porque a rede bloqueava o repositório de pacotes do Alpine. O restante
da imagem foi construído e testado. Em uma máquina com acesso normal à internet,
`docker compose up -d --build` executa todos os passos.

## Pendências conhecidas e limites

- **WhatsApp real**: os modos Cloud API e QR Code foram implementados contra a documentação e as
  bibliotecas, e testados com dublês. Validar com um número real depende das suas credenciais (Cloud
  API) ou de um aparelho (QR Code).
- **Transcrição e visão reais**: dependem de chave (OpenAI/Anthropic) ou do perfil `whisper`.
- **Restauração de backup JSON** (gerado quando não há `pg_dump`) exige script dedicado. O caminho
  recomendado é o `pg_dump` (já incluído na imagem Docker).
- **Notificações push** (navegador/celular) não foram implementadas. Os canais são o app e o WhatsApp.
- **Cloud API fora da janela de 24 h**: a Meta exige *templates* aprovados, que não foram
  implementados. Envios fora da janela ficam registrados como falha.
- **Falha transitória em um dos itens** de uma mensagem com vários lançamentos: a resposta informa a
  falha, mas a mensagem não é reprocessada sozinha. O botão "Reprocessar" refaz só o que faltou
  (idempotente).
- **Parcela atual** ("3/6") na lista de transações é calculada no navegador com a mesma regra do
  servidor. O ideal é a API devolver esse número.
