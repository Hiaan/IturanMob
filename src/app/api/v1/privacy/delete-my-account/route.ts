import { NextResponse } from "next/server";
import { authed, sessionCookieOptions } from "@/server/api/handler";
import { deleteMemberAccount, deleteMyAccountSchema } from "@/server/modules/privacy/service";

/** Exclui a conta do próprio usuário (não proprietário), preservando o histórico anonimizado: { confirmation: "EXCLUIR" }. */
export const POST = authed(
  { body: deleteMyAccountSchema, rateLimit: { key: "privacy:delete-account", limit: 5, windowSeconds: 3600 } },
  async ({ ctx, body }) => {
    const result = await deleteMemberAccount(ctx, body);
    const res = NextResponse.json({ data: result }, { status: 200, headers: { "Cache-Control": "no-store" } });
    res.cookies.set({ ...sessionCookieOptions(new Date(0)), value: "" });
    return res;
  },
);
