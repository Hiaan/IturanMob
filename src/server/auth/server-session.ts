import { cookies } from "next/headers";
import { resolveSession, SESSION_COOKIE, type SessionInfo } from "./session";

/** Sessão atual em Server Components / layouts. */
export async function getServerSession(): Promise<SessionInfo | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}
