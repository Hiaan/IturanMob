# Segurança, privacidade e LGPD

## Autenticação e sessões

- **Senhas** com hash `scrypt` e sal individual. A política exige no mínimo 10 caracteres e mistura de
  tipos. Depois de várias tentativas erradas, a conta é bloqueada temporariamente.
- **Sessões**: token aleatório de 256 bits num cookie `httpOnly`, `SameSite=Lax`, `Secure` em HTTPS.
  O banco guarda só o HMAC do token, então um vazamento da tabela não permite sequestrar sessões.
  Expiração deslizante de 30 dias. Em **Configurações → Segurança**, cada pessoa vê e encerra as
  suas sessões.
- **CSRF**: toda requisição que altera dados precisa ter `Origin` igual à aplicação (`APP_URL` ou o
  host). Os formulários de login e cadastro usam POST, inclusive antes do JavaScript carregar, para
  a senha nunca aparecer na URL.
- **Rate limit** (Redis, com fallback em memória): login, cadastro, convites e API.
- **Cabeçalhos**: CSP restritiva, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS em
  produção, sem `X-Powered-By`.

## Autorização

| Papel | Pode |
|---|---|
| **Visualizador** | Ver lançamentos e relatórios |
| **Membro** | + lançar, editar, excluir, gerenciar contas, cartões, categorias, orçamentos, metas, contas a pagar, regras, importar e exportar |
| **Administrador** | + integrações (WhatsApp, IA), configurações, membros e convites, auditoria |
| **Proprietário** | + excluir a família |

- Toda consulta filtra pela família da sessão. Ids de outra família são tratados como inexistentes
  (404), sem revelar se existem.
- Contas e cartões **privados** só são visíveis para o dono, salvo permissão explícita.
- Um teste de integração garante o isolamento entre famílias.

## Segredos e criptografia

- Chaves de API **nunca** ficam no código. Elas vêm do `.env` ou são cadastradas na interface e
  guardadas com **AES-256-GCM** (`ENCRYPTION_KEY`).
- A sessão do WhatsApp (modo Baileys) é guardada criptografada no banco (`WhatsAppAuthState`). Ela não
  vai para arquivos soltos.
- O `.env` é criado com permissão `600` pelo `pnpm run setup`.
- Trocar a `ENCRYPTION_KEY` torna ilegíveis as credenciais salvas. Nesse caso, recadastre as chaves e
  reconecte o WhatsApp.

## Logs

- Os logs são estruturados (pino) e passam por redação automática de `authorization`, `cookie`,
  senhas, tokens, chaves, conteúdo de mensagens, transcrições e dados de sessão do WhatsApp.
- Os logs de IA guardam provedor, modelo, tokens, tempo e status, mas **não o conteúdo**.
- A auditoria (`AuditLog`) guarda o antes/depois das alterações financeiras para que a família possa
  conferir o histórico. Ela fica no banco, não nos logs da aplicação.

## WhatsApp: escopo e consentimento

- O sistema processa **apenas o grupo selecionado**. Mensagens de outros grupos e conversas privadas
  são descartadas na entrada, sem armazenamento e sem análise.
- Só **remetentes autorizados** (membros vinculados a um telefone) têm mensagens processadas. Os
  demais são ignorados.
- O processamento depende do **consentimento** registrado de cada participante.
- Os contatos do aparelho não são lidos.
- Não há envio em massa, disparo para terceiros nem mecanismo de evasão de detecção. As respostas vão
  só para o grupo da família, com limite de envio.
- Sobre o modo **Baileys** (QR Code): é uma biblioteca **não oficial** e **não é autorizada pela Meta**.
  O número pode ser bloqueado e a integração pode parar a qualquer momento. A alternativa oficial é a
  **WhatsApp Cloud API**. Detalhes em [WHATSAPP.md](WHATSAPP.md).

## Dados pessoais (LGPD)

| Direito / princípio | Como é atendido |
|---|---|
| Finalidade e necessidade | Só o grupo da família é processado. Dos comprovantes, o sistema guarda só os 4 últimos dígitos do cartão. Provedores externos recebem o mínimo necessário (ver [IA.md](IA.md)). |
| Consentimento | Autorizações separadas para IA externa, áudio e imagem, e consentimento por participante do grupo. |
| Acesso e portabilidade | **Exportação integral** da família (JSON) e exportação de transações (CSV/XLSX) em Configurações / Relatórios. |
| Eliminação | Excluir a própria conta (digitando "EXCLUIR") ou a família inteira (digitando o nome da família). |
| Retenção | Mídias originais: 90 dias (padrão). Transcrições: 365 dias. Configurável por família. A limpeza automática roda diariamente e nunca apaga mídias de mensagens ainda não processadas. |
| Segurança | Criptografia de segredos, isolamento por família, auditoria e backups verificáveis. |

## Backups

- Backup automático periódico (`BACKUP_INTERVAL_HOURS`) com `pg_dump --format=custom`. Sem
  `pg_dump`, o sistema exporta tudo em JSON compactado. Cada backup tem manifesto SHA-256 e os
  `BACKUP_KEEP` mais recentes ficam guardados.
- Para verificar a integridade, use **Configurações → Backups → Verificar** ou `pnpm backup:verify`.
  Isso recalcula o hash e lê a estrutura com `pg_restore --list`.
- **Os arquivos de backup não são criptografados pelo sistema.** Em produção, copie a pasta de
  backups para um armazenamento externo criptografado (ex.: `restic`, `rclone crypt`). Veja
  [DEPLOY.md](DEPLOY.md#backups-externos).

## Exclusões

- Lançamentos: exclusão lógica (restaurável). A exclusão definitiva exige a confirmação digitada
  "EXCLUIR".
- Pedidos de "apagar tudo" por mensagem são sempre recusados.
- Excluir a família apaga todos os dados dela e exige digitar o nome exato.
