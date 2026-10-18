# Manual de configuração

A configuração vem de dois lugares:

- **Variáveis de ambiente** (`.env`): infraestrutura, segredos e padrões globais. Todas estão
  comentadas no [`.env.example`](../.env.example) e são validadas na inicialização
  (`src/server/env.ts`). Se houver valor inválido, o processo não sobe e a mensagem diz qual
  variável corrigir.
- **Interface** (por família): preferências, consentimentos, provedores de IA por tarefa, WhatsApp,
  notificações, retenção e regras de categorização.

## Variáveis essenciais

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | PostgreSQL 16. No Docker Compose é montada a partir de `POSTGRES_*`. |
| `REDIS_URL` | sim | Redis 7 (filas, tempo real, rate limit). |
| `APP_URL` | sim | URL pública. Usada em convites, cookies seguros e verificação de origem. |
| `SESSION_SECRET` | sim | ≥ 32 caracteres aleatórios. |
| `ENCRYPTION_KEY` | sim | 32 bytes em base64 (`openssl rand -base64 32`). Criptografa as credenciais salvas. |
| `POSTGRES_PASSWORD` | Docker | Senha do banco criado pelo compose (use só letras e números). |
| `ALLOW_REGISTRATION` | não | `false` (padrão): só o primeiro cadastro é livre; depois, apenas por convite. |
| `INSTANCE_ADMIN_EMAILS` | não | E-mails (vírgula) de quem pode gerar convites de **nova família** (uso único, 7 dias). Vazio = proprietário da primeira família. |
| `DEFAULT_TIMEZONE` | não | `America/Recife`. Cada família pode alterar. |

## Inteligência artificial

A configuração fica em **Integrações → IA**. O consentimento fica em **Configurações → Privacidade e IA**.

1. **Sem nada configurado**, o motor local em português interpreta as mensagens e responde às
   perguntas. Nada é enviado a terceiros.
2. **Para usar um LLM**:
   - Coloque a chave no `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) ou cadastre-a na tela
     (fica criptografada).
   - Clique em **Testar conexão**. O teste usa um texto sintético, sem dados da família.
   - Escolha o provedor e o modelo de cada tarefa (interpretação, comprovantes, transcrição,
     assistente, análise de padrões).
   - Autorize o uso externo em Privacidade e IA. Há autorizações separadas para texto, áudio e
     imagem. Sem elas, o sistema continua usando o motor local.
3. **LLM local** (Ollama, LM Studio, vLLM): use o provedor "Compatível com OpenAI" com
   `OPENAI_COMPATIBLE_BASE_URL` (ex.: `http://ollama:11434/v1` no compose com `--profile ollama`) e
   `OPENAI_COMPATIBLE_MODEL`.

**Limiares de confiança** (Configurações → Preferências):

- registro automático a partir de 0,85;
- pedido de confirmação a partir de 0,60;
- abaixo de 0,60, o sistema faz uma pergunta.

Detalhes do funcionamento em [IA.md](IA.md).

### Transcrição local

Para transcrever áudios sem enviá-los a terceiros:

```bash
docker compose --profile whisper up -d
```

No `.env`:

```
TRANSCRIPTION_PROVIDER=openai_compatible
TRANSCRIPTION_BASE_URL=http://whisper:8000/v1
TRANSCRIPTION_MODEL=Systran/faster-whisper-small
```

Endereços privados (rede interna do Docker, `localhost`, `10.x`, `192.168.x`) são tratados como
processamento local e não exigem autorização de envio externo de áudio. Com a API da OpenAI,
use `TRANSCRIPTION_PROVIDER=openai` com a chave e autorize o áudio externo.

## WhatsApp

Há três modos, escolhidos em **Integrações → WhatsApp** (padrão global em
`WHATSAPP_DEFAULT_PROVIDER`):

| Modo | Para quê | Observações |
|---|---|---|
| **Simulador** | Desenvolvimento e testes | Identificado na interface como simulação. Não conecta ao WhatsApp. Desative em produção (`WHATSAPP_ENABLE_SIMULATOR=false`). |
| **Cloud API (oficial)** | Produção dentro das regras da Meta | **Não funciona em grupos.** Cada membro conversa diretamente com o número comercial da família, e as respostas vão para a conversa de quem enviou. Exige conta na Meta, número comercial verificado e HTTPS público para o webhook `{APP_URL}/api/webhooks/whatsapp`. Variáveis `WHATSAPP_CLOUD_*`. Fora da janela de 24 h, a Meta só aceita *templates* (não implementados). |
| **QR Code (Baileys)** | Alternativa **não oficial** | **Não é autorizado pela Meta.** O número pode ser bloqueado e a integração pode parar a qualquer momento. A sessão fica criptografada no banco. Use um número dedicado, por sua conta e risco. |

> Hoje, o **único modo que lê um grupo do WhatsApp** é o QR Code (Baileys), que não é oficial. Se a
> família quiser ficar 100% dentro das regras da Meta, use a Cloud API, sabendo que cada pessoa manda
> mensagens ao número comercial em vez de escrever num grupo.

Depois de conectar:

1. **Selecione o grupo** da família. Só ele será processado.
2. **Autorize os remetentes**: vincule o telefone de cada membro. Mensagens de outros números são
   ignoradas.
3. **Registre o consentimento** dos participantes. Sem ele, nada é processado.
4. Escolha se o sistema responde no grupo e se responde a perguntas (Privacidade e IA).

Passo a passo completo, comandos aceitos no grupo e detalhes de cada provedor em [WHATSAPP.md](WHATSAPP.md).

## Notificações

Em **Configurações → Notificações**, cada pessoa escolhe por tipo de aviso (contas a vencer, fatura,
orçamento, metas, pendências, relatórios, falhas de integração):

- canal: no app e/ou WhatsApp;
- frequência: imediata, resumo diário ou desligada;
- horário silencioso.

## Retenção e privacidade

Em **Configurações → Privacidade e IA**:

| Item | Padrão |
|---|---|
| Mídias originais (áudios e fotos) | 90 dias (0 = apagar logo após o processamento) |
| Transcrições | 365 dias |
| Janela de suspeita de duplicidade | 48 h |

A limpeza roda diariamente no worker. Lançamentos, auditoria e dados financeiros não são apagados
pela retenção.

## Backups

| Variável | Padrão | Descrição |
|---|---|---|
| `BACKUP_DIR` | `./backups` (`/data/backups` no Docker) | Pasta dos backups |
| `BACKUP_INTERVAL_HOURS` | 24 | Intervalo do backup automático (0 desativa) |
| `BACKUP_KEEP` | 14 | Quantos backups manter |
| `PG_DUMP_PATH` / `PG_RESTORE_PATH` | `pg_dump` / `pg_restore` | Binários versão ≥ 16 |

Backup manual, verificação e instruções de restauração ficam em **Configurações → Backups**. Veja
também [DEPLOY.md](DEPLOY.md#backups-e-restauração).

## Categorias e regras

As categorias e subcategorias padrão (com palavras-chave em português) são criadas no cadastro da
família e podem ser editadas. Em **Categorias → Regras**, crie regras como "descrição contém
`posto shell` → Transporte › Combustível". As regras valem para novos lançamentos (painel, WhatsApp e
importação) e podem ser aplicadas retroativamente.
