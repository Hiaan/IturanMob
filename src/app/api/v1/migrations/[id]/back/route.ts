import { authed } from "@/server/api/handler";
import { backToReady } from "@/server/modules/migration/service";

/** Volta da prévia para ajustar abas e correspondências. */
export const POST = authed({ permission: "data:import" }, async ({ ctx, params }) => backToReady(ctx, params.id!));
