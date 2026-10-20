import { authed } from "@/server/api/handler";
import { disconnectGoogle, getGoogleStatus } from "@/server/modules/agenda/google";

/** GET → situação do Google Agenda (a sua conexão e quem da família conectou). DELETE → desconecta a sua. */
export const GET = authed({}, async ({ ctx }) => getGoogleStatus(ctx));
export const DELETE = authed({}, async ({ ctx }) => disconnectGoogle(ctx));
