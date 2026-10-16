import { authed } from "@/server/api/handler";
import { listExclusionParties } from "@/server/modules/transactions/report-exclusion";

/** Clientes já usados em repasses/reembolsos (sugestões do formulário). */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx }) => ({ parties: await listExclusionParties(ctx) }));
