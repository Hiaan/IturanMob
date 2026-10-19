import { authed } from "@/server/api/handler";
import { buildMigrationModel } from "@/server/modules/migration/model";

/** Planilha modelo (.xlsx) com as colunas recomendadas e uma linha de exemplo de cada tipo. */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx }) => {
  const content = await buildMigrationModel(ctx.timezone);
  return new Response(new Uint8Array(content), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(content.length),
      "Content-Disposition": 'attachment; filename="planilha-modelo-finance-ai.xlsx"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
