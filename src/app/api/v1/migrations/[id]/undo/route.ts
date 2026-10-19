import { authed } from "@/server/api/handler";
import { undoMigration } from "@/server/modules/migration/service";

/** Desfaz a migração inteira (lançamentos, contas a pagar, orçamentos, saldos iniciais e o que ela criou sem uso). */
export const POST = authed({ permission: "data:import" }, async ({ ctx, params }) => undoMigration(ctx, params.id!));
