import { authed } from "@/server/api/handler";
import { deleteMigrationTemplate } from "@/server/modules/migration/service";

export const DELETE = authed({ permission: "data:import" }, async ({ ctx, params }) => {
  await deleteMigrationTemplate(ctx, params.id!);
  return new Response(null, { status: 204 });
});
