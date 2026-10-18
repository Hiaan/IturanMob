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
  extratos e faturas (CSV, OFX, XLSX e PDF — também pelo WhatsApp), vários arquivos de uma vez com
  deduplicação entre eles, conciliação, exportação integral e backups verificáveis.
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
| WhatsApp | **Simulador** de desenvolvimento, identificado como tal na interface | Cloud API oficial da Meta (conversas diretas, sem grupo) ou QR Code via Baileys (lê o grupo; **não oficial**, com risco de bloqueio do número) |
| IA de texto | Motor local em português | Anthropic, OpenAI ou servidor compatível |
| Transcrição | Áudio vira pendência ("digite o lançamento") | OpenAI Whisper ou servidor local (`--profile whisper`) |
| Leitura de comprovantes | Usa a legenda da foto; o resto vira pendência | Modelo com visão (Anthropic/OpenAI) |

O uso de qualquer provedor externo depende de autorização explícita da família em
**Configurações → Privacidade e IA**.

### Transcrição própria (Whisper no Docker)

Para os áudios do WhatsApp sem enviar nada a terceiros: `docker compose --profile whisper up -d --build`
e, no `.env`, `TRANSCRIPTION_PROVIDER=openai_compatible`, `TRANSCRIPTION_BASE_URL=http://whisper:8000/v1`
e `WHISPER_MODEL` (padrão `base`). O serviço (`docker/whisper`, faster-whisper) fica só na rede
interna (sem porta publicada) e, por ser host privado, não exige o consentimento de envio externo. Em
Configurações → IA, a transcrição em "Local" usa esse servidor; o texto transcrito segue exatamente o
mesmo fluxo de uma mensagem de texto. Sem transcrição (ou se ela falhar), o bot responde no grupo com o
motivo curto.

Feito para dividir um servidor pequeno (ex.: 4 GB / 2 vCPU) com outros serviços:

- CPU, `int8`, beam 1, idioma `pt`, **1 thread** e `cpus: 1.0` — nunca usa os 2 núcleos; prioridade
  baixa (`nice` + `cpu_shares`) e, sob falta de memória, é o primeiro a ser encerrado (reinicia sozinho).
- Memória fixa em `WHISPER_MEM_LIMIT` (padrão `900m`), sem swap.
- **Uma transcrição por vez** (no worker e no servidor); as outras esperam na fila.
- Nada é baixado na partida: o modelo vem no **primeiro áudio** e fica no volume `whisper-cache`
  (para baixar antes: `docker compose --profile whisper run --rm whisper python server.py --download`).
- Sem uso por 10 min (`WHISPER_IDLE_UNLOAD_SECONDS=600`), o modelo sai da memória; o próximo áudio
  carrega de novo.
- Tempo limite de 120 s por transcrição (`TRANSCRIPTION_TIMEOUT_MS`); áudio acima de 5 min
  (`TRANSCRIPTION_MAX_SECONDS=300`) recebe "Esse áudio tem X min — passa do limite… pode mandar em
  partes menores ou por texto?".

Estimativa para 2 vCPU com o limite de 1 núcleo (faster-whisper int8, beam 1). **Não foi medido no
seu servidor** — confira com `docker compose logs whisper` ("áudio de 60s transcrito em 14.2s") e
`docker stats`:

| `WHISPER_MODEL` | RAM parado | RAM transcrevendo | `WHISPER_MEM_LIMIT` | Tempo por minuto de áudio | Download (cache) |
|---|---|---|---|---|---|
| `base` (padrão) | ~35 MB (modelo descarregado) | ~300–450 MB | `900m` | ~10–25 s | ~145 MB |
| `small` | ~35 MB (modelo descarregado) | ~650–1.000 MB | `1500m` | ~30–70 s | ~480 MB |

- O primeiro áudio depois de o modelo sair da memória leva alguns segundos a mais para carregar (base
  ~2–5 s, small ~5–10 s); o primeiríssimo inclui o download.
- Instâncias com CPU "burstable" (ex.: Lightsail) ficam mais lentas quando os créditos de CPU acabam.
- `small` transcreve melhor nomes e valores, mas com `TRANSCRIPTION_TIMEOUT_MS=120000` áudios de 2 min
  podem passar do limite em CPU lenta; aumente o tempo limite junto com a memória.

## Licença

Uso privado.
