import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { getQueue, QUEUE_NAMES } from "@/server/jobs/queues";
import { announceToHouseholds } from "@/server/modules/announcements/service";
import { updatePreferences } from "@/server/modules/notifications/service";
import { createFamily, resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, teardownTestQueues } from "./ai-pipeline-support";

/** Aviso de novidades: prévia sem enviar, uma vez por família, só no chat autorizado, respeita quem desligou. */
describe("aviso de novidades", () => {
  beforeAll(() => initTestQueues("announce"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("prévia, envio único, sem chat e opt-out", async () => {
    const wa = await createWaFamily();
    const noChat = await createFamily("Sem WhatsApp");
    const optOut = await createWaFamily("Desligou avisos");
    await updatePreferences(optOut.ctx, [{ type: "SYSTEM", frequency: "OFF" }]);
    await updatePreferences(optOut.wifeCtx, [{ type: "SYSTEM", frequency: "OFF" }]);
    const input = { id: "novidades-teste", title: "Novidades", text: "Novidades do app: boleto, agenda e bancos." };

    const preview = await announceToHouseholds({ ...input, dryRun: true });
    expect(Object.fromEntries(preview.map((r) => [r.householdId, r.whatsapp]))).toEqual({ [wa.householdId]: "DRY_RUN", [noChat.householdId]: "NO_CHAT", [optOut.householdId]: "SKIPPED_OPT_OUT" });
    expect(await prisma.notification.count()).toBe(0);
    expect(await getQueue(QUEUE_NAMES.outbound).count()).toBe(0);

    const sent = await announceToHouseholds({ ...input, dryRun: false });
    expect(Object.fromEntries(sent.map((r) => [r.householdId, r.whatsapp]))).toEqual({ [wa.householdId]: "QUEUED", [noChat.householdId]: "NO_CHAT", [optOut.householdId]: "SKIPPED_OPT_OUT" });
    expect(await getQueue(QUEUE_NAMES.outbound).count()).toBe(1);
    const jobs = await getQueue(QUEUE_NAMES.outbound).getJobs(["waiting", "delayed", "prioritized"]);
    expect(jobs.map((j) => (j.data as { householdId: string; text: string }).householdId)).toEqual([wa.householdId]);
    // No app também (quem desligou "Sistema" não recebe em lugar nenhum); o WhatsApp vai pela fila, não como notificação.
    expect(await prisma.notification.count({ where: { householdId: wa.householdId, type: "SYSTEM", channel: "IN_APP" } })).toBe(2);
    expect(await prisma.notification.count({ where: { channel: "WHATSAPP" } })).toBe(0);

    const again = await announceToHouseholds({ ...input, dryRun: false });
    expect(again.every((r) => r.whatsapp === "ALREADY_SENT")).toBe(true);
    expect(await getQueue(QUEUE_NAMES.outbound).count()).toBe(1);
    await expect(announceToHouseholds({ ...input, id: "Inválido!", dryRun: true })).rejects.toThrow(/id do aviso/);
  });
});
