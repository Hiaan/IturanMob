import { authed } from "@/server/api/handler";
import { listTranscriptFixes } from "@/server/ai/transcription/fixes";

/** Correções aprendidas da transcrição de áudio ("revirante" → "refrigerante"). */
export const GET = authed({}, async ({ ctx }) => listTranscriptFixes(ctx));
