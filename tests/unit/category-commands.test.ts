import { describe, expect, it } from "vitest";
import { parseCategoryCommand } from "@/server/ai/engine/category-commands";
import { makeHouseholdContext } from "../helpers/household-context";

/** "cria categoria Pet", "nova categoria Escola dentro de Educação", "criar subcategoria Ração em Pet". */
describe("parseCategoryCommand", () => {
  const hc = makeHouseholdContext();

  it("categoria simples, de receita e com aspas", () => {
    expect(parseCategoryCommand("cria categoria Pet", hc)).toEqual({ name: "Pet", parentName: null, sub: false, kind: "EXPENSE" });
    expect(parseCategoryCommand("Nova categoria: “Viagens”", hc)).toEqual({ name: "Viagens", parentName: null, sub: false, kind: "EXPENSE" });
    expect(parseCategoryCommand("cria categoria de receita Freelas", hc)).toMatchObject({ name: "Freelas", kind: "INCOME" });
    expect(parseCategoryCommand("criar uma nova categoria Consórcio (de despesa)", hc)).toMatchObject({ name: "Consórcio", kind: "EXPENSE" });
  });

  it("dentro de / em: subcategoria; 'em' só separa quando a mãe existe", () => {
    expect(parseCategoryCommand("nova categoria Escola dentro de Educação", hc)).toEqual({ name: "Escola", parentName: "Educação", sub: false, kind: "EXPENSE" });
    expect(parseCategoryCommand("criar subcategoria Ração em Pet", hc)).toEqual({ name: "Ração", parentName: "Pet", sub: true, kind: "EXPENSE" });
    expect(parseCategoryCommand("cria subcategoria Petiscos da Pet", hc)).toMatchObject({ name: "Petiscos", parentName: "Pet", sub: true });
    expect(parseCategoryCommand("cria categoria Natação em Lazer", hc)).toMatchObject({ name: "Natação", parentName: "Lazer" });
    // "casa" não é categoria: o nome é "Comida em casa".
    expect(parseCategoryCommand("cria categoria Comida em casa", hc)).toMatchObject({ name: "Comida em casa", parentName: null });
  });

  it("incompletos e frases que não são comando", () => {
    expect(parseCategoryCommand("cria categoria", hc)).toMatchObject({ name: "" });
    expect(parseCategoryCommand("criar subcategoria Ração", hc)).toMatchObject({ name: "Ração", parentName: null, sub: true });
    expect(parseCategoryCommand("gastei 50 na categoria lazer", hc)).toBeNull();
    expect(parseCategoryCommand("qual a categoria do mercado?", hc)).toBeNull();
    expect(parseCategoryCommand("mercado 120", hc)).toBeNull();
  });
});
