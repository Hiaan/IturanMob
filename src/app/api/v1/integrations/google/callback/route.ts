import { NextResponse } from "next/server";
import { z } from "zod";
import { authed } from "@/server/api/handler";
import { env } from "@/server/env";
import { finishGoogleConnect } from "@/server/modules/agenda/google";

const query = z.object({ code: z.string().max(2000).optional(), state: z.string().max(4000).optional(), error: z.string().max(200).optional() });

/** Volta do consentimento do Google → troca o código e leva para a Agenda com o resultado. */
export const GET = authed({ query }, async ({ ctx, query }) => {
  const res = await finishGoogleConnect(ctx, query);
  const url = new URL("/agenda", env().APP_URL);
  url.searchParams.set("google", res.ok ? "ok" : "erro");
  if (!res.ok) url.searchParams.set("motivo", res.message);
  return NextResponse.redirect(url, 303);
});
