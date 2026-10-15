import { NextResponse } from "next/server";
import { authed, sessionCookieOptions } from "@/server/api/handler";
import { deleteHousehold, deleteHouseholdSchema } from "@/server/modules/privacy/service";

/** Exclui a família e todos os dados (somente o proprietário): { confirmation: "<nome exato da família>" }. */
export const POST = authed(
  { body: deleteHouseholdSchema, permission: "household:delete", rateLimit: { key: "privacy:delete-household", limit: 5, windowSeconds: 3600 } },
  async ({ ctx, body }) => {
    const result = await deleteHousehold(ctx, body);
    const res = NextResponse.json({ data: result }, { status: 200, headers: { "Cache-Control": "no-store" } });
    res.cookies.set({ ...sessionCookieOptions(new Date(0)), value: "" });
    return res;
  },
);
