import { z } from "zod";
import { authed } from "@/server/api/handler";
import { boletoLineSchema, previewBoleto } from "@/server/modules/bills/service";

/** POST { line } → confere o código e mostra banco/valor/vencimento (sem gravar). */
export const POST = authed({ body: z.object({ line: boletoLineSchema }), permission: "bills:write" }, async ({ ctx, body }) => previewBoleto(ctx, body.line));
