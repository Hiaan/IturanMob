import { z } from "zod";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { NotFoundError, ValidationError } from "../../errors";
import { audit } from "../audit/service";
import { getVisibilityScope } from "../visibility/scope";

/**
 * Conta e forma de pagamento padrão de cada pessoa: quando ela registra um gasto (WhatsApp, Isa,
 * lançamento rápido) sem dizer de onde saiu, sai dessa conta, com essa forma de pagamento.
 * Cada pessoa escolhe a sua; só vale para conta que ela enxerga, ativa e não de investimento.
 * Cartão de crédito não entra aqui (gasto no cartão é dito na mensagem ou cai no cartão único).
 */

export const DEFAULT_PAYMENT_METHODS = ["PIX", "DEBIT_CARD", "CASH", "BANK_TRANSFER", "BANK_SLIP", "AUTO_DEBIT", "VOUCHER", "OTHER"] as const;

export const paymentDefaultsSchema = z.object({
  accountId: z.string().min(1).nullable(),
  paymentMethod: z.enum(DEFAULT_PAYMENT_METHODS).nullable(),
});

export interface PaymentDefaults {
  accountId: string | null;
  accountName: string | null;
  paymentMethod: (typeof DEFAULT_PAYMENT_METHODS)[number] | null;
}

function memberIdOf(ctx: ServiceContext): string {
  if (!ctx.memberId) throw new NotFoundError("Membro");
  return ctx.memberId;
}

export async function getPaymentDefaults(ctx: ServiceContext): Promise<PaymentDefaults> {
  const m = await prisma.householdMember.findFirst({
    where: { id: memberIdOf(ctx), householdId: ctx.householdId },
    select: { defaultPaymentMethod: true, defaultAccount: { select: { id: true, name: true, archivedAt: true } } },
  });
  const acc = m?.defaultAccount && !m.defaultAccount.archivedAt ? m.defaultAccount : null;
  const method = m?.defaultPaymentMethod && (DEFAULT_PAYMENT_METHODS as readonly string[]).includes(m.defaultPaymentMethod) ? (m.defaultPaymentMethod as PaymentDefaults["paymentMethod"]) : null;
  return { accountId: acc?.id ?? null, accountName: acc?.name ?? null, paymentMethod: method };
}

export async function setPaymentDefaults(ctx: ServiceContext, raw: z.input<typeof paymentDefaultsSchema>): Promise<PaymentDefaults> {
  const memberId = memberIdOf(ctx);
  const data = paymentDefaultsSchema.parse(raw);
  if (data.accountId) {
    const scope = await getVisibilityScope(ctx);
    const acc = await prisma.account.findFirst({ where: { id: data.accountId, householdId: ctx.householdId, archivedAt: null }, select: { id: true, type: true } });
    if (!acc || scope.hiddenAccountIds.includes(acc.id)) throw new ValidationError("Conta não encontrada.", { field: "accountId" });
    if (acc.type === "INVESTMENT") throw new ValidationError("Conta de investimento não pode ser a conta padrão de pagamento.", { field: "accountId" });
  }
  const before = await getPaymentDefaults(ctx);
  await prisma.householdMember.update({ where: { id: memberId }, data: { defaultAccountId: data.accountId, defaultPaymentMethod: data.paymentMethod } });
  const after = await getPaymentDefaults(ctx);
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "HouseholdMember", entityId: memberId, before, after });
  return after;
}
