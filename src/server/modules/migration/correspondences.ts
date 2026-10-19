import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { parseNatureValue, valueKey } from "./columns";
import { readMatrixRows, readSheetRows, subcategoryKey } from "./rows";
import type { RawSheet } from "./workbook";
import type { Correspondence, CorrespondenceField, CorrespondenceSuggestion, SheetConfig } from "./types";

/**
 * Correspondências "De → Para": cada valor distinto das colunas de categoria, subcategoria, conta,
 * cartão, pessoa e natureza, com quantas linhas usam e a soma, e uma sugestão de destino:
 * igual → parecido (acentos, plural, abreviação) → sinônimo (palavras-chave da família e lista
 * comum) → IA (opcional, só com os nomes). A sugestão nunca é aplicada sem a pessoa aceitar.
 */

export interface Catalog {
  categories: Array<{ id: string; name: string; kind: "EXPENSE" | "INCOME"; subcategories: Array<{ id: string; name: string; keywords: string[] }> }>;
  accounts: Array<{ id: string; name: string; institution: string | null; type: string }>;
  cards: Array<{ id: string; name: string; issuer: string | null; last4: string | null }>;
  members: Array<{ id: string; name: string }>;
  currentMemberId: string;
}

const FIELDS: CorrespondenceField[] = ["category", "subcategory", "account", "card", "person", "nature"];

// -----------------------------------------------------------------------------
// Coleta dos valores distintos
// -----------------------------------------------------------------------------

export function collectCorrespondences(sheets: Array<{ sheet: RawSheet; cfg: SheetConfig }>, contextYear: number): Correspondence[] {
  const map = new Map<string, Correspondence & { _in: number; _out: number }>();
  const add = (field: CorrespondenceField, key: string, label: string, parentLabel: string | null, cents: number | null, signKnown: boolean) => {
    if (!key) return;
    const id = `${field}|${key}`;
    let item = map.get(id);
    if (!item) {
      item = { field, key, label, parentLabel, count: 0, sumCents: 0, inCents: 0, outCents: 0, kindHint: null, suggestion: null, decision: null, fromTemplate: false, _in: 0, _out: 0 };
      map.set(id, item);
    }
    item.count++;
    if (cents !== null) {
      item.sumCents += Math.abs(cents);
      if (signKnown && cents > 0) {
        item.inCents += cents;
        item._in++;
      } else if (signKnown && cents < 0) {
        item.outCents += -cents;
        item._out++;
      }
    }
  };

  for (const { sheet, cfg } of sheets) {
    if (!cfg.selected) continue;
    if (cfg.kind === "MATRIX") {
      if (!cfg.matrixMode) continue;
      for (const r of readMatrixRows(sheet, cfg).rows) {
        const total = r.months.reduce((s, m) => s + Math.abs(m.cents), 0);
        const signed = r.section === "INCOME" ? total : r.section === "EXPENSE" ? -total : null;
        add("category", r.key, r.label, null, signed ?? total, signed !== null);
      }
      continue;
    }
    if (cfg.kind !== "LIST" && cfg.kind !== "MONTH") continue;
    for (const v of readSheetRows(sheet, cfg, contextYear).rows) {
      const cents = v.amountCents;
      const known = !v.signFromCategory;
      if (v.values.category) add("category", valueKey(v.values.category), v.values.category, null, cents, known);
      if (v.values.subcategory) add("subcategory", subcategoryKey(v.values.category, v.values.subcategory), v.values.subcategory, v.values.category || null, cents, known);
      if (v.values.account) add("account", valueKey(v.values.account), v.values.account, null, cents, known);
      if (v.values.card) add("card", valueKey(v.values.card), v.values.card, null, cents, known);
      if (v.values.person) add("person", valueKey(v.values.person), v.values.person, null, cents, known);
      if (v.values.nature) add("nature", valueKey(v.values.nature), v.values.nature, null, cents, known);
    }
  }
  return [...map.values()]
    .map(({ _in, _out, ...c }) => ({ ...c, kindHint: _in && _out ? ("MIXED" as const) : _in ? ("INCOME" as const) : _out ? ("EXPENSE" as const) : null }))
    .sort((a, b) => FIELDS.indexOf(a.field) - FIELDS.indexOf(b.field) || b.count - a.count || a.label.localeCompare(b.label, "pt-BR"));
}

/** Mantém decisões e sugestões de IA já feitas para os mesmos valores. */
export function mergeCorrespondences(fresh: Correspondence[], previous: Correspondence[]): Correspondence[] {
  const prev = new Map(previous.map((c) => [`${c.field}|${c.key}`, c]));
  return fresh.map((c) => {
    const p = prev.get(`${c.field}|${c.key}`);
    if (!p) return c;
    return { ...c, decision: p.decision, fromTemplate: p.fromTemplate, suggestion: p.suggestion?.source === "AI" || p.suggestion?.source === "TEMPLATE" ? p.suggestion : c.suggestion };
  });
}

// -----------------------------------------------------------------------------
// Sugestões
// -----------------------------------------------------------------------------

const STOP = new Set(["de", "da", "do", "das", "dos", "e", "com", "para", "pra", "a", "o", "as", "os", "em", "no", "na"]);

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("oes")) return `${w.slice(0, -3)}ao`;
  if (w.length > 4 && w.endsWith("aes")) return `${w.slice(0, -3)}ao`;
  if (w.length > 4 && /(r|z|s|l)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("is") && !w.endsWith("eis")) return `${w.slice(0, -2)}l`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function stem(text: string): string {
  return normalizeText(text)
    .split(" ")
    .filter((w) => w && !STOP.has(w))
    .map(singular)
    .join(" ");
}

export interface CategoryOption {
  targetType: "CATEGORY" | "SUBCATEGORY";
  id: string;
  label: string;
  name: string;
  kind: "EXPENSE" | "INCOME";
  categoryName: string;
  keywords: string[];
}

export function categoryOptions(catalog: Catalog): CategoryOption[] {
  const out: CategoryOption[] = [];
  for (const c of catalog.categories) {
    out.push({ targetType: "CATEGORY", id: c.id, label: c.name, name: c.name, kind: c.kind, categoryName: c.name, keywords: [] });
    for (const s of c.subcategories) out.push({ targetType: "SUBCATEGORY", id: s.id, label: `${c.name} › ${s.name}`, name: s.name, kind: c.kind, categoryName: c.name, keywords: s.keywords });
  }
  return out;
}

/** Sinônimos comuns em planilhas de família (só sugerem destinos que existem na família). */
const CATEGORY_SYNONYMS: Array<[RegExp, string, "EXPENSE" | "INCOME" | null]> = [
  [/^(mercado|supermercado|compra mes|rancho|mercadinho|atacado)$/, "Alimentação › Supermercado", "EXPENSE"],
  [/^(comida|alimentacao|refeicao|alimento)$/, "Alimentação", "EXPENSE"],
  [/^(restaurante|almoco|jantar|comer fora|refeicao fora)$/, "Alimentação › Restaurantes", "EXPENSE"],
  [/^(ifood|delivery|pedido|lanche)$/, "Alimentação › Delivery", "EXPENSE"],
  [/^(combustivel|gasolina|posto|etanol|abastecimento|alcool|diesel)$/, "Transporte › Combustível", "EXPENSE"],
  [/^(uber|99|taxi|aplicativo transporte|app transporte|corrida)$/, "Transporte › Aplicativos de transporte", "EXPENSE"],
  [/^(carro|veiculo|auto|moto|transporte publico|onibu)$/, "Transporte", "EXPENSE"],
  [/^(luz|energia|energia eletrica|conta luz|eletricidade)$/, "Moradia › Energia", "EXPENSE"],
  [/^(agua|conta agua|saneamento)$/, "Moradia › Água", "EXPENSE"],
  [/^(internet|telefone|celular|net|wifi|telefonia)$/, "Moradia › Internet", "EXPENSE"],
  [/^(casa|moradia|habitacao|lar|conta casa)$/, "Moradia", "EXPENSE"],
  [/^(farmacia|remedio|medicamento|drogaria)$/, "Saúde › Medicamentos", "EXPENSE"],
  [/^(medico|consulta|dentista)$/, "Saúde › Consultas", "EXPENSE"],
  [/^(plano saude|convenio|convenio medico)$/, "Saúde › Plano de saúde", "EXPENSE"],
  [/^(filho|filha|crianca|bebe|kid)$/, "Família", "EXPENSE"],
  [/^(lazer|diversao|passeio|entretenimento)$/, "Lazer", "EXPENSE"],
  [/^(viagem|feria|turismo)$/, "Lazer › Viagens", "EXPENSE"],
  [/^(roupa|vestuario|calcado)$/, "Compras › Roupas", "EXPENSE"],
  [/^(presente)$/, "Compras › Presentes", "EXPENSE"],
  [/^(assinatura|streaming)$/, "Assinaturas", "EXPENSE"],
  [/^(academia|ginastica)$/, "Assinaturas › Serviços recorrentes", "EXPENSE"],
  [/^(imposto|taxa|tributo)$/, "Outras › Impostos", "EXPENSE"],
  [/^(tarifa|tarifa bancaria|juro|iof|anuidade)$/, "Outras › Tarifas", "EXPENSE"],
  [/^(doacao|dizimo|oferta)$/, "Outras › Doações", "EXPENSE"],
  [/^(diverso|outro|outra|geral|variado|sem categoria|nao classificado|outra despesa)$/, "Outras › Despesas não classificadas", "EXPENSE"],
  [/^(diverso|outro|outra|geral|outra receita)$/, "Outras receitas › Outros", "INCOME"],
  [/^(salario|holerite|contracheque|ordenado|pagamento salario)$/, "Trabalho › Salário", "INCOME"],
  [/^(freela|freelance|renda extra|bico|servico prestado)$/, "Trabalho › Serviços", "INCOME"],
  [/^(rendimento|juro recebido|investimento|aplicacao|dividendo)$/, "Investimentos › Rendimentos", "INCOME"],
  [/^(reembolso|estorno|cashback|devolucao)$/, "Outras receitas › Reembolsos", "INCOME"],
  [/^(venda)$/, "Outras receitas › Vendas", "INCOME"],
  [/^(educacao|estudo|curso|faculdade)$/, "Educação", "EXPENSE"],
];

function pick(options: CategoryOption[], kindHint: Correspondence["kindHint"]): CategoryOption | null {
  if (!options.length) return null;
  const byKind = kindHint === "EXPENSE" || kindHint === "INCOME" ? options.filter((o) => o.kind === kindHint) : options;
  const list = byKind.length ? byKind : options;
  // Categoria antes de subcategoria; ainda ambíguo → sem sugestão.
  const cats = list.filter((o) => o.targetType === "CATEGORY");
  if (cats.length === 1) return cats[0]!;
  if (cats.length > 1) return null;
  return list.length === 1 ? list[0]! : null;
}

function resolvePath(path: string, kind: "EXPENSE" | "INCOME" | null, options: CategoryOption[]): CategoryOption | null {
  const [cat, sub] = path.split(" › ");
  const nc = normalizeText(cat ?? "");
  const ns = sub ? normalizeText(sub) : null;
  const hit = options.find((o) => normalizeText(o.categoryName) === nc && (kind === null || o.kind === kind) && (ns ? o.targetType === "SUBCATEGORY" && normalizeText(o.name) === ns : o.targetType === "CATEGORY"));
  return hit ?? null;
}

const toSuggestion = (o: CategoryOption, source: CorrespondenceSuggestion["source"], confidence: number): CorrespondenceSuggestion => ({ targetType: o.targetType, targetId: o.id, label: o.label, source, confidence });

export function suggestCategory(label: string, kindHint: Correspondence["kindHint"], catalog: Catalog, parentLabel: string | null = null): CorrespondenceSuggestion | null {
  const options = categoryOptions(catalog);
  const n = normalizeText(label);
  if (!n) return null;
  const s = stem(label);

  // "Moradia > Luz", "Moradia / Luz", "Moradia - Luz", "Moradia: Luz".
  const parts = label.split(/\s*(?:>|›|»|\/|:|\s-\s)\s*/).filter((p) => p.trim());
  if (parts.length === 2) {
    const [a, b] = parts as [string, string];
    const sub = options.find((o) => o.targetType === "SUBCATEGORY" && stem(o.categoryName) === stem(a) && stem(o.name) === stem(b));
    if (sub) return toSuggestion(sub, "EXACT", 1);
  }

  // Subcategoria com a categoria da mesma linha.
  if (parentLabel) {
    const ps = stem(parentLabel);
    const inParent = options.filter((o) => o.targetType === "SUBCATEGORY" && stem(o.categoryName) === ps);
    const exact = inParent.find((o) => normalizeText(o.name) === n) ?? inParent.find((o) => stem(o.name) === s);
    if (exact) return toSuggestion(exact, "EXACT", 0.95);
  }

  const exactCat = pick(options.filter((o) => o.targetType === "CATEGORY" && normalizeText(o.name) === n), kindHint);
  if (exactCat) return toSuggestion(exactCat, "EXACT", 1);
  const exactSub = pick(options.filter((o) => o.targetType === "SUBCATEGORY" && normalizeText(o.name) === n), kindHint);
  if (exactSub) return toSuggestion(exactSub, "EXACT", 0.95);

  // Acentos, plural, "de/da".
  const similar = pick(options.filter((o) => stem(o.name) === s), kindHint);
  if (similar) return toSuggestion(similar, "SIMILAR", 0.9);

  // Palavra-chave da subcategoria (cadastrada pela família ou padrão).
  const byKeyword = pick(
    options.filter((o) => o.keywords.some((k) => k === n || stem(k) === s)),
    kindHint,
  );
  if (byKeyword) return toSuggestion(byKeyword, "SYNONYM", 0.85);

  for (const [re, path, kind] of CATEGORY_SYNONYMS) {
    if (!re.test(s)) continue;
    if (kind && kindHint && kindHint !== "MIXED" && kindHint !== kind) continue;
    const hit = resolvePath(path, kind, options);
    if (hit) return toSuggestion(hit, "SYNONYM", 0.8);
  }

  // Abreviação: "Alim.", "Transp", "Educ".
  const abbr = n.replace(/\s+/g, "");
  if (abbr.length >= 3 && (abbr.length <= 6 || /\.\s*$/.test(label))) {
    const pref = pick(options.filter((o) => normalizeText(o.name).replace(/\s+/g, "").startsWith(abbr)), kindHint);
    if (pref) return toSuggestion(pref, "SIMILAR", 0.7);
  }

  // Palavra-chave contida ("Conta de luz da casa" → Energia): vale a palavra-chave mais longa.
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const longest = new Map<CategoryOption, number>();
  for (const o of options) {
    const len = Math.max(0, ...o.keywords.filter((k) => k.length >= 4 && new RegExp(`(^| )${esc(k)}( |$)`).test(n)).map((k) => k.length));
    if (len) longest.set(o, len);
  }
  const maxLen = Math.max(0, ...longest.values());
  const contained = maxLen ? pick([...longest].filter(([, l]) => l === maxLen).map(([o]) => o), kindHint) : null;
  if (contained) return toSuggestion(contained, "SYNONYM", 0.65);

  // Palavras em comum.
  let best: CategoryOption | null = null;
  let bestScore = 0;
  let tie = false;
  for (const o of options) {
    const sc = tokenSimilarity(s, stem(o.name));
    if (sc > bestScore + 1e-9) {
      best = o;
      bestScore = sc;
      tie = false;
    } else if (Math.abs(sc - bestScore) < 1e-9 && sc > 0) tie = true;
  }
  if (best && !tie && bestScore >= 0.5 && (kindHint !== "EXPENSE" && kindHint !== "INCOME" ? true : best.kind === kindHint)) return toSuggestion(best, "SIMILAR", 0.55);
  return null;
}

const BANK_ALIASES: Record<string, string> = {
  bb: "banco do brasil",
  "banco brasil": "banco do brasil",
  cef: "caixa",
  "caixa economica": "caixa",
  "caixa economica federal": "caixa",
  nu: "nubank",
  "nu pagamentos": "nubank",
  roxinho: "nubank",
  "itau unibanco": "itau",
  "banco inter": "inter",
  "c6 bank": "c6",
  mp: "mercado pago",
};
// Palavras que não identificam a conta (inclui a forma de pagamento: "Pix Inter" → Inter).
const GENERIC = new Set(["conta", "corrente", "cartao", "credito", "debito", "banco", "digital", "de", "do", "da", "pix", "ted", "doc", "boleto", "transferencia", "transf", "automatico", "via", "no", "na", "pelo", "pela"]);
const CARD_WORDS = /\b(cartao|credito|visa|master|mastercard|elo|amex|hipercard|black|platinum|gold|infinite)\b/;

function significantTokens(text: string): string[] {
  const n = normalizeText(text);
  const alias = BANK_ALIASES[n];
  return (alias ?? n).split(" ").filter((w) => w && !GENERIC.has(w));
}

export function suggestDestination(label: string, field: "account" | "card", catalog: Catalog): CorrespondenceSuggestion | null {
  const n = normalizeText(label);
  if (!n) return null;
  const wantsCard = field === "card" || CARD_WORDS.test(n);
  const cards = catalog.cards.map((c) => ({ targetType: "CARD" as const, id: c.id, name: c.name, extra: c.issuer, last4: c.last4 }));
  const accounts = field === "card" ? [] : catalog.accounts.map((a) => ({ targetType: "ACCOUNT" as const, id: a.id, name: a.name, extra: a.institution, last4: null as string | null }));
  const pool = wantsCard ? [...cards, ...accounts] : [...accounts, ...cards];
  const sug = (o: (typeof pool)[number], source: CorrespondenceSuggestion["source"], confidence: number): CorrespondenceSuggestion => ({ targetType: o.targetType, targetId: o.id, label: o.name, source, confidence });

  const exact = pool.filter((o) => normalizeText(o.name) === n);
  if (exact.length === 1) return sug(exact[0]!, "EXACT", 1);
  if (exact.length > 1) {
    const typed = exact.filter((o) => (wantsCard ? o.targetType === "CARD" : o.targetType === "ACCOUNT"));
    if (typed.length === 1) return sug(typed[0]!, "EXACT", 0.95);
  }
  const digits = /\b(\d{4})\b/.exec(label)?.[1];
  if (digits) {
    const byLast4 = cards.filter((c) => c.last4 === digits);
    if (byLast4.length === 1) return sug(byLast4[0]!, "SIMILAR", 0.85);
  }
  const tokens = significantTokens(label);
  if (!tokens.length) return null;
  // Todas as palavras da planilha aparecem no nome/instituição; com empate, o nome com menos palavras a mais
  // ("Itaú" → "Itaú Corrente", não "Poupança Itaú").
  const scored = pool
    .map((o) => {
      const own = new Set([...significantTokens(o.name), ...(o.extra ? significantTokens(o.extra) : [])]);
      const covers = tokens.every((t) => own.has(t) || [...own].some((w) => w.length >= 4 && (w.startsWith(t) || t.startsWith(w))));
      const nameTokens = significantTokens(o.name);
      return { o, covers, extra: nameTokens.filter((w) => !tokens.includes(w)).length };
    })
    .filter((x) => x.covers);
  const best = (list: typeof scored) => {
    if (!list.length) return null;
    const min = Math.min(...list.map((x) => x.extra));
    const top = list.filter((x) => x.extra === min);
    return top.length === 1 ? top[0]!.o : null;
  };
  const typed = best(scored.filter((x) => (wantsCard ? x.o.targetType === "CARD" : x.o.targetType === "ACCOUNT")));
  if (typed) return sug(typed, "SIMILAR", 0.8);
  const any = best(scored);
  if (any) return sug(any, "SIMILAR", 0.7);
  return null;
}

export function suggestMember(label: string, catalog: Catalog): CorrespondenceSuggestion | null {
  const n = normalizeText(label);
  if (!n || /^(ambos|casal|familia|nos|todos|conjunto|compartilhado)$/.test(n)) return null;
  const exact = catalog.members.filter((m) => normalizeText(m.name) === n);
  if (exact.length === 1) return { targetType: "MEMBER", targetId: exact[0]!.id, label: exact[0]!.name, source: "EXACT", confidence: 1 };
  const first = catalog.members.filter((m) => normalizeText(m.name).split(" ")[0] === n.split(" ")[0]);
  if (first.length === 1) return { targetType: "MEMBER", targetId: first[0]!.id, label: first[0]!.name, source: "SIMILAR", confidence: 0.8 };
  if (/^(eu|eu mesmo|eu mesma|meu|minha)$/.test(n)) {
    const me = catalog.members.find((m) => m.id === catalog.currentMemberId);
    if (me) return { targetType: "MEMBER", targetId: me.id, label: me.name, source: "SIMILAR", confidence: 0.6 };
  }
  return null;
}

const NATURE_LABELS = { PERSONAL: "Pessoal", BUSINESS: "Empresa", PASSTHROUGH: "Repasse de cliente" } as const;

export function suggestNature(label: string): CorrespondenceSuggestion | null {
  const v = parseNatureValue(label);
  return v ? { targetType: "NATURE", targetId: v, label: NATURE_LABELS[v], source: "EXACT", confidence: 1 } : null;
}

export function suggestFor(item: Correspondence, catalog: Catalog): CorrespondenceSuggestion | null {
  switch (item.field) {
    case "category":
      return suggestCategory(item.label, item.kindHint, catalog);
    case "subcategory":
      return suggestCategory(item.label, item.kindHint, catalog, item.parentLabel);
    case "account":
    case "card":
      return suggestDestination(item.label, item.field, catalog);
    case "person":
      return suggestMember(item.label, catalog);
    case "nature":
      return suggestNature(item.label);
  }
}

/** Sugestões determinísticas para quem ainda não tem (mantém IA e formato salvo). */
export function applySuggestions(items: Correspondence[], catalog: Catalog): Correspondence[] {
  return items.map((c) => (c.suggestion && (c.suggestion.source === "AI" || c.suggestion.source === "TEMPLATE") ? c : { ...c, suggestion: suggestFor(c, catalog) }));
}

export { NATURE_LABELS };
