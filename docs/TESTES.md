# Testes

| Tipo | Ferramenta | Pasta | O que cobre |
|---|---|---|---|
| Unitários | Vitest | `tests/unit` | Regras puras: dinheiro, faturamento de cartão, NLU em português (valores, datas, intenções), importadores (CSV/OFX/XLSX/PDF, com layouts sintéticos de 8 bancos), agenda de recorrências, telefones e fronteiras do WhatsApp |
| Integração | Vitest + PostgreSQL real | `tests/integration` | Serviços de domínio, pipeline de IA, WhatsApp (ingestão, fila, recuperação), relatórios, importação, backups, LGPD e rotas da API |
| End-to-end | Playwright | `tests/e2e` | Fluxos no navegador: cadastro/login, lançamento em linguagem natural, dashboard, assistente, isolamento entre famílias, mensagem pelo simulador de WhatsApp → lançamento + resposta, e layout no celular |

## Como rodar

```bash
pnpm test:unit

# Integração: usa um banco PRÓPRIO, que é apagado a cada teste.
# Padrão: postgresql://finance:finance@localhost:5432/finance_ai_test
createdb -h localhost -U finance finance_ai_test      # uma vez
pnpm test:integration
# outro banco: TEST_DATABASE_URL=postgresql://.../meu_banco_de_teste pnpm test:integration

# End-to-end: sobe o painel na porta 3200 com o banco finance_ai_e2e (recriado a cada execução).
createdb -h localhost -U finance finance_ai_e2e       # uma vez
pnpm test:e2e
# com Chromium instalado em outro caminho: PW_CHROMIUM_PATH=/caminho/chromium pnpm test:e2e
# contra um servidor já em execução (ex.: a imagem de produção), com ALLOW_REGISTRATION=true e
# RATE_LIMIT_REGISTER_PER_HOUR alto e OPEN_FINANCE_SIMULATOR=true: E2E_BASE_URL=http://localhost:3200 pnpm test:e2e
```

Os testes de integração e e2e precisam de PostgreSQL 16 e Redis 7 em execução (ex.:
`docker compose up -d postgres redis` com as portas publicadas; ver [INSTALACAO.md](INSTALACAO.md)).

Nos testes, os provedores externos (LLM, transcrição e visão) são substituídos por dublês que
devolvem saídas controladas, inclusive maliciosas. Todo o resto é o código real: consentimento,
validação, resolução de referências, serviços e banco.

## Cenários obrigatórios

| # | Cenário | Onde é testado |
|---|---|---|
| 1 | Criar despesa por texto | `ai-pipeline.test.ts` › "despesa por texto…" · e2e `finance-flow.spec.ts` e `whatsapp-simulator.spec.ts` |
| 2 | Criar receita por texto | `ai-pipeline.test.ts` › "receita por texto: 'recebi 3500 de salário'…" |
| 3 | Criar despesa por áudio | `ai-pipeline.test.ts` › "áudio: sem consentimento nada é enviado… após autorizar, o reprocessamento transcreve e lança" e "servidor de transcrição na rede local…" |
| 4 | Múltiplas despesas em um áudio | `ai-pipeline.test.ts` › "áudio com vários gastos → 3 lançamentos com sourceIndex distintos" |
| 5 | Processar comprovante | `ai-pipeline.test.ts` › "comprovante: … o número completo do cartão nunca é armazenado", "comprovante repetido (mesmo SHA-256)", "comprovante sem consentimento para imagens" · `whatsapp-ingest.test.ts` › "mídia: grava Attachment criptografado…" |
| 6 | Identificar categoria | `ai-pipeline.test.ts` › "identifica a categoria por palavras-chave…" · `local-engine.test.ts` · `ai-follow-ups.test.ts` (pergunta a categoria que faltou, cria e aprende) |
| 7 | Confirmação de informação ambígua | `ai-pipeline.test.ts` › "mensagem sem valor…", "conta/cartão ambíguos…", "correção ambígua…" · `ai-follow-ups.test.ts` (categoria e conta perguntadas uma por vez) · e2e "mensagem sem valor não pode ser confirmada" |
| 8 | Impedir duplicidade | `ai-pipeline.test.ts` › "o mesmo evento do WhatsApp entregue duas vezes", "mensagem quase idêntica minutos depois → suspeita de duplicidade" · `whatsapp-ingest.test.ts` › "evento repetido não duplica…" · `bills.test.ts` › "encontra a conta prevista para evitar duplicidade…" |
| 9 | Corrigir transação | `ai-pipeline.test.ts` › "correção ('na verdade foi 50' / 'corrige o último para 35')…" · `ledger.test.ts` › "edição atualiza corretamente" |
| 10 | Excluir e restaurar | `ledger.test.ts` › "exclusão lógica e restauração preservam o saldo" · `ai-pipeline.test.ts` › "exclusão por mensagem é lógica e restaurável…; exclusão em massa é recusada" |
| 11 | Compra parcelada | `ledger.test.ts` › "compra parcelada gera faturas futuras…", "alterar o número de parcelas recalcula as faturas" · `billing.test.ts` |
| 12 | Gerar faturas futuras | `ledger.test.ts` (idem) · `billing.test.ts` |
| 13 | Pagar fatura sem duplicar despesas | `ledger.test.ts` › "…o pagamento da fatura não duplica despesa" · `reports.test.ts` › "…sem dupla contagem do pagamento de fatura" |
| 14 | Transferir entre contas | `ledger.test.ts` › "transferência entre contas não é receita nem despesa" · `goals.test.ts` › "contribuição com transferência…" · `transfers-investments.test.ts` (aplicação/resgate na importação, regra aprendida, conversão do que já foi importado sem duplicar) · `whatsapp-investments.test.ts` · `own-moves.test.ts` |
| 15 | Criar e acompanhar metas | `goals.test.ts` (6 testes) |
| 16 | Processar despesas recorrentes | `recurring.test.ts` (7 testes) · `recurring-schedule.test.ts` · `bills.test.ts` |
| 17 | Recalcular saldos | `ledger.test.ts` › "recalcula saldos e verifica integridade" · e2e `finance-flow.spec.ts` (saldo após lançamentos) |
| 18 | Consultar despesas por IA | `ai-pipeline-guards.test.ts` › "'quanto gastamos com mercado este mês?' responde com o total confirmado do banco…" · e2e "assistente responde com os dados da família" |
| 19 | Restringir acesso entre famílias | `ledger.test.ts` › "isola os dados entre famílias" · `ai-pipeline-guards.test.ts` › "mensagens da família A nunca leem nem alteram dados da família B", "referências forjadas…" · `imports.test.ts`, `goals.test.ts`, `exports.test.ts` · e2e "dados de outra família não aparecem" |
| 20 | Recuperar processamento após falha | `whatsapp-processor.test.ts` › "falha → novas tentativas com backoff…", "recoverStuckJobs…" · `whatsapp-redis-down.test.ts` · `ai-pipeline.test.ts` › "falha transitória depois de gravar o lançamento → … sem duplicar" |
| 21 | Conciliar registros importados | `imports.test.ts` › "OFX bancário: correspondência com lançamento do WhatsApp, divergência, novos, commit e undo…" e mais 4 · `imports-pdf.test.ts` (PDF, destino automático, confirmar todos sem duplicar entre arquivos, senha, digitalizado com IA) · `whatsapp-pdf-import.test.ts` (PDFs pelo WhatsApp com confirmação na conversa) · `pdf-statement.test.ts` |
| 22 | Proteger contra mensagens maliciosas | `ai-pipeline-guards.test.ts` › "motor local: injeção de instruções, SQL e 'definir saldo'…", "LLM: valor que não está na mensagem…", "LLM: … de outra família não são aceitos", "LLM: exclusão em massa…", "LLM: valor alto … não é registrado automaticamente", "LLM: saída fora do esquema…" |

Outras coberturas além dos 22 cenários:

- rendimento automático de investimentos: `investment-yield.test.ts` (unitário: CDI/prefixado/IPCA+,
  aplicações no meio do mês, IR/IOF) e `investment-yield.test.ts` (integração: Banco Central simulado,
  idempotência, BCB fora do ar, exclusão respeitada, ajuste ao saldo do banco);
- edições parciais não reaplicam valores padrão: `partial-updates.test.ts`.
- notificações e metas: `notifications-goals.test.ts` (relógio controlado: faixas da meta de ganho
  — só a maior nova, 🎉 batida, ritmo no dia 25, repasse fora, por categoria, preferência desligada —,
  metas de economia — faixas, prazo de 30/7 dias abaixo do esperado, conclusão, meta antiga sem aviso
  atrasado —, conta vencida — dia seguinte, a cada 3 dias até 15, "pagar depois", "já paguei" —, fatura
  perto de vencer / no dia / vencida, uma vez cada, WhatsApp ligado por padrão; WhatsApp "meta de ganho
  da empresa 30 mil" e "quanto falta pra meta?"), `income-goal-commands.test.ts` (unitário) e e2e
  `notifications-popups.spec.ts` (pop-ups ao abrir o app, no máximo 3, preferência respeitada);
- confirmar fatura: `card-review.test.ts` (2 compras "Não importar", uma parcelada → total do arquivo ×
  app e diferença, saldo, ledger, faturas por mês, parcelas futuras e relatórios conferidos antes/depois;
  desfazer volta tudo; regra "sempre não importar" oferecida após 2 marcações, dispensar/aceitar, próxima
  fatura já desmarcada; conferência opcional das saídas de uma conta) e e2e `card-review.spec.ts`;
- migrar de planilha: `spreadsheet-migration.test.ts` (planilha "bagunçada" com várias contas, cartão,
  natureza, parcelas 3/10 e 10x, linhas de total e nomes diferentes dos do app → De → Para → prévia por
  destino → importar, conferindo saldos, faturas, parcelas e contagens → desfazer e voltar exatamente ao
  estado anterior; abas mensais com o mês no nome e formato lembrado; matriz categorias × meses como
  orçamento e como totais mensais; voltar/descartar; validações), `whatsapp-spreadsheet.test.ts`
  (planilha no grupo → link do assistente), `migration-readers.test.ts` (.xlsx/.xls/.ods/.csv, HTML e XML
  2003, arquivos inválidos e "bomba") e `migration-logic.test.ts` (colunas extras, meses, sugestões,
  parcelas, contas a pagar, formato lembrado). Planilhas em `tests/fixtures/migration/`
  (geradas por `scripts/build-migration-fixtures.ts`).
- desconsiderar nos relatórios (repasse de cliente): `report-exclusion.test.ts` (saldo, ledger, parcelas,
  fatura e projeção idênticos antes/depois; relatórios em competência e caixa; orçamento; lista e
  filtros; saldo do repasse; regra com condição de cartão aplicada aos novos e anteriores; desfazer),
  `whatsapp-report-exclusion.test.ts` (citação da confirmação do robô, "o pix do fulano é repasse",
  "todos", "considerar de novo", natureza Empresa/Pessoal e pergunta da regra) e
  `report-exclusion-nlu.test.ts` (frases);
- natureza Pessoal/Empresa/Repasse: `transaction-nature.test.ts` (caixa e fatura idênticos, recortes
  Pessoal/Empresa/Tudo e padrão da família, resultado da empresa, regras definir/perguntar com valor
  mínimo no cartão, prévia da importação com "aplicar às parecidas").
- vários grupos com natureza: `whatsapp-group-nature.test.ts` (grupo da empresa, mensagem > regra >
  grupo, "1 PF / 2 Empresa" no grupo não atribuído sem mudar saldo/ledger/fatura, padrão da família,
  PF e PJ na mesma mensagem, perguntas no recorte do grupo e divisão PF/Empresa, resposta no grupo de
  origem) e `nature-tokens.test.ts` (frases com empresa/PJ/PF/pessoa física);
- criar categoria fácil: `whatsapp-category-commands.test.ts` (comandos, oferta sim/não, criação rápida
  que reaproveita a existente/arquivada) e `category-commands.test.ts` (frases);
- convite de nova família: `household-invites.test.ts` (administrador da instância, uso único com
  cadastro fechado, cadastros simultâneos, expirado/revogado, dados separados);
  `whatsapp-two-connections.test.ts` (duas conexões Baileys no mesmo worker sem misturar QR,
  credenciais, grupos e mensagens);
- transcrição em servidor pequeno: `transcription-limits.test.ts` (uma por vez, áudio longo demais
  recusado antes de enviar, tempo limite, 413 do servidor, download do modelo no speaches) e
  `docker/whisper/test_server.py` (servidor Python com modelo falso: beam 5/pt, fila, 413, descarga por
  ociosidade, erro claro sem o modelo — instruções no topo do arquivo); `transcript-normalize.test.ts`
  (frases reais do Whisper: "proí caro em presa", "no banque, pessoal", "R$ 750", sem trocar "no
  banco", "ficou caro" ou "personal trainer");
- corrigir/cancelar o último lançamento: `whatsapp-last-transaction.test.ts` (áudio "revirante" → "é
  refrigerante" → par aprendido → próximo áudio certo; cancela/volta/desfaz com saldo, ledger e fatura
  iguais antes e depois; valor/forma/categoria na janela; fora da janela pergunta qual; citação; pergunta
  de categoria aberta) e `last-tx-commands.test.ts` (frases);
- gastos fixos: `fixed-expenses.test.ts` (recorrências, parcelas em andamento conferidas com as parcelas
  do banco, projeção, recortes Pessoal/Empresa/Tudo sem Repasse, fatura por categoria e por natureza,
  cartões atual/anterior, filtro por forma de pagamento/cartão).

## Boas práticas para novos testes

- Teste regras financeiras pelo **estado do banco** (transações, ledger, parcelas, saldos), não só pelo
  retorno das funções.
- Use `createFamily()` / `createWaFamily()` dos helpers. Cada teste começa com o banco limpo
  (`resetDatabase()`).
- Não enfraqueça asserções para o teste passar. Se o comportamento estiver errado, corrija o serviço.
