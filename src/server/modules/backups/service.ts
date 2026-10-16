import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip, gunzip } from "node:zlib";
import type { BackupRecord } from "@prisma/client";
import { prisma } from "../../db";
import { env } from "../../env";
import { errorInfo, logger } from "../../logger";
import { systemContext, type ServiceContext } from "../../auth/context";
import { NotFoundError } from "../../errors";
import { exportFullHouseholdData } from "../exports/service";

/**
 * Backups do banco:
 * - pg_dump --format=custom (preferencial), com manifesto .sha256 e registro em BackupRecord;
 * - sem pg_dump: exportação JSON de todas as famílias, compactada (gzip).
 * Retenção: mantém os BACKUP_KEEP backups bem-sucedidos mais recentes.
 * A senha do banco é passada ao pg_dump por PGPASSWORD e nunca aparece em logs.
 */

export type BackupMethod = "auto" | "pg_dump" | "json";

export interface BackupDTO {
  id: string;
  kind: "DATABASE_DUMP" | "HOUSEHOLD_EXPORT";
  status: "SUCCESS" | "FAILED" | "VERIFIED" | "CORRUPTED";
  fileName: string;
  sha256: string | null;
  sizeBytes: number | null;
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface VerifyResult {
  ok: boolean;
  status: "VERIFIED" | "CORRUPTED";
  filePath: string;
  sha256: string | null;
  expectedSha256: string | null;
  structure: string;
  message: string;
  record: BackupDTO | null;
}

const PG_DUMP = process.env.PG_DUMP_PATH || "pg_dump";
const PG_RESTORE = process.env.PG_RESTORE_PATH || "pg_restore";

export function backupDir(): string {
  return path.resolve(env().BACKUP_DIR);
}

function toDTO(r: BackupRecord): BackupDTO {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    fileName: path.basename(r.filePath),
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    error: r.error,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Carimbo do nome do arquivo: AAAAMMDD-HHMMSS-mmm-xxxx (UTC), único mesmo em execuções seguidas. */
function timestamp(d = new Date()): string {
  const iso = d.toISOString().replace(/[-:]/g, "").replace("T", "-");
  return `${iso.slice(0, 15)}-${iso.slice(16, 19)}-${randomBytes(2).toString("hex")}`;
}

/** Interpreta DATABASE_URL (inclui o parâmetro "schema" do Prisma, que o pg_dump não aceita na URL). */
export function parseDatabaseUrl(url: string) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("DATABASE_URL não é PostgreSQL.");
  return {
    host: u.hostname || "localhost",
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    schema: u.searchParams.get("schema"),
    sslmode: u.searchParams.get("sslmode"),
  };
}

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 30 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        e.stderr = String(stderr ?? "");
        reject(e);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

/** Mensagem de erro segura (sem credenciais). */
function safeError(err: unknown, password?: string): string {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e.code === "ENOENT") return "Ferramenta não encontrada no servidor.";
  let msg = (e.stderr || e.message || String(err)).trim().split("\n").slice(0, 3).join(" ");
  if (password) msg = msg.split(password).join("***");
  return msg.replace(/postgres(ql)?:\/\/[^@\s]*@/gi, "postgresql://***@").slice(0, 500);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

async function writeManifest(filePath: string, sha: string) {
  await writeFile(`${filePath}.sha256`, `${sha}  ${path.basename(filePath)}\n`, { mode: 0o600 });
}

async function readManifest(filePath: string): Promise<string | null> {
  try {
    const text = await readFile(`${filePath}.sha256`, "utf8");
    const m = /^([a-f0-9]{64})\b/i.exec(text.trim());
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function removeBackupFiles(filePath: string) {
  const dir = backupDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(dir + path.sep)) return; // nunca apaga fora do diretório de backups
  await rm(resolved, { force: true });
  await rm(`${resolved}.sha256`, { force: true });
}

export async function pgDumpAvailable(): Promise<boolean> {
  try {
    await run(PG_DUMP, ["--version"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function dumpWithPgDump(filePath: string): Promise<void> {
  const db = parseDatabaseUrl(env().DATABASE_URL);
  const args = ["--format=custom", "--no-owner", "--no-privileges", "--compress=6", "-h", db.host, "-p", db.port, "-U", db.user, "-d", db.database, "-f", filePath];
  // Esquema "public" é o padrão: sem -n, o dump não recria o esquema (evita erro na restauração).
  if (db.schema && db.schema !== "public") args.push("-n", db.schema);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: db.password, PGCONNECT_TIMEOUT: "15" };
  if (db.sslmode) childEnv.PGSSLMODE = db.sslmode;
  try {
    await run(PG_DUMP, args, { env: childEnv });
  } catch (err) {
    throw new Error(safeError(err, db.password));
  }
}

/** Exportação JSON (gzip) de todas as famílias — usada quando o pg_dump não está disponível. */
async function dumpAsJson(filePath: string): Promise<{ households: number }> {
  const households = await prisma.household.findMany({ select: { id: true, timezone: true }, orderBy: { createdAt: "asc" } });
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(filePath, { mode: 0o600 });
  const done = pipeline(gzip, out);
  const write = async (chunk: string) => {
    if (!gzip.write(chunk)) await once(gzip, "drain");
  };
  await write(`{"format":"finance-ai-backup-json","version":1,"createdAt":${JSON.stringify(new Date().toISOString())},"households":[`);
  for (let i = 0; i < households.length; i++) {
    const h = households[i]!;
    const data = await exportFullHouseholdData(systemContext(h.id, h.timezone), { audit: false });
    await write(`${i ? "," : ""}${JSON.stringify(data)}`);
  }
  await write("]}");
  gzip.end();
  await done;
  return { households: households.length };
}

/** Aplica a retenção: mantém os BACKUP_KEEP backups bem-sucedidos mais recentes. */
export async function applyRetention(): Promise<number> {
  const keep = env().BACKUP_KEEP;
  const ok = await prisma.backupRecord.findMany({ where: { householdId: null, status: { in: ["SUCCESS", "VERIFIED"] } }, orderBy: { createdAt: "desc" } });
  const toRemove = ok.slice(keep);
  const oldestKept = ok[Math.min(keep, ok.length) - 1];
  const failed = oldestKept
    ? await prisma.backupRecord.findMany({ where: { householdId: null, status: { in: ["FAILED", "CORRUPTED"] }, createdAt: { lt: oldestKept.createdAt } } })
    : [];
  for (const r of [...toRemove, ...failed]) {
    await removeBackupFiles(r.filePath);
    await prisma.backupRecord.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  return toRemove.length + failed.length;
}

/**
 * Cria um backup completo. Retorna o registro (SUCCESS) — ou FAILED se nada pôde ser gravado.
 * Com `method: "auto"`, usa pg_dump e, se indisponível ou com erro, a exportação JSON compactada.
 */
export async function createDatabaseBackup(opts: { method?: BackupMethod } = {}): Promise<BackupDTO> {
  const method = opts.method ?? "auto";
  const dir = backupDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = timestamp();

  if (method !== "json") {
    const available = await pgDumpAvailable();
    if (available) {
      const filePath = path.join(dir, `finance-ai-${stamp}.dump`);
      try {
        await dumpWithPgDump(filePath);
        const sha = await sha256File(filePath);
        await writeManifest(filePath, sha);
        const record = await prisma.backupRecord.create({ data: { kind: "DATABASE_DUMP", status: "SUCCESS", filePath, sha256: sha, sizeBytes: await fileSize(filePath) } });
        logger.info({ backupId: record.id, sizeBytes: record.sizeBytes }, "backups: pg_dump concluído");
        await applyRetention();
        return toDTO(record);
      } catch (err) {
        await rm(filePath, { force: true });
        const message = (err as Error).message.slice(0, 500);
        await prisma.backupRecord.create({ data: { kind: "DATABASE_DUMP", status: "FAILED", filePath, error: message } });
        logger.error({ err: errorInfo(err) }, "backups: falha no pg_dump");
        if (method === "pg_dump") throw new Error(`Falha no pg_dump: ${message}`);
      }
    } else if (method === "pg_dump") {
      throw new Error("pg_dump não está disponível neste servidor.");
    } else {
      logger.warn("backups: pg_dump indisponível — usando exportação JSON");
    }
  }

  const filePath = path.join(dir, `finance-ai-${stamp}.json.gz`);
  try {
    const { households } = await dumpAsJson(filePath);
    const sha = await sha256File(filePath);
    await writeManifest(filePath, sha);
    const record = await prisma.backupRecord.create({ data: { kind: "HOUSEHOLD_EXPORT", status: "SUCCESS", filePath, sha256: sha, sizeBytes: await fileSize(filePath) } });
    logger.info({ backupId: record.id, households }, "backups: exportação JSON concluída");
    await applyRetention();
    return toDTO(record);
  } catch (err) {
    await rm(filePath, { force: true });
    const record = await prisma.backupRecord.create({ data: { kind: "HOUSEHOLD_EXPORT", status: "FAILED", filePath, error: (err as Error).message.slice(0, 500) } });
    logger.error({ err: errorInfo(err) }, "backups: falha na exportação JSON");
    return toDTO(record);
  }
}

async function checkStructure(filePath: string, kind: "DATABASE_DUMP" | "HOUSEHOLD_EXPORT"): Promise<{ ok: boolean; detail: string }> {
  if (kind === "DATABASE_DUMP") {
    try {
      const { stdout } = await run(PG_RESTORE, ["--list", filePath], { timeoutMs: 5 * 60_000 });
      const tables = stdout.split("\n").filter((l) => /\bTABLE\b/.test(l) && !/TABLE DATA/.test(l)).length;
      const data = stdout.split("\n").filter((l) => /TABLE DATA/.test(l)).length;
      if (!tables) return { ok: false, detail: "pg_restore não encontrou tabelas no arquivo." };
      return { ok: true, detail: `pg_restore --list: ${tables} tabela(s), ${data} bloco(s) de dados.` };
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return { ok: true, detail: "Checksum conferido; pg_restore indisponível para validar a estrutura." };
      return { ok: false, detail: `pg_restore rejeitou o arquivo: ${safeError(err)}` };
    }
  }
  try {
    const parsed = (await readJsonBackup(filePath)) as { format?: string; households?: unknown[] };
    if (parsed.format !== "finance-ai-backup-json" || !Array.isArray(parsed.households)) return { ok: false, detail: "Estrutura do JSON inesperada." };
    return { ok: true, detail: `JSON válido com ${parsed.households.length} família(s).` };
  } catch {
    return { ok: false, detail: "Não foi possível descompactar ou ler o JSON." };
  }
}

function kindFromPath(filePath: string): "DATABASE_DUMP" | "HOUSEHOLD_EXPORT" {
  return filePath.endsWith(".json.gz") ? "HOUSEHOLD_EXPORT" : "DATABASE_DUMP";
}

/**
 * Verifica um backup pelo id do registro ou pelo caminho do arquivo:
 * confere o SHA-256 (registro e manifesto) e a estrutura (pg_restore --list ou JSON).
 */
export async function verifyBackup(idOrPath: string): Promise<VerifyResult> {
  let record = await prisma.backupRecord.findUnique({ where: { id: idOrPath } }).catch(() => null);
  let filePath: string;
  if (record) {
    filePath = record.filePath;
  } else {
    filePath = path.isAbsolute(idOrPath) ? idOrPath : path.resolve(idOrPath);
    if (!(await stat(filePath).catch(() => null))) {
      const inDir = path.join(backupDir(), path.basename(idOrPath));
      if (await stat(inDir).catch(() => null)) filePath = inDir;
    }
    record = await prisma.backupRecord.findFirst({ where: { filePath }, orderBy: { createdAt: "desc" } });
  }
  if (record && record.status === "FAILED") throw new NotFoundError("Backup válido");

  const kind = record?.kind ?? kindFromPath(filePath);
  const manifest = await readManifest(filePath);
  const expected = record?.sha256 ?? manifest;
  let sha: string | null = null;
  let ok = true;
  let structure = "";
  let message = "";
  try {
    sha = await sha256File(filePath);
  } catch {
    ok = false;
    message = "Arquivo de backup não encontrado.";
  }
  if (sha) {
    if (expected && sha !== expected) {
      ok = false;
      message = "O SHA-256 do arquivo não confere com o registrado: o backup está corrompido ou foi alterado.";
    } else if (manifest && sha !== manifest) {
      ok = false;
      message = "O SHA-256 do arquivo não confere com o manifesto (.sha256).";
    } else {
      const s = await checkStructure(filePath, kind);
      ok = s.ok;
      structure = s.detail;
      message = s.ok ? (expected ? "Checksum e estrutura conferidos." : "Estrutura conferida (sem checksum registrado para comparar).") : s.detail;
    }
  }
  if (!message) message = ok ? "Backup verificado." : "Backup inválido.";

  const status = ok ? "VERIFIED" : "CORRUPTED";
  let updated: BackupRecord | null = null;
  if (record) {
    updated = await prisma.backupRecord.update({ where: { id: record.id }, data: { status, verifiedAt: new Date(), error: ok ? null : message.slice(0, 500) } });
  }
  if (!ok) logger.warn({ backupId: record?.id ?? null }, "backups: verificação falhou");
  return { ok, status, filePath, sha256: sha, expectedSha256: expected, structure, message, record: updated ? toDTO(updated) : null };
}

/** Executa backup se o intervalo configurado já passou desde o último backup bem-sucedido. */
export async function runBackupIfDue(now: Date = new Date()): Promise<BackupDTO | null> {
  const hours = env().BACKUP_INTERVAL_HOURS;
  if (hours <= 0) return null;
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('finance-ai:backup-job')) AS locked`;
      if (!lock?.locked) return null;
      const last = await prisma.backupRecord.findFirst({ where: { householdId: null, status: { in: ["SUCCESS", "VERIFIED"] } }, orderBy: { createdAt: "desc" } });
      if (last && now.getTime() - last.createdAt.getTime() < hours * 3_600_000) return null;
      const created = await createDatabaseBackup();
      if (created.status === "SUCCESS") await verifyBackup(created.id);
      const fresh = await prisma.backupRecord.findUnique({ where: { id: created.id } });
      return fresh ? toDTO(fresh) : created;
    },
    { timeout: 60 * 60_000, maxWait: 10_000 },
  );
}

export async function listBackups(opts: { householdId?: string | null; limit?: number } = {}): Promise<BackupDTO[]> {
  const records = await prisma.backupRecord.findMany({
    where: opts.householdId ? { OR: [{ householdId: null }, { householdId: opts.householdId }] } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
  });
  return records.map(toDTO);
}

/** Lista para a interface (família autenticada): backups globais e da própria família. */
export async function listBackupsForHousehold(ctx: ServiceContext, limit = 50) {
  return listBackups({ householdId: ctx.householdId, limit });
}

export async function getBackupForHousehold(ctx: ServiceContext, id: string): Promise<BackupRecord> {
  const r = await prisma.backupRecord.findFirst({ where: { id, OR: [{ householdId: null }, { householdId: ctx.householdId }] } });
  if (!r) throw new NotFoundError("Backup");
  return r;
}

/** Instruções de restauração (impressas pelo CLI e exibidas na interface). */
export function restoreInstructions(fileName = "<arquivo>.dump"): string[] {
  const isJson = fileName.endsWith(".json.gz");
  if (isJson) {
    return [
      "Este backup é uma exportação JSON compactada (gerada sem pg_dump).",
      `1. Verifique o arquivo: pnpm backup verify ${fileName}`,
      `2. Descompacte para inspeção: gunzip -k ${fileName}`,
      "3. O conteúdo segue o formato de portabilidade (finance-ai-household-export) de cada família;",
      "   a reimportação deve ser feita por um script dedicado sobre um banco vazio com as migrations aplicadas.",
    ];
  }
  return [
    "Restauração (PostgreSQL, formato custom do pg_dump):",
    "1. Pare a aplicação e o worker (pnpm start / pnpm worker).",
    `2. Verifique o arquivo: pnpm backup verify ${fileName}`,
    "3. Crie um banco vazio (ex.: createdb -h HOST -U USUARIO finance_ai_restaurado).",
    `4. Restaure: PGPASSWORD=*** pg_restore --no-owner --no-privileges -h HOST -p 5432 -U USUARIO -d finance_ai_restaurado ${fileName}`,
    "   (para sobrescrever o banco atual: adicione --clean --if-exists e use o nome do banco atual em -d)",
    "5. Aponte DATABASE_URL para o banco restaurado e rode: pnpm db:deploy (aplica migrations pendentes, se houver).",
    "6. Inicie a aplicação e confira os saldos no painel.",
  ];
}

/** Lê um backup JSON compactado (verificação e ferramentas de restauração). */
export async function readJsonBackup(filePath: string): Promise<unknown> {
  const raw = await promisify(gunzip)(await readFile(filePath));
  return JSON.parse(raw.toString("utf8"));
}
