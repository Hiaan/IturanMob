import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { getPlatformStatus, requestUpdate, runPlatformNotifications, sendAnnouncement } from "@/server/modules/instance/platform";
import { createFamily, resetDatabase } from "./helpers";

/**
 * Painel da instalação: só o administrador (dono da primeira família) vê e age; o servidor grava o
 * sinal de vida e o resultado das atualizações, e o worker avisa o administrador uma única vez.
 */

async function hostSignal(value: Record<string, unknown>) {
  await prisma.platformSetting.upsert({ where: { key: "host" }, create: { key: "host", value: value as object }, update: { value: value as object } });
}

describe("painel da instalação", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("só o administrador vê o painel, pede atualização (sem duplicar) e manda avisos", async () => {
    const admin = await createFamily("Família Admin");
    const other = await createFamily("Outra Família");
    await expect(getPlatformStatus(other.ctx)).rejects.toThrow(/administrador/);
    await expect(getPlatformStatus(admin.wifeCtx)).rejects.toThrow(/administrador/);
    await expect(requestUpdate(other.ctx)).rejects.toThrow(/administrador/);
    await expect(sendAnnouncement(other.ctx, { title: "Oi", text: "Mensagem qualquer aqui", send: true })).rejects.toThrow(/administrador/);

    // Sem sinal do servidor: atualização automática aparece desligada.
    const before = await getPlatformStatus(admin.ctx);
    expect(before.autoUpdate).toMatchObject({ enabled: false, online: false });
    expect(before.health.households).toBe(2);

    await hostSignal({ checkedAt: new Date().toISOString(), autoUpdate: true, channel: "producao", installed: "aaaaaaa1111", available: "bbbbbbb2222", diskFreeGb: 12, memAvailableMb: 1500, offsiteBackup: false, window: "03:00" });
    const status = await getPlatformStatus(admin.ctx);
    expect(status.autoUpdate).toMatchObject({ enabled: true, online: true, window: "03:00", pendingRequestAt: null });
    expect(status.version).toMatchObject({ installed: "aaaaaaa", available: "bbbbbbb", upToDate: false });
    expect(status.health).toMatchObject({ diskFreeGb: 12, offsiteBackup: false });

    const r1 = await requestUpdate(admin.ctx);
    const r2 = await requestUpdate(admin.ctx);
    expect([r1.alreadyPending, r2.alreadyPending]).toEqual([false, true]);
    expect(await prisma.platformEvent.count({ where: { kind: "UPDATE_REQUEST", status: "PENDING" } })).toBe(1);
    expect((await getPlatformStatus(admin.ctx)).autoUpdate.pendingRequestAt).not.toBeNull();

    // Aviso: prévia não envia nada; envio cria a notificação no app de cada família; repetir não duplica.
    const msg = { title: "Novidades", text: "Agora a Isa entende compras parceladas." };
    const preview = await sendAnnouncement(admin.ctx, { ...msg, send: false });
    expect(preview).toMatchObject({ sent: false, households: 2 });
    expect(await prisma.notification.count({ where: { type: "SYSTEM" } })).toBe(0);
    await sendAnnouncement(admin.ctx, { ...msg, send: true });
    const inApp = await prisma.notification.groupBy({ by: ["householdId"], where: { type: "SYSTEM", channel: "IN_APP" }, _count: { _all: true } });
    expect(inApp).toHaveLength(2);
    const again = await sendAnnouncement(admin.ctx, { ...msg, send: true });
    expect(again.alreadySent).toBe(2);
    expect(await prisma.notification.count({ where: { type: "SYSTEM", channel: "IN_APP" } })).toBe(inApp.reduce((s, g) => s + g._count._all, 0));
  });

  it("resultado da atualização vira aviso só para o administrador, uma vez; servidor calado também avisa", async () => {
    const admin = await createFamily("Família Admin");
    const other = await createFamily("Outra Família");
    await prisma.platformEvent.create({ data: { kind: "UPDATE", status: "ROLLED_BACK", version: "ccccccc3333", message: "A atualização não subiu e o sistema voltou sozinho para a versão anterior." } });

    expect((await runPlatformNotifications()).notified).toBe(1);
    expect((await runPlatformNotifications()).notified).toBe(0);
    const notes = await prisma.notification.findMany({ where: { type: "SYSTEM", channel: "IN_APP" } });
    expect(notes.map((n) => [n.householdId, n.recipientMemberId, n.title])).toEqual([[admin.householdId, admin.husbandId, "Atualização desfeita"]]);
    expect(notes.some((n) => n.householdId === other.householdId)).toBe(false);

    const status = await getPlatformStatus(admin.ctx);
    expect(status.updates).toEqual([expect.objectContaining({ status: "ROLLED_BACK", version: "ccccccc" })]);

    // Sem sinal há mais de 2 horas com a atualização automática ligada: um aviso por dia.
    await hostSignal({ checkedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), autoUpdate: true });
    expect((await runPlatformNotifications()).notified).toBe(1);
    expect((await runPlatformNotifications()).notified).toBe(0);
    expect(await prisma.notification.count({ where: { title: "Servidor sem sinal", recipientMemberId: admin.husbandId } })).toBe(1);
    expect((await getPlatformStatus(admin.ctx)).autoUpdate.online).toBe(false);
  });
});
