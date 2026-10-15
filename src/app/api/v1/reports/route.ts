import { authed } from "@/server/api/handler";
import { generateReport, generateReportSchema, listReports, listReportsSchema } from "@/server/modules/reports/service";

/** Lista os relatórios visíveis (da família e os pessoais do próprio usuário). */
export const GET = authed({ query: listReportsSchema, permission: "reports:read" }, async ({ ctx, query }) => listReports(ctx, query));

/** Gera um relatório semanal ou mensal: { type, periodStart?, month?, scope?, regime? }. */
export const POST = authed(
  { body: generateReportSchema, permission: "reports:read", rateLimit: { key: "reports:generate", limit: 20, windowSeconds: 60 } },
  async ({ ctx, body }) => generateReport(ctx, body),
);
