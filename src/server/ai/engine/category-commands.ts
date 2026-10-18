import type { ServiceContext } from "../../auth/context";
import { ForbiddenError } from "../../errors";
import { quickCreateCategory } from "../../modules/categories/service";
import { normalizeForNlu } from "../nlu/text";
import type { ActionOutcome } from "./actions";
import type { HouseholdContext } from "./context";

/**
 * Criar categoria pelo WhatsApp, sem IA: "cria categoria Pet", "nova categoria Escola dentro de
 * Educação", "criar subcategoria Ração em Pet", "cria categoria de receita Freelas".
 * Nome que já existe não duplica (a resposta avisa).
 */

export interface CategoryCommand {
  name: string;
  /** Categoria-mãe citada ("dentro de Educação", "em Pet"). */
  parentName: string | null;
  /** "subcategoria" dita explicitamente. */
  sub: boolean;
  kind: "EXPENSE" | "INCOME";
}

const HEAD =
  /^\s*(?:(?:por favor|pfv?)[,\s]+)?(?:(?:cria|criar|crie|adiciona|adicionar|adicione|cadastra|cadastrar|cadastre|inclui|incluir|inclua|abre|abrir|faz|fazer|faça)\s+(?:a\s+|uma\s+)?(?:nova\s+|novo\s+)?|(?:uma\s+)?(?:nova|novo)\s+)(sub)?categoria\b[\s:]*/iu;
const KIND_LEAD = /^(?:de|da|do|para|pra)\s+(receitas?|entradas?|despesas?|gastos?)\b[\s:,]*/iu;
const KIND_TAIL = /[\s,(]+(?:de|da|do|para|pra)\s+(receitas?|entradas?|despesas?|gastos?)\)?\s*$/iu;
/** "dentro de Educação" sempre separa a mãe; "em/na/no Pet" só quando Pet existe (ou é subcategoria). */
const INSIDE = /^(.+?)\s+dentro\s+(?:de|da|do|das|dos)\s+(.+)$/iu;
const IN = /^(.+?)\s+(?:em|na|no|nas|nos)\s+(.+)$/iu;
const OF = /^(.+?)\s+(?:de|da|do)\s+(.+)$/iu;

const clean = (s: string) =>
  s
    .replace(/[“”"'*_]/g, "")
    .replace(/[.!?;,]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
const singular = (s: string) => (s.length > 3 && s.endsWith("s") ? s.slice(0, -1) : s);
const same = (a: string, b: string) => {
  const x = normalizeForNlu(a);
  const y = normalizeForNlu(b);
  return x === y || singular(x) === singular(y);
};

export function findCategoryByName(hc: HouseholdContext, name: string, kind?: "EXPENSE" | "INCOME") {
  const pool = kind ? hc.categories.filter((c) => c.kind === kind) : hc.categories;
  return pool.find((c) => same(c.name, name)) ?? null;
}

export function parseCategoryCommand(text: string, hc: HouseholdContext): CategoryCommand | null {
  if (text.length > 160) return null;
  const head = HEAD.exec(text);
  if (!head) return null;
  const sub = Boolean(head[1]);
  let rest = text.slice(head[0].length);
  let kind: CategoryCommand["kind"] = "EXPENSE";
  const lead = KIND_LEAD.exec(rest);
  if (lead) {
    kind = /^(receita|entrada)/i.test(lead[1]!) ? "INCOME" : "EXPENSE";
    rest = rest.slice(lead[0].length);
  } else {
    const tail = KIND_TAIL.exec(rest);
    if (tail) {
      kind = /^(receita|entrada)/i.test(tail[1]!) ? "INCOME" : "EXPENSE";
      rest = rest.slice(0, tail.index);
    }
  }
  rest = clean(rest);
  if (!rest) return { name: "", parentName: null, sub, kind };

  let name = rest;
  let parentName: string | null = null;
  const inside = INSIDE.exec(rest);
  if (inside) {
    name = inside[1]!;
    parentName = inside[2]!;
  } else {
    for (const re of sub ? [IN, OF] : [IN]) {
      const m = re.exec(rest);
      // "Comida em casa" continua sendo o nome quando "casa" não é uma categoria.
      if (m && (sub || findCategoryByName(hc, clean(m[2]!)))) {
        name = m[1]!;
        parentName = m[2]!;
        break;
      }
    }
  }
  name = clean(name).slice(0, 50);
  parentName = parentName ? clean(parentName).slice(0, 50) : null;
  if (name.split(" ").length > 5) return null;
  return { name, parentName, sub, kind };
}

export async function handleCategoryCommand(ctx: ServiceContext, hc: HouseholdContext, cmd: CategoryCommand): Promise<ActionOutcome> {
  const reply = (text: string, status: ActionOutcome["status"] = "PROCESSED"): ActionOutcome => ({ status, intent: "CREATE_CATEGORY", replies: [text], transactionIds: [] });
  if (!cmd.name) return reply("Qual o nome da categoria? Ex.: *cria categoria Pet* ou *criar subcategoria Ração em Pet*.");
  if (cmd.sub && !cmd.parentName) return reply(`Em qual categoria fica *${cmd.name}*? Ex.: *criar subcategoria ${cmd.name} em Pet*.`);

  let parentId: string | null = null;
  let parentLabel: string | null = null;
  if (cmd.parentName) {
    const parent = findCategoryByName(hc, cmd.parentName, cmd.kind) ?? findCategoryByName(hc, cmd.parentName);
    if (!parent) {
      const names = hc.categories.filter((c) => c.kind === cmd.kind).map((c) => c.name).slice(0, 8);
      return reply(
        `Não encontrei a categoria *${cmd.parentName}*.${names.length ? ` Categorias: ${names.join(", ")}.` : ""}\nPara criá-la, mande *cria categoria ${cmd.parentName}*.`,
      );
    }
    parentId = parent.id;
    parentLabel = parent.name;
  }
  try {
    const res = await quickCreateCategory(ctx, { name: cmd.name, kind: cmd.kind, parentId });
    if (!res.created) return reply(`🏷️ *${res.label}* já existe — nada foi duplicado.`);
    const kindLabel = res.kind === "INCOME" ? "receita" : "despesa";
    return reply(
      parentLabel
        ? `🏷️ Subcategoria *${res.label}* criada. Já dá para usar nos lançamentos.`
        : `🏷️ Categoria *${res.label}* criada (${kindLabel}). Já dá para usar nos lançamentos.\nPara uma subcategoria: *criar subcategoria Nome em ${res.label}*.`,
    );
  } catch (err) {
    if (err instanceof ForbiddenError) return reply("Seu perfil não pode criar categorias. Peça a um administrador da família.");
    throw err;
  }
}
