import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount } from "@/server/modules/accounts/service";
import { quickCreateCategory, updateCategory } from "@/server/modules/categories/service";
import { resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues, txsOf } from "./ai-pipeline-support";

/** Criar categoria fácil: comandos no WhatsApp, oferta "Quer que eu crie? (sim/não)" e criação rápida. */

async function family() {
  const fam = await createWaFamily("Família Categorias");
  await createAccount(fam.ctx, { name: "Conta Corrente", institution: "Banco", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
  return fam;
}

const findCat = (householdId: string, name: string) => prisma.category.findFirst({ where: { householdId, name }, include: { subcategories: true } });

describe("Criar categoria fácil", () => {
  beforeAll(() => initTestQueues("wa-category-commands"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("WhatsApp: 'cria categoria Pet', 'criar subcategoria Ração em Pet', 'nova categoria Escola dentro de Educação'; nada duplica", async () => {
    const fam = await family();
    const hh = fam.householdId;
    const txBefore = await prisma.transaction.count({ where: { householdId: hh } });

    const pet = await sendMessage(fam, { text: "cria categoria Pet" });
    expect(pet.reply).toContain("🏷️ Categoria *Pet* criada (despesa)");
    expect(pet.message.intent).toBe("CREATE_CATEGORY");
    expect(await findCat(hh, "Pet")).toMatchObject({ kind: "EXPENSE", archivedAt: null });

    const racao = await sendMessage(fam, { text: "criar subcategoria Ração em Pet" });
    expect(racao.reply).toContain("Subcategoria *Pet › Ração* criada");
    expect((await findCat(hh, "Pet"))!.subcategories.map((s) => s.name)).toEqual(["Ração"]);

    const escola = await sendMessage(fam, { text: "nova categoria Escola dentro de Educação" });
    expect(escola.reply).toContain("*Educação › Escola*");
    const educacao = await prisma.category.findFirstOrThrow({ where: { householdId: hh, name: "Educação", kind: "EXPENSE" }, include: { subcategories: true } });
    expect(educacao.subcategories.map((s) => s.name)).toContain("Escola");

    const freela = await sendMessage(fam, { text: "cria categoria de receita Freelas" });
    expect(freela.reply).toContain("Categoria *Freelas* criada (receita)");
    expect(await findCat(hh, "Freelas")).toMatchObject({ kind: "INCOME" });

    // Repetir não duplica; mãe inexistente explica; sem mãe pergunta onde.
    const again = await sendMessage(fam, { text: "cria categoria pet" });
    expect(again.reply).toContain("*Pet* já existe");
    expect(await prisma.category.count({ where: { householdId: hh, name: { equals: "pet", mode: "insensitive" } } })).toBe(1);
    const missing = await sendMessage(fam, { text: "criar subcategoria Vacina em Bichos" });
    expect(missing.reply).toContain("Não encontrei a categoria *Bichos*");
    const where = await sendMessage(fam, { text: "criar subcategoria Vacina" });
    expect(where.reply).toContain("Em qual categoria fica *Vacina*?");
    // Comando não cria lançamento.
    expect(await prisma.transaction.count({ where: { householdId: hh } })).toBe(txBefore);

    // A categoria nova já classifica o próximo gasto.
    await sendMessage(fam, { text: "120 ração do totó" });
    const tx = (await txsOf(hh)).find((t) => t.amountCents === 12_000)!;
    expect(tx.subcategory?.name).toBe("Ração");
  });

  it("pergunta da categoria: nome novo → 'Quer que eu crie? (sim/não)'; 'não' não cria; 'cria categoria X' respondendo cria e aplica", async () => {
    const fam = await family();
    const hh = fam.householdId;
    const catsBefore = await prisma.category.count({ where: { householdId: hh } });

    await sendMessage(fam, { text: "45 coleira" });
    const offer = await sendMessage(fam, { text: "Acessórios pet" });
    expect(offer.reply).toContain("Não tenho a categoria *Acessórios pet*. Quer que eu crie? (sim/não)");
    const no = await sendMessage(fam, { text: "não" });
    expect(no.reply).toContain("Ok, não criei. Qual a categoria de *Coleira* (R$ 45,00)?");
    expect(await prisma.category.count({ where: { householdId: hh } })).toBe(catsBefore);
    // Ainda dá para responder com outra categoria (existente).
    const lazer = await sendMessage(fam, { text: "lazer" });
    expect(lazer.reply).toContain("ficou em *Lazer*");
    expect(lazer.reply).not.toContain("criada agora");

    // Respondendo a pergunta com o comando: cria e já aplica (e aprende).
    await sendMessage(fam, { text: "80 banho e tosa" });
    const cmd = await sendMessage(fam, { text: "cria categoria Pet" });
    expect(cmd.reply).toContain("ficou em *Pet* (categoria criada agora)");
    const banho = (await txsOf(hh)).find((t) => t.amountCents === 8_000)!;
    expect(banho.category?.name).toBe("Pet");
    expect(await prisma.clarification.count({ where: { householdId: hh, status: "OPEN" } })).toBe(0);
  });

  it("criação rápida dos seletores: cria categoria ou subcategoria e devolve o que selecionar; reaproveita a existente (e a arquivada)", async () => {
    const fam = await family();
    const pet = await quickCreateCategory(fam.ctx, { name: "pet", kind: "EXPENSE" });
    expect(pet).toMatchObject({ label: "Pet", subcategoryId: null, kind: "EXPENSE", created: true });
    const racao = await quickCreateCategory(fam.ctx, { name: "Ração", parentId: pet.categoryId });
    expect(racao).toMatchObject({ categoryId: pet.categoryId, label: "Pet › Ração", created: true });
    expect(await quickCreateCategory(fam.ctx, { name: "PET" })).toMatchObject({ categoryId: pet.categoryId, created: false });
    expect(await quickCreateCategory(fam.ctx, { name: "ração", parentId: pet.categoryId })).toMatchObject({ subcategoryId: racao.subcategoryId, created: false });
    await updateCategory(fam.ctx, pet.categoryId, { archived: true });
    expect(await quickCreateCategory(fam.ctx, { name: "Pet" })).toMatchObject({ categoryId: pet.categoryId, created: false });
    expect((await prisma.category.findUniqueOrThrow({ where: { id: pet.categoryId } })).archivedAt).toBeNull();
    // Receita com o mesmo nome é outra categoria.
    expect(await quickCreateCategory(fam.ctx, { name: "Pet", kind: "INCOME" })).toMatchObject({ kind: "INCOME", created: true });
    await expect(quickCreateCategory(fam.ctx, { name: "  " })).rejects.toThrow();
  });
});
