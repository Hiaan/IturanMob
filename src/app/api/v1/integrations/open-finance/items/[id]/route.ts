import { authed } from "@/server/api/handler";
import { removeBankItem } from "@/server/modules/open-finance/service";

/** DELETE → desconecta o banco (os lançamentos já importados continuam). */
export const DELETE = authed({ permission: "integrations:manage" }, async ({ ctx, params }) => removeBankItem(ctx, params.id!));
