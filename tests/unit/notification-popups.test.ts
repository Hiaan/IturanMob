import { describe, expect, it } from "vitest";
import { notificationPriority, notificationUrl } from "@/lib/notification-meta";
import { pickPopups, sortForPopups } from "@/features/notifications/popup-queue";

const n = (id: string, type: string, data: Record<string, unknown> = {}, createdAt = "2026-10-20T12:00:00.000Z", readAt: string | null = null) => ({ id, type, data, createdAt, readAt });

describe("pop-ups de notificação", () => {
  it("ordena por importância (vencida → vence hoje → meta → resto) e, no empate, mais recentes primeiro", () => {
    const items = [
      n("weekly", "WEEKLY_REPORT", {}, "2026-10-20T15:00:00.000Z"),
      n("goal", "INCOME_GOAL", { url: "/metas" }, "2026-10-20T14:00:00.000Z"),
      n("statement-today", "STATEMENT_DUE", { stage: "TODAY" }, "2026-10-20T13:00:00.000Z"),
      n("overdue-old", "BILL_OVERDUE", { stage: "OVERDUE" }, "2026-10-19T09:00:00.000Z"),
      n("overdue-new", "BILL_OVERDUE", { stage: "OVERDUE" }, "2026-10-20T09:00:00.000Z"),
    ];
    expect(sortForPopups(items).map((i) => i.id)).toEqual(["overdue-new", "overdue-old", "statement-today", "goal", "weekly"]);
  });

  it("mostra no máximo 3 não lidos ainda não vistos e indica que há mais", () => {
    const items = [
      n("weekly", "WEEKLY_REPORT"),
      n("goal", "INCOME_GOAL"),
      n("statement-today", "STATEMENT_DUE", { stage: "TODAY" }),
      n("overdue", "BILL_OVERDUE", { stage: "OVERDUE" }),
    ];
    const first = pickPopups(items, new Set());
    expect(first.batch.map((i) => i.id)).toEqual(["overdue", "statement-today", "goal"]);
    expect(first.more).toBe(true);

    // Os já mostrados neste navegador e os lidos ficam de fora.
    const again = pickPopups([...items, n("read", "BILL_OVERDUE", { stage: "OVERDUE" }, undefined, "2026-10-20T16:00:00.000Z")], new Set(first.batch.map((i) => i.id)));
    expect(again.batch.map((i) => i.id)).toEqual(["weekly"]);
    expect(again.more).toBe(false);
    expect(pickPopups(items, new Set(items.map((i) => i.id)))).toEqual({ batch: [], more: false });
  });

  it("considera páginas seguintes no servidor como 'mais'", () => {
    expect(pickPopups([n("a", "SYSTEM")], new Set(), { hasMorePages: true }).more).toBe(true);
  });

  it("usa o destino de data.url (relativo) e cai no do tipo", () => {
    expect(notificationUrl("BILL_OVERDUE", { url: "/contas-a-pagar" })).toBe("/contas-a-pagar");
    expect(notificationUrl("INCOME_GOAL", { url: "//evil.example" })).toBe("/metas");
    expect(notificationPriority("STATEMENT_DUE", { stage: "OVERDUE" })).toBe(0);
  });
});
