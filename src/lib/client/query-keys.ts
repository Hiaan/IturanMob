/** Chaves do TanStack Query por domínio — usadas para invalidação seletiva em tempo real. */
export const qk = {
  me: ["me"] as const,
  household: ["household"] as const,
  settings: ["settings"] as const,
  members: ["members"] as const,
  invitations: ["invitations"] as const,
  /** Convites de nova família (administrador da instalação). */
  householdInvites: ["instance", "invites"] as const,
  accounts: (p?: unknown) => ["accounts", p ?? {}] as const,
  cards: (p?: unknown) => ["cards", p ?? {}] as const,
  statements: (cardId: string) => ["cards", "statements", cardId] as const,
  statement: (id: string) => ["cards", "statement", id] as const,
  categories: (p?: unknown) => ["categories", p ?? {}] as const,
  rules: ["rules"] as const,
  transactions: (p?: unknown) => ["transactions", p ?? {}] as const,
  transaction: (id: string) => ["transactions", "detail", id] as const,
  /** Sob o prefixo "transactions": invalidados junto com qualquer mudança de lançamento. */
  passthrough: (p?: unknown) => ["transactions", "passthrough", p ?? {}] as const,
  exclusionParties: ["transactions", "exclusion-parties"] as const,
  analytics: (name: string, p?: unknown) => ["analytics", name, p ?? {}] as const,
  pending: (p?: unknown) => ["pending", p ?? {}] as const,
  pendingCounts: ["pending", "counts"] as const,
  notifications: (p?: unknown) => ["notifications", p ?? {}] as const,
  /** "Mostrar pop-ups no app" do membro logado (fora de "notifications": não recarrega a cada aviso lido). */
  notificationPopups: ["notification-popups"] as const,
  budgets: (p?: unknown) => ["budgets", p ?? {}] as const,
  goals: (p?: unknown) => ["goals", p ?? {}] as const,
  /** Metas de ganho com o progresso do mês (a receita muda com qualquer lançamento). */
  incomeGoals: (p?: unknown) => ["income-goals", p ?? {}] as const,
  recurring: (p?: unknown) => ["recurring", p ?? {}] as const,
  bills: (p?: unknown) => ["bills", p ?? {}] as const,
  reports: (p?: unknown) => ["reports", p ?? {}] as const,
  imports: (p?: unknown) => ["imports", p ?? {}] as const,
  whatsapp: (p?: unknown) => ["whatsapp", p ?? {}] as const,
  /** Integração com os bancos (Open Finance via Meu Pluggy). */
  openFinance: ["integrations", "open-finance"] as const,
  /** Agenda da família (compromissos num intervalo de datas). */
  agenda: (p?: unknown) => ["agenda", p ?? {}] as const,
  /** Conexão com o Google Agenda (a da pessoa logada e quem da família conectou). */
  google: ["integrations", "google"] as const,
  ai: (p?: unknown) => ["ai", p ?? {}] as const,
  assistant: (p?: unknown) => ["assistant", p ?? {}] as const,
  audit: (p?: unknown) => ["audit", p ?? {}] as const,
};

/** Para cada tipo de evento em tempo real, quais prefixos de consulta invalidar. */
export const EVENT_INVALIDATIONS: Record<string, string[][]> = {
  "transaction.changed": [["transactions"], ["accounts"], ["cards"], ["analytics"], ["budgets"], ["bills"], ["goals"], ["income-goals"], ["pending"], ["me"]],
  "account.changed": [["accounts"], ["analytics"]],
  "card.changed": [["cards"], ["analytics"], ["bills"]],
  "budget.changed": [["budgets"], ["analytics"]],
  "goal.changed": [["goals"], ["income-goals"], ["accounts"]],
  "bill.changed": [["bills"], ["analytics"]],
  "appointment.changed": [["agenda"], ["integrations", "google"]],
  "pending.changed": [["pending"], ["me"]],
  "notification.created": [["notifications"]],
  "whatsapp.status": [["whatsapp"]],
  "whatsapp.message": [["whatsapp"], ["pending"]],
  "import.changed": [["imports"], ["transactions"], ["accounts"], ["analytics"], ["income-goals"]],
  "category.changed": [["categories"], ["analytics"], ["budgets"], ["income-goals"]],
};
