import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ValidationError } from "../../errors";
import { isBoleto, parseBoleto } from "@/lib/boleto";
import { isISODate, todayISO } from "@/lib/dates";
import { extractReceipt } from "../../ai/vision/receipt";
import { readBoletoFromPdf, type BoletoHints } from "./boleto-reader";
import { previewBoleto, type BoletoPreview } from "./service";

export const BOLETO_FILE_MAX_MB = 10;

/**
 * Arquivo de boleto enviado no app (PDF ou foto) → código conferido + dados impressos (sugestões).
 * Nada é gravado: a pessoa confere e confirma no formulário.
 */
export async function readBoletoFile(
  ctx: ServiceContext,
  file: { fileName: string; mimeType: string; content: Buffer },
): Promise<BoletoPreview & { hints: BoletoHints }> {
  assertCan(ctx, "bills:write");
  const today = todayISO(ctx.timezone);
  const isPdf = file.mimeType === "application/pdf" || /\.pdf$/i.test(file.fileName);
  if (isPdf) {
    const res = await readBoletoFromPdf(file.content, today);
    if (res.status === "PAID_RECEIPT") throw new ValidationError("Este PDF é o comprovante de um boleto já pago, não um boleto a pagar.");
    if (res.status !== "BOLETO") throw new ValidationError("Não encontrei um código de boleto válido neste PDF. Copie a linha digitável e cole no campo de código.");
    return { ...(await previewBoleto(ctx, res.boleto.digitableLine)), hints: res.hints };
  }
  if (!file.mimeType.startsWith("image/")) throw new ValidationError("Envie o boleto em PDF ou foto (JPG/PNG).");
  const extraction = await extractReceipt(ctx.householdId, file.content, file.mimeType);
  if (!extraction.ok) throw new ValidationError(`Não consegui ler a foto: ${extraction.reason}`);
  const line = extraction.boleto?.digitable_line;
  const parsed = line ? parseBoleto(line, today) : null;
  if (!parsed || !isBoleto(parsed)) {
    throw new ValidationError("Não consegui ler o código do boleto com segurança na foto. Copie a linha digitável e cole no campo de código.");
  }
  const b = extraction.boleto!;
  return {
    ...(await previewBoleto(ctx, parsed.digitableLine)),
    hints: {
      beneficiary: b.beneficiary,
      dueDate: b.due_date && isISODate(b.due_date) ? b.due_date : null,
      amountCents: b.amount && b.amount > 0 ? Math.round(b.amount * 100) : null,
    },
  };
}
