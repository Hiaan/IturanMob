import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError } from "../../errors";
import { logger, errorInfo } from "../../logger";
import { normalizeText } from "@/lib/utils";
import { audit } from "../../modules/audit/service";
import { soundKey } from "../nlu/transcript";

/**
 * Dicionário da família para a transcrição: quando alguém corrige a descrição de um lançamento que
 * veio de ÁUDIO ("Revirante" → "Refrigerante"), o par fica guardado e os próximos áudios já saem
 * certos (correção do texto e prompt do Whisper). Só aprende o que SOA parecido — trocar "Mercado"
 * por "Farmácia" é mudança de assunto, não erro de escuta.
 */

const MAX_WORDS = 3;

const words = (s: string) =>
  s
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter(Boolean);

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Soa parecido o bastante para ser erro de escuta ("revirante" ~ "refrigerante"). */
export function soundsAlike(a: string, b: string): boolean {
  const ka = soundKey(a);
  const kb = soundKey(b);
  if (!ka || !kb || ka === kb) return Boolean(ka) && ka === kb;
  const longest = Math.max(ka.length, kb.length);
  return distance(ka, kb) <= Math.max(2, Math.floor(longest * 0.45));
}

/**
 * Pares errado → certo a partir da descrição antiga e da nova: as palavras que mudaram (mesma
 * quantidade de palavras) ou a expressão inteira (até 3 palavras), só quando soam parecido.
 */
export function fixPairs(before: string, after: string): Array<{ wrong: string; wrongDisplay: string; right: string }> {
  const a = words(before).filter((w) => !/^\d/.test(w));
  const b = words(after).filter((w) => !/^\d/.test(w));
  if (!a.length || !b.length) return [];
  const out: Array<{ wrong: string; wrongDisplay: string; right: string }> = [];
  const add = (wrong: string, right: string) => {
    const w = normalizeText(wrong);
    if (w.length < 3 || normalizeText(right) === w || !soundsAlike(wrong, right)) return;
    out.push({ wrong: w, wrongDisplay: wrong.slice(0, 60), right: right.slice(0, 60) });
  };
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) if (normalizeText(a[i]!) !== normalizeText(b[i]!)) add(a[i]!, b[i]!);
    return out;
  }
  if (a.length <= MAX_WORDS && b.length <= MAX_WORDS) add(a.join(" "), b.join(" "));
  return out;
}

/** Guarda os pares de uma correção de descrição (nunca derruba a correção em si). */
export async function learnTranscriptFix(ctx: ServiceContext, before: string, after: string): Promise<number> {
  try {
    const pairs = fixPairs(before, after);
    for (const p of pairs) {
      await prisma.transcriptFix.upsert({
        where: { householdId_wrong: { householdId: ctx.householdId, wrong: p.wrong } },
        create: { householdId: ctx.householdId, wrong: p.wrong, wrongDisplay: p.wrongDisplay, right: p.right, createdByMemberId: ctx.memberId ?? null },
        update: { right: p.right, wrongDisplay: p.wrongDisplay },
      });
    }
    return pairs.length;
  } catch (err) {
    logger.warn({ err: errorInfo(err), householdId: ctx.householdId }, "transcrição: correção não aprendida");
    return 0;
  }
}

export async function transcriptFixesFor(householdId: string): Promise<Array<{ wrong: string; right: string }>> {
  return prisma.transcriptFix.findMany({ where: { householdId }, orderBy: { updatedAt: "desc" }, take: 200, select: { wrong: true, right: true } });
}

export async function listTranscriptFixes(ctx: ServiceContext) {
  const rows = await prisma.transcriptFix.findMany({ where: { householdId: ctx.householdId }, orderBy: { updatedAt: "desc" }, take: 200 });
  return rows.map((r) => ({ id: r.id, wrong: r.wrongDisplay, right: r.right, createdAt: r.createdAt }));
}

export async function deleteTranscriptFix(ctx: ServiceContext, id: string) {
  assertCan(ctx, "transactions:write");
  const row = await prisma.transcriptFix.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!row) throw new NotFoundError("Correção");
  await prisma.transcriptFix.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "TranscriptFix", entityId: id, before: { wrong: row.wrongDisplay, right: row.right } });
  return { ok: true };
}
