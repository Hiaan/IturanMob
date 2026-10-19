import { authed } from "@/server/api/handler";
import { createMigrationDestination, destinationCreateSchema } from "@/server/modules/migration/service";

/** Cria a conta/cartão da planilha "na hora": { field, key, kind, name, accountType?, institution?, closingDay?, dueDay? } */
export const POST = authed({ body: destinationCreateSchema, permission: "data:import" }, async ({ ctx, params, body }) => createMigrationDestination(ctx, params.id!, body));
