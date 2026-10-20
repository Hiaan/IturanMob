import { notificationPriority } from "@/lib/notification-meta";

/** Até quantos pop-ups aparecem de uma vez (ao abrir o app, ao voltar e a cada aviso novo). */
export const MAX_POPUPS = 3;

interface PopupCandidate {
  id: string;
  type: string;
  data: unknown;
  createdAt: string;
  readAt: string | null;
}

/** Mais importantes primeiro (vencidas → vence hoje → metas → o resto); empate: mais recentes. */
export function sortForPopups<T extends PopupCandidate>(items: T[]): T[] {
  return [...items].sort((a, b) => notificationPriority(a.type, a.data) - notificationPriority(b.type, b.data) || b.createdAt.localeCompare(a.createdAt));
}

/**
 * Escolhe os pop-ups: só não lidos ainda não mostrados neste navegador, os mais importantes primeiro,
 * no máximo `max`. `more` indica que sobraram outros (ou que há mais páginas não lidas no servidor).
 */
export function pickPopups<T extends PopupCandidate>(items: T[], shown: ReadonlySet<string>, opts: { max?: number; hasMorePages?: boolean } = {}): { batch: T[]; more: boolean } {
  const max = opts.max ?? MAX_POPUPS;
  const fresh = sortForPopups(items.filter((n) => !n.readAt && !shown.has(n.id)));
  const batch = fresh.slice(0, max);
  return { batch, more: batch.length > 0 && (fresh.length > batch.length || Boolean(opts.hasMorePages)) };
}
