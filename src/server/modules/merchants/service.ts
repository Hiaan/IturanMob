import type { Db } from "../../db";
import { normalizeText } from "@/lib/utils";

/** Busca ou cria o estabelecimento pelo nome normalizado. */
export async function findOrCreateMerchant(db: Db, householdId: string, name: string | null | undefined): Promise<string | null> {
  const clean = name?.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) return null;
  const normalizedName = normalizeText(clean);
  if (!normalizedName) return null;
  const merchant = await db.merchant.upsert({
    where: { householdId_normalizedName: { householdId, normalizedName } },
    update: {},
    create: { householdId, name: clean, normalizedName },
  });
  return merchant.id;
}
