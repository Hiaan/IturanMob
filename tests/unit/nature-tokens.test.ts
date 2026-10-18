import { describe, expect, it } from "vitest";
import { detectNatureTokens, stripNatureTokens } from "@/server/ai/nlu/nature";

/** Natureza dita na mensagem: Empresa (PJ) ou Pessoa física (PF), inclusive no meio da frase. */
describe("detectNatureTokens", () => {
  it("Empresa: 'empresa', 'da empresa', 'pra empresa', 'PJ' (fim ou meio da frase)", () => {
    for (const [text, stripped] of [
      ["paguei 750 pro Ícaro, empresa", "paguei 750 pro Ícaro"],
      ["gastei 200 em tráfego, foi da empresa", "gastei 200 em tráfego"],
      ["comprei 30 de pão pra empresa", "comprei 30 de pão"],
      ["uber 30 pj", "uber 30"],
      ["almoço 50 empresa no itaú", "almoço 50 no itaú"],
      ["gastei 80 da empresa no mercado", "gastei 80 no mercado"],
      ["PJ: 120 de gasolina", "120 de gasolina"],
    ] as const) {
      const t = detectNatureTokens(text);
      expect(t, text).toMatchObject({ nature: "BUSINESS", both: false });
      expect(t.stripped, text).toBe(stripped);
    }
  });

  it("Pessoa física: 'PF', 'pessoa física', 'é pessoal', ', pessoal' no fim", () => {
    for (const [text, stripped] of [
      ["mercado 120 pf", "mercado 120"],
      ["farmácia 45 pessoa física no nubank", "farmácia 45 no nubank"],
      ["gastei 60 no restaurante, é pessoal", "gastei 60 no restaurante"],
      ["padaria 20, pessoal", "padaria 20"],
    ] as const) {
      const t = detectNatureTokens(text);
      expect(t, text).toMatchObject({ nature: "PERSONAL", both: false });
      expect(t.stripped, text).toBe(stripped);
    }
  });

  it("sem marcador: nada muda ('almoço com o pessoal', 'pf' de 'por favor' num pedido)", () => {
    expect(detectNatureTokens("almoço com o pessoal 90")).toMatchObject({ nature: null, both: false, stripped: "almoço com o pessoal 90" });
    expect(detectNatureTokens("anota 50 de uber pf")).toMatchObject({ nature: null, both: false });
    expect(detectNatureTokens("gastei 50 no mercado")).toMatchObject({ nature: null, both: false });
    expect(detectNatureTokens("empresarial 30")).toMatchObject({ nature: null });
  });

  it("PF e PJ na mesma mensagem: cada trecho decide", () => {
    expect(detectNatureTokens("mercado 120 pf e uber 30 pj")).toMatchObject({ nature: null, both: true });
    expect(stripNatureTokens("Uber pj")).toBe("Uber");
  });
});
