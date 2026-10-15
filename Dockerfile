# syntax=docker/dockerfile:1.7
# =============================================================================
# Finance AI — imagens de produção
#
#   web    → Next.js (saída standalone), porta 3000
#   worker → processo separado: WhatsApp, filas BullMQ, tarefas periódicas,
#            backups (pg_dump 16) e transcrição (ffmpeg)
#
# Build:  docker compose build      (ou: docker build --target web -t finance-ai-web .)
# Nenhuma chave/segredo é copiado para a imagem: tudo vem do ambiente em runtime.
# =============================================================================
ARG NODE_IMAGE=node:22-alpine

# ---------- base com pnpm ----------------------------------------------------
FROM ${NODE_IMAGE} AS base
RUN apk add --no-cache libc6-compat openssl
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# ---------- dependências (camada cacheável) ----------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ------------------------------------------------------------
FROM deps AS build
COPY . .
# Variáveis apenas para o build (não são usadas em runtime e não são segredos reais).
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    SESSION_SECRET="build-only-placeholder-not-used-at-runtime-000" \
    ENCRYPTION_KEY="YnVpbGQtb25seS1wbGFjZWhvbGRlci0zMi1ieXRlcyE=" \
    pnpm exec prisma generate && \
    DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    SESSION_SECRET="build-only-placeholder-not-used-at-runtime-000" \
    ENCRYPTION_KEY="YnVpbGQtb25seS1wbGFjZWhvbGRlci0zMi1ieXRlcyE=" \
    pnpm exec next build
# Mantém só as dependências de produção para o worker (tsx e prisma são dependências de runtime).
RUN pnpm prune --prod --ignore-scripts

# ---------- runtime comum ----------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# ffmpeg: conversão de áudios do WhatsApp · postgresql16-client: pg_dump/pg_restore para backups
RUN apk add --no-cache libc6-compat openssl tzdata tini ffmpeg postgresql16-client wget \
 && addgroup -S app -g 1001 && adduser -S app -u 1001 -G app \
 && mkdir -p /data/storage /data/backups && chown -R app:app /data
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=America/Recife \
    STORAGE_DIR=/data/storage \
    BACKUP_DIR=/data/backups \
    PG_DUMP_PATH=/usr/bin/pg_dump \
    PG_RESTORE_PATH=/usr/bin/pg_restore

# ---------- web --------------------------------------------------------------
FROM runtime AS web
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

# ---------- worker -----------------------------------------------------------
FROM runtime AS worker
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json /app/tsconfig.json ./
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/scripts ./scripts
USER app
ENV SERVICE_NAME=finance-ai-worker
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "--tsconfig", "tsconfig.json", "src/worker/index.ts"]
