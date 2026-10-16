/** Funções puras compartilhadas pelas telas de importação. */
import type { ImportBatchDTO, ImportFormat, ImportPreview, ImportRowDTO, StatementInfoDTO } from "./types";

/** PDF cujo tipo não bate com o destino e sem nenhuma linha selecionada: precisa de revisão antes de confirmar. */
export function needsScopeReview(preview: ImportPreview): boolean {
  return Boolean(preview.batch.scopeMismatch) && !preview.rows.some((r) => r.selected);
}

/** CSV e XLSX dependem do mapeamento de colunas; OFX e PDF não. */
export function isTabularFormat(format: ImportFormat): boolean {
  return format === "CSV" || format === "XLSX";
}

/** O mapeamento automático falhou e o arquivo precisa ser revisado antes de confirmar. */
export function needsMappingReview(preview: ImportPreview): boolean {
  if (!isTabularFormat(preview.batch.format)) return false;
  return preview.counts.ERROR === preview.counts.total || preview.batch.warnings.some((w) => /mapeamento/i.test(w));
}

/** Formato provável pelo nome do arquivo (antes do envio). */
export function formatFromFileName(name: string): ImportFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv" || ext === "txt") return "CSV";
  if (ext === "ofx" || ext === "qfx") return "OFX";
  if (ext === "xlsx") return "XLSX";
  if (ext === "pdf") return "PDF";
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

export function statementKindLabel(statement: StatementInfoDTO | null | undefined): string | null {
  if (!statement) return null;
  if (statement.kind === "CREDIT_CARD") return "Fatura de cartão";
  if (statement.kind === "BANK") return "Extrato bancário";
  return null;
}

/** Avisos que aparecem em todas as prévias (exibidos uma única vez no lote). */
export function commonWarnings(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first || !rest.length) return [];
  return first.filter((w) => rest.every((l) => l.includes(w)));
}

/** Avisos que pedem atenção (destacados em amarelo). */
export function isStrongWarning(w: string): boolean {
  return /já foi importado|Ajuste o mapeamento|Nenhuma conta|confira|automaticamente pelo banco|parece (uma|um) (fatura|extrato)|parecem aplicação/i.test(w) || /\bIA\b/.test(w);
}

/** Banco identificado no arquivo (PDF), omitido quando só repete o nome da conta ou do cartão de destino. */
export function bankLabel(batch: Pick<ImportBatchDTO, "statement" | "account" | "creditCard">): string | null {
  const bank = batch.statement?.bank?.trim();
  if (!bank) return null;
  const dest = (batch.account?.name ?? batch.creditCard?.name ?? "").trim();
  return bank.localeCompare(dest, "pt-BR", { sensitivity: "base" }) === 0 ? null : `banco ${bank}`;
}

/**
 * Aviso de "linhas que parecem aplicação/resgate sem a conta do outro lado". É gravado na criação da
 * prévia e fica desatualizado depois que a pessoa escolhe a conta: as telas mostram o aviso calculado das linhas.
 */
export function isTransferWarning(w: string): boolean {
  return /parecem aplicação\/resgate/i.test(w);
}

/** Linha que parece aplicação/resgate ou transferência entre contas próprias, mas sem a conta do outro lado. */
export function isUnresolvedTransfer(row: Pick<ImportRowDTO, "kind" | "transfer">): boolean {
  return row.kind === "TRANSFER" && !row.transfer?.accountId;
}

/** Transferência só vale em extrato de conta, para lançamentos novos ou já registrados (fora pagamento de fatura). */
export function canMarkTransfer(preview: Pick<ImportPreview, "batch">, row: ImportRowDTO): boolean {
  return (
    Boolean(preview.batch.account) &&
    preview.batch.status === "PREVIEW" &&
    (row.status === "NEW" || row.status === "MATCHED") &&
    row.kind !== "CARD_PAYMENT" &&
    Boolean(row.amountCents)
  );
}

/** Linhas de transferência com a conta definida que entram na importação (novas selecionadas). */
export function transferTotals(rows: ImportRowDTO[]) {
  let count = 0;
  let inflowCents = 0;
  let outflowCents = 0;
  for (const r of rows) {
    if (r.kind !== "TRANSFER" || !r.transfer?.accountId || !r.amountCents) continue;
    count++;
    if (r.amountCents > 0) inflowCents += r.amountCents;
    else outflowCents += -r.amountCents;
  }
  return { count, inflowCents, outflowCents };
}
