import { authed } from "@/server/api/handler";
import { deleteContribution } from "@/server/modules/goals/service";

/** Exclui a contribuição (e a transferência vinculada, quando houver). */
export const DELETE = authed({ permission: "goals:write" }, async ({ ctx, params }) => deleteContribution(ctx, params.id!));
