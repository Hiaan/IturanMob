import { authed } from "@/server/api/handler";
import { deleteSavedChart } from "@/server/modules/reports/charts";

export const DELETE = authed({}, async ({ ctx, params }) => {
  await deleteSavedChart(ctx, params.id!);
  return { deleted: true };
});
