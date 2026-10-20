# Integração com o WhatsApp — Finance AI

Este documento descreve a integração com o WhatsApp: provedores disponíveis, riscos, configuração,
fluxo de processamento, idempotência, recuperação e privacidade.

> **Resumo de privacidade:** somente os **grupos autorizados** da família (ou, na Cloud API, as conversas
> diretas dos **membros autorizados**) é processado. Mensagens de qualquer outro chat, ou de pessoas
> sem autorização/consentimento, são descartadas **sem persistir conteúdo**.

---

## 1. Arquitetura

```
 WhatsApp ──► Provedor (worker)            Webhook Cloud API (Next.js)
              Baileys / Simulador            /api/webhooks/whatsapp
                    │ onMessage                       │
                    ▼                                 ▼
              ingest.ts  ──  autoriza chat e remetente, idempotência, mídia (Attachment)
                    │        grava WhatsAppMessage + MessageProcessingJob (PostgreSQL)
                    ▼
        BullMQ "whatsapp-inbound" (jobId = id do MessageProcessingJob)
                    ▼
              processor.ts ── handleInboundMessage(messageId)  (motor de IA)
                    │        status/intenção/pendências; respostas →
                    ▼
        BullMQ "whatsapp-outbound" (jobId = hash do dedupeKey)
                    ▼
        outbound-consumer.ts ── provedor ativo → SOMENTE o chat autorizado
                                registra WhatsAppMessage OUTBOUND
```

- **Banco = fonte da verdade.** A BullMQ (Redis) só despacha. Se o Redis cair, os registros ficam
  `PENDING` no PostgreSQL e a recuperação (`jobs:recover`, a cada 2 min) reenfileira.
- **Rotas do Next.js não importam o Baileys.** API ⇄ worker conversam por banco (estado desejado) +
  Redis (comandos `fa:wa:commands`, QR `fa:wa:qr:{householdId}`, heartbeat `fa:worker:heartbeat`).
  Um teste unitário (`tests/unit/whatsapp-boundaries.test.ts`) garante essa fronteira.
- **Abstração:** o sistema só conhece `WhatsAppProvider` e `NormalizedInboundMessage`
  (`src/server/whatsapp/types.ts`). Trocar de provedor não exige mudanças fora de `src/server/whatsapp`.
- **O dashboard nunca depende do WhatsApp.** Se a integração cair, apenas o recebimento/envio para;
  o status e o histórico de erros ficam visíveis em Configurações › WhatsApp e uma notificação
  `WHATSAPP_CONNECTION_FAILED` é emitida em falhas persistentes.

### Arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/server/whatsapp/types.ts` | Interface `WhatsAppProvider`, `NormalizedInboundMessage`, capacidades, avisos |
| `src/server/whatsapp/baileys/{provider,auth-state}.ts` | Provedor Baileys (QR) e credenciais criptografadas no PostgreSQL |
| `src/server/whatsapp/cloud-api/{provider,webhook}.ts` | Cloud API oficial: assinatura, normalização, mídia, envio |
| `src/server/whatsapp/simulator/{provider,record}.ts` | Simulador de desenvolvimento |
| `src/server/whatsapp/connection-manager.ts` | Converge conexões, status, eventos, QR, grupos (worker) |
| `src/server/whatsapp/ingest.ts` | Ingestão (autorização, idempotência, mídia, enfileiramento) |
| `src/server/whatsapp/processor.ts` | Consumidor `whatsapp-inbound`, reprocessamento |
| `src/server/whatsapp/outbound-impl.ts` / `outbound-consumer.ts` | Fila de envio (produtor) / entrega (worker) |
| `src/server/whatsapp/recovery.ts` | `recoverStuckJobs()` |
| `src/server/whatsapp/service.ts` | Camada usada pelas rotas da API |
| `src/server/jobs/queues.ts` | Nomes e criação de filas/workers BullMQ |
| `src/worker/{index,runtime}.ts` | Processo do worker |

---

## 2. Provedores — comparação e riscos

| | **WhatsApp Business Cloud API** | **Baileys** (implementado) | **whatsapp-web.js** (não implementado) | **Simulador** |
| --- | --- | --- | --- | --- |
| Oficial / autorizado pela Meta | **Sim** | **Não** | **Não** | n/a (sem WhatsApp) |
| Número | Comercial, verificado na Meta | Número comum (lê QR Code) | Número comum (Chrome headless) | nenhum |
| Grupos | **Limitado** — mensagens chegam como conversas diretas com o número comercial | Sim (grupo da família) | Sim | Grupo simulado |
| Risco de bloqueio do número | Baixo (dentro das políticas) | **Alto** | **Alto** | nenhum |
| Estabilidade | Alta (API versionada) | Pode **quebrar** com mudanças do protocolo do WhatsApp | Pode quebrar com mudanças do WhatsApp Web | — |
| Custos | Conversas cobradas pela Meta (há franquia) | Sem custo direto | Sem custo direto | — |
| Envio fora de resposta | Só dentro da janela de 24 h (fora dela exige *templates*) | Livre (o sistema só envia ao grupo autorizado) | — | registra no banco |

**Baileys e whatsapp-web.js NÃO são oficiais nem autorizados pela Meta.** Usá-los pode levar ao
**bloqueio do número** e a integração pode **parar de funcionar** a qualquer momento após mudanças no
protocolo. A tela de status exibe esse aviso sempre que o provedor `BAILEYS` está selecionado.

### Recomendações

1. **Número dedicado** para a integração (especialmente com Baileys) — nunca o número principal.
2. **Consentimento explícito** de cada participante (campo `whatsappConsentAt`, dado pelo próprio
   membro em Membros). Sem consentimento, as mensagens da pessoa são ignoradas.
3. **Grupo exclusivo** para as finanças da família, apenas com os membros autorizados.
4. Prefira a **Cloud API oficial** quando a família tiver acesso a um número comercial.
5. Nenhum mecanismo de evasão de detecção é usado: o aparelho conectado aparece como "Finance AI",
   a presença (online) não é alterada, o histórico não é baixado, não há envio em massa nem mensagens
   a terceiros — o bot só responde no chat autorizado, com limite de taxa (1 msg/s e 30 msg/h por família).

---

## 3. Configuração

Pré-requisitos comuns: PostgreSQL e Redis em execução, migrations aplicadas e o **worker** rodando:

```bash
pnpm worker          # = npx tsx --tsconfig tsconfig.json src/worker/index.ts
pnpm dev:worker      # com recarga automática
```

O worker carrega o `.env` da raiz (sem sobrescrever variáveis já definidas), mantém o heartbeat em
`fa:worker:heartbeat` (a cada 30 s) e encerra de forma graciosa em `SIGTERM`/`SIGINT` (aguarda os jobs
em andamento, desconecta os provedores sem fazer logout). **Execute apenas um worker** por instalação:
cada sessão do WhatsApp só pode estar aberta em um processo.

Em todos os provedores, cadastre em **Membros** o número de cada participante, marque **Autorizado no
WhatsApp** (administrador) e peça para cada um dar o **consentimento** (o próprio membro). O número
brasileiro pode ser digitado só com DDD, como `(81) 99999-9999`: o sistema grava `+5581999999999`.
Números de outros países precisam começar com `+` e o DDI.

### 3.1 Simulador (desenvolvimento)

> "Simulador — nenhuma conexão real com o WhatsApp". Nada é enviado a ninguém.

1. `.env`: `WHATSAPP_ENABLE_SIMULATOR=true` (padrão) e, opcionalmente, `WHATSAPP_DEFAULT_PROVIDER=SIMULATOR`.
2. `PATCH /api/v1/integrations/whatsapp/settings {"provider":"SIMULATOR"}`.
3. `POST .../groups/sync` (cria os grupos "Finanças da Família (Simulador)" e "Empresa (Simulador)" —
   não depende do worker) e autorize-os com `PATCH .../groups/{id} {"authorized":true}` (o da empresa
   com `"defaultNature":"BUSINESS"`).
4. (Opcional) `POST .../connect` — com o worker rodando, o status fica `CONNECTED` com o aviso do simulador.
5. `POST .../simulate` com `{"memberId":"…","text":"gastei 50 no mercado"}` ou
   `{"memberId":"…","audioBase64":"…","mimeType":"audio/ogg"}` / `imageBase64` / `documentBase64`;
   `"groupId":"…"` escolhe o grupo simulado (padrão: o da família).

A simulação passa pelo **mesmo** `ingest` e pelo **mesmo** processador:
- **worker em execução** (heartbeat recente): o job vai para a fila `whatsapp-inbound` e o worker processa;
  as respostas vão para `whatsapp-outbound` e são registradas como mensagens `OUTBOUND` simuladas.
- **worker parado**: a rota processa **em linha** (`runProcessingJob(jobId, { inlineSimulator: true })`)
  e grava as respostas diretamente como mensagens `OUTBOUND` simuladas (`mode: "inline"` na resposta).

Limite prático do simulador: o corpo JSON da API aceita até ~2 MB (≈1,5 MB de arquivo em base64).

### 3.2 Baileys (WhatsApp Web, NÃO oficial)

1. Leia os riscos acima. Use um número dedicado.
2. `PATCH .../settings {"provider":"BAILEYS"}` e `POST .../connect`.
3. O worker gera o QR Code; a tela consulta `GET .../qr` (data URL gerada no servidor; 404 se não houver).
   No celular: WhatsApp › Aparelhos conectados › Conectar aparelho. O QR expira em ~60 s e é renovado;
   após ~15 QR Codes sem leitura a tentativa é encerrada (clique em Conectar de novo).
4. Ao conectar, os grupos são sincronizados automaticamente (`POST .../groups/sync` força).
   Autorize **um** grupo (`PATCH .../groups/{id}`); autorizar outro revoga o anterior.
5. Credenciais: tabela `WhatsAppAuthState`, **criptografadas** (AES-256-GCM, `ENCRYPTION_KEY`).
   Trocar a `ENCRYPTION_KEY` invalida a sessão (será preciso ler o QR de novo).
6. Reconexão automática com **backoff exponencial** (2 s → 5 min). Encerramento da sessão no celular
   (`loggedOut`) apaga as credenciais, muda o status para `LOGGED_OUT` e notifica a família.
   `POST .../logout` encerra a sessão no WhatsApp e apaga as credenciais locais.

### 3.3 WhatsApp Business Cloud API (oficial)

1. Em <https://developers.facebook.com>: crie um app do tipo *Business*, adicione o produto **WhatsApp**
   e registre/verifique o número comercial. Anote o **Phone number ID**.
2. Gere um **token de acesso permanente** (Usuário do sistema no Business Manager, permissões
   `whatsapp_business_messaging` e `whatsapp_business_management`).
3. Em *App settings › Basic*, copie o **App Secret**.
4. `.env`:
   ```
   WHATSAPP_CLOUD_ACCESS_TOKEN=...        # segredo
   WHATSAPP_CLOUD_PHONE_NUMBER_ID=...     # ou PATCH .../settings {"phoneNumberId":"..."}
   WHATSAPP_CLOUD_VERIFY_TOKEN=...        # texto aleatório escolhido por você
   WHATSAPP_CLOUD_APP_SECRET=...          # valida X-Hub-Signature-256
   WHATSAPP_CLOUD_API_VERSION=v21.0
   WHATSAPP_CLOUD_HOUSEHOLD_ID=...        # opcional: família de destino do webhook
   ```
5. Configure o webhook: URL `https://SEU_DOMINIO/api/webhooks/whatsapp`, *Verify token* =
   `WHATSAPP_CLOUD_VERIFY_TOKEN`, e assine o campo **messages**. (HTTPS público é obrigatório.)
6. `PATCH .../settings {"provider":"CLOUD_API"}` e `POST .../connect` (o worker valida as credenciais
   consultando o número na Graph API e marca `CONNECTED`).

**Chat autorizado na Cloud API:** as mensagens chegam como **conversas diretas** de cada pessoa com o
número comercial. São processadas apenas as conversas de **membros autorizados com consentimento**
(cada conversa é tratada como o "grupo da família"). Respostas vão para a conversa de quem enviou;
notificações são enviadas a cada membro autorizado. Mensagens de grupo recebidas pela Cloud API não
são processadas. Fora da janela de 24 h desde a última mensagem do membro, a Meta exige *templates*
aprovados — envios fora da janela falham e ficam registrados como `FAILED` (não implementamos templates).

Família alvo do webhook: `WHATSAPP_CLOUD_HOUSEHOLD_ID`; sem ela, a única conexão com provedor
`CLOUD_API` (havendo várias, a que tiver o `phoneNumberId` do evento).

O **recebimento** na Cloud API depende só do webhook: as mensagens dos membros autorizados são
registradas mesmo com a conexão "desconectada" (a Meta não reentrega eventos já confirmados). Para
pausar o processamento use `processingEnabled=false`; "Desconectar" interrompe apenas o envio.

---

## 4. Variáveis de ambiente

| Variável | Padrão | Uso |
| --- | --- | --- |
| `WHATSAPP_DEFAULT_PROVIDER` | `SIMULATOR` | Provedor inicial das novas conexões |
| `WHATSAPP_ENABLE_SIMULATOR` | `true` | Habilita o simulador e a rota `simulate` (desligue em produção) |
| `WHATSAPP_BOT_PREFIX` | `🤖` | Prefixo de todas as mensagens do bot (também usado para ignorar o "eco") |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | — | Token da Graph API (segredo; nunca vai ao banco) |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | — | Phone number ID (pode ser sobrescrito por família em `config.phoneNumberId`) |
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | — | Verificação do webhook (GET) |
| `WHATSAPP_CLOUD_APP_SECRET` | — | Assinatura `X-Hub-Signature-256` (POST); sem ele o webhook responde 503 |
| `WHATSAPP_CLOUD_API_VERSION` | `v21.0` | Versão da Graph API |
| `WHATSAPP_CLOUD_HOUSEHOLD_ID` | — | Família de destino do webhook |
| `WORKER_CONCURRENCY` | `2` | Concorrência do consumidor `whatsapp-inbound` (famílias diferentes em paralelo) |
| `ENCRYPTION_KEY` | — | Criptografia das credenciais do Baileys e das mídias |
| `REDIS_URL` / `DATABASE_URL` | — | Filas/QR/comandos e dados |

---

## 5. Fluxo de processamento

1. **Ingestão** (`ingestMessage(connection, msg)`):
   1. Chat: Baileys/simulador → só o `WhatsAppGroup.isAuthorized`; Cloud API → conversa direta.
      Outros chats: descartados sem persistir (apenas contador por motivo no log, sem texto).
   2. Mensagens do bot: externalId registrado no envio (memória + Redis + `WhatsAppMessage OUTBOUND`)
      ou texto `fromMe` iniciando com `WHATSAPP_BOT_PREFIX` → ignoradas.
   3. Idempotência: `(connectionId, externalId)` único — o mesmo evento nunca cria outra mensagem/job.
   4. Remetente: `HouseholdMember` com `whatsappAuthorized = true` **e** `whatsappConsentAt` preenchido,
      casado por LID, JID ou telefone E.164 (com equivalência do nono dígito brasileiro). Mensagens
      `fromMe` (o número conectado é de um dos cônjuges) são atribuídas ao dono do número conectado.
      Na primeira correspondência o JID/LID é aprendido no membro.
   5. Tipos sem relevância (figurinha, reação, vídeo, vazio) → `IGNORED`, sem job.
   6. Áudio/imagem/documento (PDF ou imagem): download (limite **16 MB**), `storeFile("media")`
      (criptografado) e `Attachment` com `retentionUntil = agora + mediaRetentionDays`
      (0 = agora, apagado pela retenção após o processamento). O mesmo SHA-256 na família **reutiliza**
      o Attachment e grava `statusDetail = "Mídia repetida: anexo <id> já recebido em <data>"` para o
      motor detectar comprovante repetido. Falha/limite no download → mensagem `FAILED` + pendência.
   7. `MessageProcessingJob(kind PROCESS_MESSAGE)` + fila `whatsapp-inbound` (jobId = id do job).
      Processamento desligado (`processingEnabled=false`) → mensagem `RECEIVED` sem job; ao religar,
      os jobs são criados (na hora pela API e também pela recuperação).
2. **Processamento** (`runProcessingJob`): claim atômico `PENDING → RUNNING` (attempts++), mensagem
   `PROCESSING`, `handleInboundMessage(messageId)`, grava `PROCESSED / IGNORED / NEEDS_CLARIFICATION / FAILED`,
   intenção, detalhe e `processedAt`. Mensagens da mesma família são processadas em ordem (trava por
   família no worker). Respostas → `enqueueOutboundMessage({kind:"reply", quotedExternalId,
   dedupeKey:"reply:<messageId>:<i>"})` se `HouseholdSettings.whatsappReplies`.
3. **Falhas:** exceção ou `retryable` → nova tentativa com backoff exponencial (30 s, 1, 2, 4… até 30 min)
   em `runAfter`; após `maxAttempts` (5) → job `DEAD`, mensagem `FAILED` e `PendingItem PROCESSING_FAILED`
   (`dedupeKey failed:<messageId>`). Resultado `FAILED` não recuperável também gera a pendência.
   **Nenhuma mensagem financeira some em silêncio.** Sucesso posterior resolve a pendência.
4. **Envio** (`whatsapp-outbound`): jobId derivado do `dedupeKey` (duplicatas ignoradas; histórico de
   7 dias), até 6 tentativas com backoff. O consumidor registra a mensagem `OUTBOUND` (`QUEUED →
   PROCESSED` ou `FAILED` com o motivo), aplica o prefixo do bot e o limite de 1 msg/s e 30 msg/h por
   família (excedente é adiado, não descartado).

**Extratos e faturas em PDF.** Um PDF enviado no grupo é lido como extrato/fatura
(`src/server/ai/engine/statement-import.ts`):

1. Gera a mesma prévia de importação do site (leitura local; IA só para PDF digitalizado, se autorizada).
2. A conta/cartão vem da legenda ("fatura do cartão ultravioleta") ou do banco identificado no PDF,
   quando há uma única opção. Na dúvida, o bot manda o link da prévia no site para escolher o destino.
3. O bot responde com o resumo (novos, já registrados, repetidos, pagamentos de fatura) e pergunta
   *confirmar* / *cancelar*. Em fatura de cartão, a resposta pede para conferir antes ("confira se há
   compras que não são suas antes de confirmar", com o link da etapa "Confirmar fatura" no site). Vários PDFs enviados em sequência entram na **mesma confirmação**, e o que se
   repete entre eles entra uma vez só. "confirmar importação" funciona mesmo depois de outra pergunta.
4. PDF com senha → pede o arquivo sem senha. PDF que parece comprovante → segue a regra de comprovantes
   (lidos em imagem). PDF sem lançamentos reconhecíveis → pendência com o motivo.
5. Reprocessar a mesma mensagem reaproveita a prévia já criada.

**Planilhas (.xlsx, .xls, .ods, .csv).** Uma planilha enviada no grupo vai para o assistente
"Migrar de planilha" do site (`src/server/ai/engine/spreadsheet-import.ts`): o bot responde com o que
leu (abas com lançamentos, abas ignoradas, nomes para conferir, formato reconhecido) e o link
`/importacao/migrar?id=…`. Nada é importado pela conversa: abas, colunas e correspondências se conferem
na tela. A mesma mensagem reprocessada devolve o link da migração já criada.

**Desconsiderar nos relatórios (repasse/reembolso).** Comandos determinísticos, sem IA
(`src/server/ai/engine/report-exclusion.ts`), que só marcam o lançamento — saldo e fatura não mudam:

- *desconsidera esse* respondendo (citando) a mensagem do lançamento **ou** a confirmação do robô → os
  lançamentos daquela mensagem. Sem citar → o último lançamento de quem escreveu (48 h).
- *o pix do Fulano é repasse*, *isso foi reembolso*, *desconsidera o pix de 500 do João*,
  *marca como repasse o anúncio do cliente X* → procura nos últimos 90 dias pelo cliente/texto/valor;
  mais de um → pergunta com números (aceita *todos*).
- *recebi 200 do Beltrano, é repasse* → registra e já desconsidera (o marcador não vira descrição).
- *considerar de novo* / *volta a considerar* / *não é repasse* → desfaz.
- A resposta lembra que saldo e fatura não mudam e, para repasse com cliente, mostra o saldo do repasse.
- *desconsidera a mensagem anterior* continua sendo excluir o último lançamento (fluxo de exclusão).
- Natureza de lançamentos já feitos: *isso é da empresa*, *marca como empresa o pix do Daniel*, *isso é
  pessoal* / *não é da empresa* (mesmas regras de alvo).

**Criar categoria pelo WhatsApp** (sem IA, `src/server/ai/engine/category-commands.ts`):
*cria categoria Pet*, *cria categoria de receita Freelas*, *nova categoria Escola dentro de Educação*,
*criar subcategoria Ração em Pet*. Nome que já existe não duplica; categoria-mãe inexistente → o bot
explica. Quando o bot pergunta a categoria de um lançamento e a resposta é um nome que não existe, ele
oferece: *Não tenho a categoria Pet. Quer que eu crie? (sim/não)* — *sim* cria, aplica e aprende
(próximos gastos parecidos já entram nela); *não* pede outra. Responder a pergunta com *cria categoria
Pet* também cria e aplica.

**Corrigir ou cancelar o último lançamento** (texto ou áudio, sem IA — `src/server/ai/nlu/last-tx.ts` e
`src/server/ai/engine/last-transaction.ts`). Vale para os lançamentos da mensagem citada (responder a
confirmação do bot) ou, sem citação, para o último lançamento de quem escreveu, neste grupo, nos
últimos 15 minutos. Fora disso, o bot pergunta qual, mostrando os 3 últimos.

- Cancelar: *cancela*, *esquece*, *apaga*, *apaga isso*, *não era pra lançar*, *lancei errado, apaga* →
  "🗑️ Apaguei: Refrigerante R$ 8,00 (Nubank). Se foi engano, responda *volta*." *volta* / *restaura*
  desfaz a exclusão; *desfaz* volta o que acabou de ser apagado ou, sem exclusão recente, cancela o último.
- Nome: *não é revirante, é refrigerante*, *era refrigerante*, *é refrigerante*, *o nome é …*,
  *errou, é …*, *corrige pra …* → troca a descrição e reclassifica quando o nome novo casa com uma regra
  ou categoria ("✏️ Corrigido: Revirante → Refrigerante (Alimentação)"). *é mercado* (nome de categoria)
  muda a categoria.
- Valor, forma de pagamento e categoria logo depois do lançamento: *foram 15*, *foi 15 reais*,
  *não, 15 reais*, *valor errado, 15*; *foi no crédito*, *no débito*; *muda pra mercado*,
  *coloca em lazer*. Número solto ("2", "15") nunca é correção (é resposta de menu ou lançamento), e
  mensagem com verbo de gasto (*paguei 15 no uber*) é lançamento novo.
- Com uma pergunta do bot aberta (ex.: "Qual a categoria?"), esses comandos saem da pergunta e valem
  para o lançamento ("cancela" não vira a categoria "Cancela").

**Áudio:** a confirmação mostra o que foi ouvido ("🎙️ Ouvi: “comprei revirante 8 reais no nubank”") e
como corrigir. Quando alguém corrige o nome de um lançamento vindo de áudio (pelo WhatsApp ou editando no
painel) e as palavras soam parecido, o par fica guardado na família ("revirante" → "refrigerante"): os
próximos áudios já saem certos (palavra inteira, sem diferenciar acento/maiúscula) e a palavra certa entra
no prompt do Whisper. Lista e remoção em Integrações → IA → "Correções do áudio". Trocar "Mercado" por
"Farmácia" não é aprendido (não é erro de escuta). O prompt também leva as palavras de compra mais
frequentes da família e uma lista curta de itens comuns (refrigerante, padaria, gasolina, farmácia…).

**Vários grupos: pessoa física × empresa.** A família pode autorizar mais de um grupo na mesma conexão
(ex.: "Finanças da Família" e "Empresa"). Cada grupo tem uma **natureza padrão**: *Pessoa física*,
*Empresa* ou *Não atribuído*. O primeiro grupo autorizado começa como Pessoa física (como era antes); os
demais começam Não atribuídos. Trocar a natureza do grupo não muda lançamentos já feitos.

Natureza de um lançamento novo vindo do WhatsApp (texto, áudio, comprovante), nesta ordem:

1. **O que a mensagem diz**: *empresa*, *da empresa*, *pra empresa*, *PJ* → Empresa; *PF*, *pessoa
   física*, *é pessoal* → Pessoa física — no fim ou no meio da frase (*uber 30 pj*, *almoço 50 empresa no
   itaú*). A palavra sai da descrição. PF e PJ na mesma mensagem (*mercado 120 pf, gasolina 80 pj*):
   cada trecho decide. *pf* no fim de um pedido (*anota 50 de uber pf*) é "por favor" e não conta.
2. **Regra** de natureza (definir Pessoal/Empresa, desconsiderar, perguntar) — continua valendo; a
   mensagem explícita sempre vence a regra.
3. **Natureza do grupo** (Pessoa física ou Empresa).
4. **Grupo não atribuído**: o bot pergunta *é de pessoa física ou da empresa?* — *1* (PF), *2*
   (Empresa), *cliente* (repasse) ou *pular* (fica em Pendências). Em Integrações → WhatsApp (lista de grupos) dá para
   usar o **padrão da família** em vez de perguntar (`HouseholdSettings.whatsappUnassignedNature`:
   `ASK` | `FAMILY_DEFAULT`).

PDF de extrato/fatura enviado no grupo da empresa (ou com legenda *empresa*) chega à prévia com as linhas
sem regra como Empresa ("grupo do WhatsApp"); dá para trocar na prévia.

**Perguntas** respondem no recorte do grupo: grupo da empresa → Empresa; grupo pessoa física → Pessoa
física; grupo não atribuído → Tudo, com a linha "Despesas de <mês>: Pessoa física R$ X · Empresa R$ Y".
*empresa*/*PF* na própria pergunta (*quanto gastamos da empresa este mês?*) vale como recorte.

As respostas do bot saem **no grupo de onde veio a mensagem**. Mensagens sem resposta a um lançamento
(lembretes, avisos) vão para o grupo pessoa física (ou o primeiro autorizado).

Status da conexão: `DISCONNECTED`, `CONNECTING`, `QR_PENDING`, `CONNECTED`, `ERROR`, `LOGGED_OUT`.
Eventos (`WhatsAppConnectionEvent`): `CONNECTED`, `DISCONNECTED`, `QR`, `ERROR`, `LOGGED_OUT`.

---

## 6. Idempotência e recuperação

| Situação | Comportamento |
| --- | --- |
| Mesmo evento entregue duas vezes (reconexão, reentrega do webhook) | Unicidade `(connectionId, externalId)`: devolve a mensagem existente; nenhum job novo |
| Mesmo comprovante enviado de novo | Attachment reutilizado (SHA-256 por família) + `statusDetail` "Mídia repetida" |
| Redis fora do ar na ingestão | Mensagem e job ficam no banco (`PENDING`); a recuperação reenfileira |
| Worker caiu durante o processamento | Job `RUNNING` há > 10 min volta a `PENDING` e é reenfileirado |
| Reprocessar (`POST messages/{id}/reprocess`) | Reseta o job e reenfileira; o motor não duplica lançamentos |
| Mesmo envio pedido duas vezes | jobId = hash do `dedupeKey`; marca de entrega no Redis; registro OUTBOUND reaproveitado |
| Comando ao worker perdido (pub/sub) | O estado desejado (`desiredConnected`, pedidos em `config`) é verificado a cada ~10 s |

`recoverStuckJobs()` (`src/server/whatsapp/recovery.ts`, tarefa `jobs:recover` a cada 2 min) é idempotente:
`RUNNING` travado → `PENDING`; mensagens `RECEIVED` com processamento ligado → job; `PENDING` vencido e
ausente da fila → reenfileirado.

---

## 7. Privacidade e segurança

- Somente o chat autorizado é processado; nada de outros chats é gravado (nem texto, nem remetente).
- Participantes de grupos não autorizados não são armazenados; os nomes dos grupos são guardados
  apenas para a escolha do grupo a autorizar.
- Logs nunca contêm conteúdo de mensagens, QR Codes, tokens ou credenciais (o logger do Baileys é
  substituído por um adaptador que descarta os objetos internos).
- Credenciais do Baileys e mídias são criptografadas em repouso; o token da Cloud API fica só no ambiente.
- Webhook: assinatura HMAC-SHA256 verificada em tempo constante; corpo limitado a 3 MB.
- Ações administrativas (conectar, desconectar, logout, troca de provedor/processamento, autorização
  de grupo, reprocessamento) são auditadas (`CONNECT`, `DISCONNECT`, `SETTINGS_CHANGE`, `UPDATE`).
- Permissões: leitura (status, mensagens) para membros; alterações exigem `integrations:manage`.

---

## 8. API

Base: `/api/v1/integrations/whatsapp` (resposta `{ data }`; erros `{ error: { code, message } }`).

| Método | Caminho | Entrada | Saída |
| --- | --- | --- | --- |
| GET | `/` | — | Status completo: provedor, aviso de riscos (Baileys), status, número, última conexão, processamento, worker, estatísticas de 7 dias por status, erros recentes, grupos e o autorizado, membros/consentimento, `canSend` |
| POST | `/connect` · `/disconnect` · `/reconnect` · `/logout` | — | `{ ok, commandDelivered, workerOnline, message }` |
| PATCH | `/settings` | `{ provider?, processingEnabled?, phoneNumberId? }` | `{ provider, processingEnabled, desiredConnected, requeued }` |
| GET | `/qr` | — | `{ dataUrl, expiresInSeconds }` ou 404 |
| POST | `/groups/sync` | — | `{ ok, … }` |
| PATCH | `/groups/{id}` | `{ authorized?: boolean, defaultNature?: "PERSONAL" \| "BUSINESS" \| null }` | `{ id, name, isAuthorized, defaultNature, revokedGroupId: null }` (vários grupos podem ficar autorizados) |
| GET | `/messages` | `?limit&cursor&status&direction` | `{ items[{ status, type, sender, group, text, transactions, job, attachment }], nextCursor, scope, groups }` |
| POST | `/messages/{id}/reprocess` | — | `{ messageId, jobId, queued }` |
| POST | `/retry-failed` | — | `{ total, requeued, skipped }` |
| POST | `/simulate` | `{ memberId, text? \| audioBase64? \| imageBase64? \| documentBase64?, mimeType?, fileName?, groupId? }` | `{ accepted, reason, reasonLabel, messageId, status, mode, outcome }` (só com `SIMULATOR` + `WHATSAPP_ENABLE_SIMULATOR`) |

Webhook da Cloud API: `GET/POST /api/webhooks/whatsapp`.

Para outros módulos: `enqueueOutboundMessage(input)` e `whatsappCanSend(householdId)` em
`src/server/whatsapp/outbound.ts`.

---

## 9. Limitações conhecidas

- **Baileys v7 (rc) e LIDs:** em grupos, o WhatsApp pode identificar participantes apenas pelo LID
  (`…@lid`). O sistema usa `participantAlt`/`remoteJidAlt`, o mapeamento LID→telefone do próprio
  Baileys (`lidMapping`) e aprende o LID de cada membro na primeira mensagem em que telefone e LID
  aparecem juntos (ou na sincronização do grupo autorizado). Se o WhatsApp entregar só o LID e não houver
  mapeamento conhecido, a mensagem é descartada como remetente desconhecido até o mapeamento surgir
  (ex.: sincronizar os grupos). Por ser uma versão *release candidate* não oficial, mudanças de protocolo
  podem quebrar a conexão.
- Citação da mensagem original nas respostas (Baileys) depende de cache em memória das mensagens
  aceitas; após reinício do worker a resposta é enviada sem citação.
- O histórico anterior à conexão não é importado (apenas mensagens novas e as pendentes de entrega).
- Um único worker por instalação (sessão do WhatsApp e travas de ordenação são por processo).
- Cloud API: sem suporte a grupos e a *templates* (envios fora da janela de 24 h falham e ficam registrados).
- Simulador: arquivo de até ~1,5 MB por mensagem (limite do corpo JSON da API).

---

## 10. Testes

```bash
TEST_DATABASE_URL="postgresql://…/finance_ai_test_wa?schema=public" npx vitest run --project integration tests/integration/whatsapp-*
npx vitest run --project unit tests/unit/whatsapp-*
```

Cobrem: grupo não autorizado ignorado sem persistir; remetente não autorizado/sem consentimento;
evento repetido sem duplicar; mensagens do bot ignoradas; falha → novas tentativas → `DEAD` + pendência;
`recoverStuckJobs`; `reprocessMessage`; envio com dedupe e limite de taxa; credenciais criptografadas;
assinatura do webhook; gerenciador de conexões (simulador); fronteira API × worker (sem Baileys nas rotas);
Redis fora do ar (ingestão grava `PENDING` sem travar, envio responde `queued:false`, status continua disponível).
