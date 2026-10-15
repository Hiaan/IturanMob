import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createSession } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";
import { createTransaction } from "@/server/modules/transactions/service";
import {
  applyRetention,
  createDatabaseBackup,
  listBackups,
  parseDatabaseUrl,
  pgDumpAvailable,
  readJsonBackup,
  restoreInstructions,
  runBackupIfDue,
  sha256File,
  verifyBackup,
} from "@/server/modules/backups/service";

let dir: string;
let fam: Awaited<ReturnType<typeof createFamily>>;
const saved = { dir: process.env.BACKUP_DIR, keep: process.env.BACKUP_KEEP, interval: process.env.BACKUP_INTERVAL_HOURS };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

describe("backups", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finance-ai-backups-"));
  });
  afterAll(async () => {
    setEnv({ BACKUP_DIR: saved.dir, BACKUP_KEEP: saved.keep, BACKUP_INTERVAL_HOURS: saved.interval });
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase();
    setEnv({ BACKUP_DIR: dir, BACKUP_KEEP: "14", BACKUP_INTERVAL_HOURS: "24" });
    fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1_234, description: "Café", date: "2026-10-10", accountId: nubank.id });
  });

  it("interpreta DATABASE_URL do Prisma sem expor a senha", () => {
    const db = parseDatabaseUrl("postgresql://user:s%40nha@db.local:6543/finance?schema=app&sslmode=require");
    expect(db).toEqual({ host: "db.local", port: "6543", user: "user", password: "s@nha", database: "finance", schema: "app", sslmode: "require" });
    expect(restoreInstructions("finance-ai-x.dump").join("\n")).toMatch(/pg_restore/);
    expect(restoreInstructions("finance-ai-x.json.gz").join("\n")).toMatch(/JSON/);
  });

  it("cria backup com pg_dump, grava manifesto SHA-256 e verifica (pg_restore --list)", async () => {
    expect(await pgDumpAvailable()).toBe(true);
    const backup = await createDatabaseBackup();
    expect(backup).toMatchObject({ kind: "DATABASE_DUMP", status: "SUCCESS" });
    expect(backup.fileName).toMatch(/^finance-ai-\d{8}-\d{6}-\d{3}-[0-9a-f]{4}\.dump$/);
    const file = path.join(dir, backup.fileName);
    expect((await stat(file)).size).toBe(backup.sizeBytes);
    expect(await sha256File(file)).toBe(backup.sha256);
    const manifest = await readFile(`${file}.sha256`, "utf8");
    expect(manifest).toBe(`${backup.sha256}  ${backup.fileName}\n`);
    expect((await readFile(file)).subarray(0, 5).toString("latin1")).toBe("PGDMP");

    const verified = await verifyBackup(backup.id);
    expect(verified).toMatchObject({ ok: true, status: "VERIFIED" });
    expect(verified.structure).toMatch(/tabela/);
    expect(verified.record?.verifiedAt).not.toBeNull();

    // Verificação pelo caminho do arquivo (uso no CLI).
    expect((await verifyBackup(file)).ok).toBe(true);

    // Arquivo alterado → corrompido.
    await appendFile(file, Buffer.from("x"));
    const corrupted = await verifyBackup(backup.id);
    expect(corrupted).toMatchObject({ ok: false, status: "CORRUPTED" });
    expect(corrupted.message).toMatch(/SHA-256/);
    expect((await prisma.backupRecord.findUniqueOrThrow({ where: { id: backup.id } })).status).toBe("CORRUPTED");
  });

  it("sem pg_dump, exporta todas as famílias em JSON compactado, sem dados sensíveis", async () => {
    await createFamily("Segunda família");
    const backup = await createDatabaseBackup({ method: "json" });
    expect(backup).toMatchObject({ kind: "HOUSEHOLD_EXPORT", status: "SUCCESS" });
    expect(backup.fileName.endsWith(".json.gz")).toBe(true);
    const file = path.join(dir, backup.fileName);
    const content = (await readJsonBackup(file)) as { format: string; households: Array<{ household: { name: string }; transactions: unknown[] }> };
    expect(content.format).toBe("finance-ai-backup-json");
    expect(content.households.map((h) => h.household.name).sort()).toEqual(["Família Teste", "Segunda família"]);
    expect(content.households.find((h) => h.household.name === "Família Teste")!.transactions).toHaveLength(1);
    const raw = JSON.stringify(content);
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("tokenHash");
    // A exportação do backup não polui a auditoria das famílias.
    expect(await prisma.auditLog.count({ where: { action: "EXPORT" } })).toBe(0);

    const verified = await verifyBackup(backup.id);
    expect(verified).toMatchObject({ ok: true, status: "VERIFIED" });
    expect(verified.structure).toMatch(/2 família/);
  });

  it("aplica retenção (BACKUP_KEEP) e executa o job somente quando o intervalo venceu", async () => {
    setEnv({ BACKUP_KEEP: "2" });
    const first = await createDatabaseBackup({ method: "json" });
    const second = await createDatabaseBackup({ method: "json" });
    const third = await createDatabaseBackup({ method: "json" });
    const remaining = await listBackups();
    expect(remaining.map((b) => b.id).sort()).toEqual([second.id, third.id].sort());
    await expect(stat(path.join(dir, first.fileName))).rejects.toThrow();
    await expect(stat(path.join(dir, `${first.fileName}.sha256`))).rejects.toThrow();
    expect(await applyRetention()).toBe(0);

    // Último backup recente: o job não executa.
    expect(await runBackupIfDue()).toBeNull();
    // Intervalo vencido: cria e verifica.
    const later = new Date(Date.now() + 25 * 3_600_000);
    const created = await runBackupIfDue(later);
    expect(created).not.toBeNull();
    expect(created!.status).toBe("VERIFIED");
    // Idempotente dentro da janela: o backup recém-criado conta como o último.
    expect(await runBackupIfDue()).toBeNull();
    expect((await listBackups()).length).toBe(2);

    // Desativado por configuração.
    setEnv({ BACKUP_INTERVAL_HOURS: "0" });
    expect(await runBackupIfDue(new Date(Date.now() + 100 * 3_600_000))).toBeNull();
  });
  it("rotas da API: listar (administração), criar (somente proprietário) e verificar", async () => {
    const owner = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const wife = await createSession({ userId: fam.wifeCtx.userId!, householdId: fam.householdId });
    const h = (token: string) => ({ cookie: `fa_session=${token}`, origin: "http://localhost:3000" });
    const route = await import("@/app/api/v1/backups/route");
    const verify = await import("@/app/api/v1/backups/[id]/verify/route");
    const none = { params: Promise.resolve({}) };

    expect((await route.GET(new NextRequest("http://localhost:3000/api/v1/backups", { headers: h(wife.token) }), none)).status).toBe(403);
    expect((await route.POST(new NextRequest("http://localhost:3000/api/v1/backups", { method: "POST", headers: h(wife.token) }), none)).status).toBe(403);
    await prisma.householdMember.update({ where: { id: fam.wifeId }, data: { role: "ADMIN" } });
    expect((await route.POST(new NextRequest("http://localhost:3000/api/v1/backups", { method: "POST", headers: h(wife.token) }), none)).status).toBe(403);

    const created = await route.POST(new NextRequest("http://localhost:3000/api/v1/backups", { method: "POST", headers: h(owner.token) }), none);
    expect(created.status).toBe(201);
    const backup = (await created.json()).data as { id: string; status: string; fileName: string };
    expect(backup.status).toBe("VERIFIED");
    expect(JSON.stringify(backup)).not.toContain(dir); // caminho do servidor não é exposto
    const listed = await route.GET(new NextRequest("http://localhost:3000/api/v1/backups", { headers: h(wife.token) }), none);
    expect(((await listed.json()).data as Array<{ id: string }>).map((b) => b.id)).toContain(backup.id);
    const v = await verify.POST(new NextRequest(`http://localhost:3000/api/v1/backups/${backup.id}/verify`, { method: "POST", headers: h(owner.token) }), { params: Promise.resolve({ id: backup.id }) });
    expect((await v.json()).data).toMatchObject({ ok: true, status: "VERIFIED" });
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, entityType: "BackupRecord", action: "CREATE" } })).toBe(1);
  });
});
