import { authed } from "@/server/api/handler";
import { deleteTranscriptFix } from "@/server/ai/transcription/fixes";

export const DELETE = authed({ permission: "transactions:write" }, async ({ ctx, params }) => deleteTranscriptFix(ctx, params.id!));
