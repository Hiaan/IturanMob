# Finance AI

**Gestão financeira familiar com WhatsApp e inteligência artificial.**

O casal registra os gastos no grupo privado da família no WhatsApp, por texto, áudio ou foto do
comprovante. O sistema interpreta a mensagem, valida, registra e confirma no próprio grupo. O painel
web reúne saldos, cartões, faturas, orçamentos, metas, contas a pagar, relatórios e um assistente que
responde perguntas sobre os dados da família.

```
"gastei 283,90 no mercado no cartão nubank em 3x"
🤖 Registrado: Supermercado · R$ 283,90 em 3x de R$ 94,64 no Nubank Crédito (faturas de nov a jan).
```

## Funcionalidades

- **WhatsApp como canal principal**: texto, áudio (transcrição compatível com Whisper) e foto de
  comprovante. Várias despesas na mesma mensagem. Correções ("na verdade foi 50"), exclusão e
  restauração. Perguntas ("quanto gastamos com mercado este mês?"). Só o grupo selecionado e os
  remetentes autorizados são processados, com consentimento.
- **IA com validação**: motor local em português (funciona sem nenhuma chave) e provedores
  Anthropic, OpenAI ou compatíveis com OpenAI (Ollama etc.).
  - Nenhuma saída de IA vai direto ao banco.
  - O valor precisa aparecer na mensagem.
  - Abaixo do limiar de confiança, o sistema pede confirmação ou esclarecimento.
  - Há proteção contra prompt injection.
- **Finanças corretas**:
  - ledger de dupla entrada derivado das transações;
  - cartão com fechamento, vencimento, faturas futuras e parcelamentos;
  - pagamento de fatura sem duplicar despesas;
  - transferências que não contam como despesa;
  - competência × caixa;
  - prevenção de duplicidade.
- **Planejamento**: orçamentos por categoria com alertas, metas com contribuições, recorrências e
  contas a pagar.
- **Painel em tempo real** (SSE): indicadores, gráficos com alternância para tabela, filtros,
  comparativos com a origem do cálculo, gastos atípicos, projeção de fluxo de caixa, busca
  inteligente e central de pendências.
- **Relatórios e dados**: relatórios semanais e mensais (PDF, CSV, XLSX), agendamento, importação de
  extratos (CSV, OFX, XLSX) com conciliação, exportação integral e backups verificáveis.
- **Segurança e LGPD**:
  - sessões seguras, CSRF, rate limit e papéis (proprietário, administrador, membro, visualizador);
  - contas privadas;
  - credenciais criptografadas (AES-256-GCM) e logs com redação de dados sensíveis;
  - auditoria completa, retenção configurável e exclusão de dados.

## Início rápido

**Com Docker** (recomendado):

```bash
cp .env.example .env
corepack enable && pnpm install && pnpm run setup   # gera os segredos (ou preencha manualmente)
docker compose up -d --build
# abra http://localhost:3000/cadastro e crie a sua família
```

**Local** (desenvolvimento, com PostgreSQL 16 e Redis 7 disponíveis):

```bash
corepack enable && pnpm install
cp .env.example .env && pnpm run setup
pnpm db:deploy
pnpm dev            # http://localhost:3000
pnpm dev:worker     # outro terminal: WhatsApp, filas e tarefas periódicas
```

Para ver o sistema com dados fictícios de demonstração: `SEED_DEMO=true pnpm db:seed`.

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/INSTALACAO.md](docs/INSTALACAO.md) | Manual de instalação e execução |
| [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md) | Manual de configuração (variáveis, IA, WhatsApp, notificações, retenção) |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Guia de deploy em produção, HTTPS, backups, atualização e monitoramento |
| [docs/WHATSAPP.md](docs/WHATSAPP.md) | Integração com WhatsApp: modos, riscos do QR Code, comandos |
| [docs/IA.md](docs/IA.md) | Motor de IA, validação, consentimento e proteção contra prompt injection |
| [docs/REGRAS_FINANCEIRAS.md](docs/REGRAS_FINANCEIRAS.md) | Regras de ledger, cartões, faturas, regimes, duplicidade e conciliação |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Arquitetura, pastas, modelo de dados e fluxo das mensagens |
| [docs/SEGURANCA.md](docs/SEGURANCA.md) | Segurança, privacidade e LGPD |
| [docs/TESTES.md](docs/TESTES.md) | Como rodar os testes e cobertura dos cenários obrigatórios |
| [docs/FASES.md](docs/FASES.md) | Fases do projeto, critérios de aceite e situação |
| [docs/CONVENCOES.md](docs/CONVENCOES.md) | Convenções de código |

## Stack

Next.js 15 (App Router) · React 19 · TypeScript estrito · Tailwind CSS 4 · componentes no estilo
shadcn/ui (Radix) · Lucide · Recharts · TanStack Query · React Hook Form + Zod · Prisma 6 ·
PostgreSQL 16 · Redis 7 + BullMQ · pino · Vitest · Playwright · Docker Compose.

## Integrações que dependem de credenciais

| Integração | Sem credencial | Com credencial |
|---|---|---|
| WhatsApp | **Simulador** de desenvolvimento, identificado como tal na interface | Cloud API oficial (Meta) ou QR Code via Baileys (**não oficial**, com risco de bloqueio do número) |
| IA de texto | Motor local em português | Anthropic, OpenAI ou servidor compatível |
| Transcrição | Áudio vira pendência ("digite o lançamento") | OpenAI Whisper ou servidor local (`--profile whisper`) |
| Leitura de comprovantes | Usa a legenda da foto; o resto vira pendência | Modelo com visão (Anthropic/OpenAI) |

O uso de qualquer provedor externo depende de autorização explícita da família em
**Configurações → Privacidade e IA**.

## Licença

Uso privado.
