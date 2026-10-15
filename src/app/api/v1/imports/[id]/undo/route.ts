import { authed } from "@/server/api/handler";
import { undoImport } from "@/server/modules/imports/service";

export const POST = authed({ permission: "data:import" }, async ({ ctx, params }) => undoImport(ctx, params.id!));
