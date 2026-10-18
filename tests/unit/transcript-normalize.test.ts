import { describe, expect, it } from "vitest";
import { normalizeTranscript, soundKey } from "@/server/ai/nlu/transcript";
import { detectNatureTokens } from "@/server/ai/nlu/nature";
import { parseLocally } from "@/server/ai/nlu/local-parser";
import { extractAmounts } from "@/server/ai/nlu/numbers";
import { makeHouseholdContext } from "../helpers/household-context";

/**
 * Transcrições reais do Whisper (modelo base, medidas pela sessão T9) e o que precisa sair delas
 * antes do interpretador: natureza, conta/cartão e nome certos; valores intactos.
 */
const vocab = { accounts: ["Nubank", "Itaú", "Inter", "C6 Black", "Wise"], names: ["Ícaro", "Daniel", "Guilherme", "Queren", "João", "Maria"] };
const hc = makeHouseholdContext();

describe("normalizeTranscript", () => {
  it("frases reais: 'proí caro em presa', 'no banque, pessoal', 'R$ 750 pro Ícaro. Empresa.', 'R$ 45 no cartão Nubank. Pessoal.'", () => {
    const a = normalizeTranscript("Paguei 750 reais proí caro em presa.", vocab);
    expect(a).toBe("Paguei 750 reais pro Ícaro empresa.");
    expect(detectNatureTokens(a).nature).toBe("BUSINESS");
    const pa = parseLocally(detectNatureTokens(a).stripped, hc);
    expect(pa.drafts[0]).toMatchObject({ amountCents: 75_000 });
    expect(pa.drafts[0]!.description).toContain("Ícaro");

    const b = normalizeTranscript("Almoço 45 reais no cartão no banque, pessoal!", vocab);
    expect(b).toBe("Almoço 45 reais no cartão Nubank, pessoal!");
    expect(detectNatureTokens(b).nature).toBe("PERSONAL");
    expect(parseLocally(detectNatureTokens(b).stripped, hc).drafts[0]).toMatchObject({ amountCents: 4_500, cardHint: "Nubank Crédito" });

    const c = normalizeTranscript("Paguei R$ 750 pro Ícaro. Empresa.", vocab);
    expect(c).toBe("Paguei R$ 750 pro Ícaro. Empresa.");
    expect(detectNatureTokens(c).nature).toBe("BUSINESS");
    const pc = parseLocally(detectNatureTokens(c).stripped, hc);
    expect(pc.drafts[0]).toMatchObject({ amountCents: 75_000 });
    expect(pc.drafts[0]!.description).not.toMatch(/\bR\b/);

    const d = normalizeTranscript("Almoço, R$ 45 no cartão Nubank. Pessoal.", vocab);
    expect(detectNatureTokens(d).nature).toBe("PERSONAL");
    const pd = parseLocally(detectNatureTokens(d).stripped, hc);
    expect(pd.drafts[0]).toMatchObject({ amountCents: 4_500, cardHint: "Nubank Crédito" });
    expect(pd.drafts[0]!.description).toBe("Almoço");
  });

  it("'no bank' e 'Personal' (base com beam 5); valores R$ 750, R$120 e R$ 87,50 intactos", () => {
    expect(normalizeTranscript("Almoço 45 no cartão no bank. Personal.", vocab)).toBe("Almoço 45 no cartão Nubank. pessoal.");
    expect(normalizeTranscript("gasolina 80, é personal", vocab)).toBe("gasolina 80, é pessoal");
    for (const [t, cents] of [["R$ 750 pro Ícaro", 75_000], ["mercado R$120", 12_000], ["uber R$ 87,50 no nubank", 8_750]] as const) {
      expect(extractAmounts(normalizeTranscript(t, vocab)).map((x) => x.cents)).toEqual([cents]);
    }
  });

  it("não troca o que não deve: 'no banco', 'ficou caro', 'personal trainer', nomes já certos, ambíguos", () => {
    expect(normalizeTranscript("paguei 30 no banco", vocab)).toBe("paguei 30 no banco");
    expect(normalizeTranscript("o almoço ficou caro, 90 reais", vocab)).toBe("o almoço ficou caro, 90 reais");
    expect(normalizeTranscript("paguei 200 do personal trainer", vocab)).toBe("paguei 200 do personal trainer");
    expect(normalizeTranscript("pix de 50 pro Daniel no Inter", vocab)).toBe("pix de 50 pro Daniel no Inter");
    // Dois nomes com o mesmo som: fica como está.
    expect(normalizeTranscript("pix 40 pra kerem", { accounts: [], names: ["Queren", "Kerem"] })).toBe("pix 40 pra kerem");
    expect(normalizeTranscript("sem vocabulário", { accounts: [], names: [] })).toBe("sem vocabulário");
  });

  it("chave sonora", () => {
    expect(soundKey("no banque")).toBe(soundKey("Nubank"));
    expect(soundKey("no bank")).toBe(soundKey("Nubank"));
    expect(soundKey("proí caro")).toBe(soundKey("pro Ícaro"));
    expect(soundKey("no banco")).toBe(soundKey("Nubank")); // por isso "no banco" é protegido pela lista de palavras comuns
  });
});
