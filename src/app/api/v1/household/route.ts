import { authed } from "@/server/api/handler";
import { getHousehold, householdUpdateSchema, updateHousehold } from "@/server/modules/households/service";

export const GET = authed({}, async ({ ctx }) => getHousehold(ctx));
export const PATCH = authed({ body: householdUpdateSchema }, async ({ ctx, body }) => updateHousehold(ctx, body));
