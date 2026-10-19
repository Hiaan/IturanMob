import { createHash } from "node:crypto";
import { normalizeText } from "@/lib/utils";
import { emptyColumns, MIGRATION_FIELDS } from "./columns";
import type { ColumnMap, Correspondence, CorrespondenceDecision, MatrixMode, SheetConfig, SheetKind, UnsignedAs } from "./types";

/**
 * Formato lembrado: identifica a planilha pelos cabeçalhos das abas e guarda o que a pessoa
 * escolheu (abas, colunas pelo NOME do cabeçalho e correspondências). Na próxima planilha igual,
 * aplica tudo e deixa pendente só o que for novo.
 */

export interface TemplateSheet {
  signature: string;
  kind: SheetKind;
  selected: boolean;
  /** Campo → cabeçalho normalizado (colunas podem mudar de posição). */
  columnsByHeader: Partial<Record<keyof ColumnMap, string>>;
  unsignedAs: UnsignedAs | null;
  invertSigns: boolean;
  matrixMode: MatrixMode | null;
}

export interface TemplateConfig {
  version: 1;
  sheets: TemplateSheet[];
  correspondences: Array<{ field: Correspondence["field"]; key: string; decision: CorrespondenceDecision }>;
  defaultAccountId: string | null;
  defaultCardId: string | null;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** Assinatura de uma aba: tipo + cabeçalhos (listas/mensais) ou rótulo da coluna de categorias (matriz). */
export function sheetSignature(cfg: Pick<SheetConfig, "kind" | "headers" | "matrix">): string {
  if (cfg.kind === "MATRIX" && cfg.matrix) return hash(`matrix|${normalizeText(cfg.headers[cfg.matrix.labelColumn] ?? "")}`);
  if (cfg.kind !== "LIST" && cfg.kind !== "MONTH") return "";
  const headers = cfg.headers.map(normalizeText).filter((h) => h && !/^coluna \d+$/.test(h));
  if (headers.length < 2) return "";
  return hash(`${cfg.kind === "MONTH" ? "month" : "list"}|${[...new Set(headers)].sort().join("|")}`);
}

/** Assinatura do arquivo: as assinaturas das abas usadas. */
export function workbookSignature(sheets: SheetConfig[]): string {
  const sigs = [...new Set(sheets.filter((s) => s.selected && s.signature).map((s) => s.signature))].sort();
  return sigs.length ? hash(sigs.join(",")) : "";
}

export function buildTemplateConfig(sheets: SheetConfig[], correspondences: Correspondence[], defaults: { defaultAccountId: string | null; defaultCardId: string | null }): TemplateConfig {
  const bySig = new Map<string, TemplateSheet>();
  for (const s of sheets) {
    if (!s.signature || bySig.has(s.signature)) continue;
    const columnsByHeader: TemplateSheet["columnsByHeader"] = {};
    for (const f of MIGRATION_FIELDS) {
      const col = s.columns[f];
      if (col !== null && s.headers[col]) columnsByHeader[f] = normalizeText(s.headers[col]!);
    }
    bySig.set(s.signature, { signature: s.signature, kind: s.kind, selected: s.selected, columnsByHeader, unsignedAs: s.unsignedAs, invertSigns: s.invertSigns, matrixMode: s.matrixMode });
  }
  return {
    version: 1,
    sheets: [...bySig.values()],
    // Só decisões com destino real (MAP/IGNORE); "criar" já virou MAP para o que foi criado.
    correspondences: correspondences.filter((c) => c.decision && c.decision.action !== "CREATE").map((c) => ({ field: c.field, key: c.key, decision: c.decision! })),
    defaultAccountId: defaults.defaultAccountId,
    defaultCardId: defaults.defaultCardId,
  };
}

/** Quantas abas da planilha batem com o formato salvo. */
export function templateMatchScore(config: TemplateConfig, sheets: SheetConfig[]): number {
  const sigs = new Set(config.sheets.map((s) => s.signature));
  return sheets.filter((s) => s.signature && sigs.has(s.signature)).length;
}

export function applyTemplateToSheets(config: TemplateConfig, sheets: SheetConfig[]): SheetConfig[] {
  const bySig = new Map(config.sheets.map((s) => [s.signature, s]));
  return sheets.map((s) => {
    const t = s.signature ? bySig.get(s.signature) : undefined;
    if (!t) return s;
    const columns = emptyColumns() as ColumnMap;
    let mapped = 0;
    for (const f of MIGRATION_FIELDS) {
      const header = t.columnsByHeader[f];
      if (!header) continue;
      const idx = s.headers.findIndex((h) => normalizeText(h) === header);
      if (idx >= 0) {
        columns[f] = idx;
        mapped++;
      }
    }
    return {
      ...s,
      kind: t.kind,
      selected: t.selected,
      columns: mapped ? columns : s.columns,
      unsignedAs: s.unsigned ? t.unsignedAs ?? s.unsignedAs : s.unsignedAs,
      invertSigns: t.invertSigns,
      matrixMode: s.kind === "MATRIX" ? t.matrixMode : s.matrixMode,
      fromTemplate: true,
    };
  });
}

export function applyTemplateToCorrespondences(config: TemplateConfig, items: Correspondence[], exists: (d: CorrespondenceDecision) => boolean): Correspondence[] {
  const saved = new Map(config.correspondences.map((c) => [`${c.field}|${c.key}`, c.decision]));
  return items.map((c) => {
    if (c.decision) return c;
    const d = saved.get(`${c.field}|${c.key}`);
    if (!d || !exists(d)) return c;
    return {
      ...c,
      decision: d,
      fromTemplate: true,
      suggestion: d.action === "MAP" ? { targetType: d.targetType, targetId: d.targetId, label: d.label, source: "TEMPLATE", confidence: 1 } : c.suggestion,
    };
  });
}
