import { authed } from "@/server/api/handler";
import { connectSimulatedGoogle } from "@/server/modules/agenda/google";

/** POST → conecta o simulador (só com GOOGLE_CALENDAR_SIMULATOR=true; eventos de exemplo). */
export const POST = authed({}, async ({ ctx }) => connectSimulatedGoogle(ctx));
