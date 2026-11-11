import { authed } from "@/server/api/handler";
import { listSavedCharts } from "@/server/modules/reports/charts";

/** Meus gráficos: gráficos pedidos à Isa e salvos no painel, já com os números atualizados. */
export const GET = authed({}, async ({ ctx }) => listSavedCharts(ctx));
