import { authed } from "@/server/api/handler";
import { getReport } from "@/server/modules/reports/service";

export const GET = authed({ permission: "reports:read" }, async ({ ctx, params }) => getReport(ctx, params.id!));
