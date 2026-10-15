# Guia de deploy

Cenário recomendado: **um servidor Linux (VPS) com Docker Compose** e um proxy reverso com HTTPS. Uma
família usa poucos recursos: 2 vCPU, 2 GB de RAM e 20 GB de disco bastam. Adicione 2 GB de RAM se for
usar transcrição local (`--profile whisper`).

## 1. Preparar o servidor

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # entre de novo na sessão
```

Abra no firewall apenas as portas 22, 80 e 443. O PostgreSQL e o Redis **não** são publicados pelo
compose.

## 2. Configurar

```bash
git clone <repositório> /opt/finance-ai && cd /opt/finance-ai
cp .env.example .env
```

No `.env`:

```
NODE_ENV=production
APP_URL=https://financas.seudominio.com.br
ALLOW_REGISTRATION=false
WHATSAPP_ENABLE_SIMULATOR=false
LOG_LEVEL=info
LOG_PRETTY=0
SESSION_SECRET=<openssl rand -base64 48>
ENCRYPTION_KEY=<openssl rand -base64 32>
POSTGRES_PASSWORD=<senha alfanumérica longa>
WEB_PORT=127.0.0.1:3000   # publica só para o proxy local
```

Guarde uma cópia da `ENCRYPTION_KEY` num gerenciador de senhas. Sem ela, as credenciais salvas não
podem ser recuperadas a partir de um backup.

## 3. Subir

```bash
docker compose up -d --build
docker compose ps                 # migrate deve aparecer como "exited (0)"
curl -s http://127.0.0.1:3000/api/health
```

## 4. HTTPS com proxy reverso

Exemplo com **Caddy** (certificado automático). Arquivo `/etc/caddy/Caddyfile`:

```
financas.seudominio.com.br {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        # SSE (atualização em tempo real): sem buffer
        flush_interval -1
    }
}
```

Com **Nginx**, inclua para o SSE:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;              # necessário para /api/v1/events
    proxy_read_timeout 1h;
    client_max_body_size 20m;         # importações (até 5 MB em base64) e anexos
}
```

Com `APP_URL` em `https://`, os cookies passam a ser `Secure` automaticamente e o HSTS é enviado.

## 5. Primeiro acesso

1. Abra `https://financas.seudominio.com.br/cadastro` e crie a família. Faça isso logo após o deploy:
   o primeiro cadastro é liberado para qualquer pessoa.
2. Convide os demais membros em Configurações → Membros.
3. Configure o WhatsApp (Cloud API oficial recomendada) e a IA. Veja [CONFIGURACAO.md](CONFIGURACAO.md).

Para o webhook da **WhatsApp Cloud API**, cadastre no painel da Meta:

- URL: `https://financas.seudominio.com.br/api/v1/integrations/whatsapp/webhook`
- Token de verificação: o valor de `WHATSAPP_CLOUD_VERIFY_TOKEN`

## 6. Atualizar

```bash
cd /opt/finance-ai
git pull
docker compose up -d --build      # o serviço migrate aplica as migrations novas antes de web/worker
docker image prune -f
```

Faça um backup antes de atualizar (seção 7).

## 7. Backups e restauração

O worker faz backups automáticos (`BACKUP_INTERVAL_HOURS`, padrão 24 h) no volume `backups`, com
hash SHA-256, e mantém os `BACKUP_KEEP` mais recentes.

```bash
# backup manual e verificação
docker compose exec worker node_modules/.bin/tsx --tsconfig tsconfig.json scripts/backup.ts create
docker compose exec worker node_modules/.bin/tsx --tsconfig tsconfig.json scripts/backup.ts list
docker compose exec worker node_modules/.bin/tsx --tsconfig tsconfig.json scripts/backup.ts verify <arquivo>
```

### Backups externos

Os arquivos **não são criptografados** pelo sistema. Copie-os para fora do servidor com criptografia:

```bash
# exemplo com restic (repositório criptografado)
docker run --rm -v finance-ai_backups:/backups:ro -e RESTIC_PASSWORD=... -e RESTIC_REPOSITORY=... \
  restic/restic backup /backups
```

Guarde também o `.env` (principalmente a `ENCRYPTION_KEY`) num local seguro e separado dos backups.

### Restaurar

```bash
docker compose stop web worker
docker compose cp worker:/data/backups/<arquivo>.dump ./restore.dump   # ou use o arquivo externo
docker compose exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < restore.dump
docker compose up -d                                                    # migrate aplica o que faltar
```

Depois, confira os saldos no painel. A verificação de integridade do ledger
(`GET /api/v1/accounts/integrity`) confere se as transferências somam zero, se as parcelas fecham o
total e se não há compra no crédito movimentando caixa. `POST` no mesmo endereço recalcula os movimentos
derivados de forma idempotente. Os dois também estão disponíveis na tela **Contas**.

## 8. Monitoramento

- `GET /api/health`: `ok` (banco, Redis e worker ativos), `degraded` (Redis fora ou worker parado;
  o painel funciona) ou `down` (sem banco, HTTP 503). Use num monitor externo (Uptime Kuma,
  Healthchecks…).
- Logs: `docker compose logs -f --since 1h web worker`. Os logs saem em JSON e com dados sensíveis
  já redigidos.
- O status da conexão do WhatsApp e o histórico de eventos ficam em Integrações → WhatsApp. Uma
  desconexão gera notificação para os administradores.

## 9. Escala e limites

- **Worker: sempre 1 réplica.** Uma sessão de WhatsApp não pode ficar aberta em dois processos. As
  filas aceitam mais concorrência via `WORKER_CONCURRENCY`.
- O `web` é stateless (sessões no banco, eventos no Redis) e pode ter mais réplicas atrás do proxy,
  desde que compartilhe o volume `storage`.
- Limites: corpo JSON até 2 MB, arquivos de importação até 5 MB, mídias do WhatsApp até 16 MB.

## 10. Checklist de produção

- [ ] `NODE_ENV=production`, `APP_URL` com https
- [ ] `ALLOW_REGISTRATION=false`, `WHATSAPP_ENABLE_SIMULATOR=false`
- [ ] Segredos gerados aleatoriamente e `ENCRYPTION_KEY` guardada fora do servidor
- [ ] PostgreSQL e Redis sem portas públicas
- [ ] Proxy com HTTPS e `proxy_buffering off` para o SSE
- [ ] Backups automáticos ativos e cópia externa criptografada
- [ ] Monitor externo em `/api/health`
- [ ] WhatsApp pela Cloud API oficial. Se usar QR Code, ciente dos riscos e com número dedicado.
