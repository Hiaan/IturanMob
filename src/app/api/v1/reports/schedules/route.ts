import { authed } from "@/server/api/handler";
import { listReportSchedules } from "@/server/modules/reports/service";

export const GET = authed({ permission: "reports:read" }, async ({ ctx }) => listReportSchedules(ctx));
