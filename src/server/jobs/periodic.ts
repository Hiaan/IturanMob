/**
 * CONTRATO — tarefas periódicas executadas pelo worker (BullMQ repeatable jobs).
 * Cada módulo expõe sua função; o worker apenas agenda e executa.
 * Todas as funções devem ser idempotentes (podem rodar mais de uma vez sem efeitos duplicados).
 */
export interface PeriodicTask {
  name: string;
  /** Intervalo entre execuções, em segundos. */
  everySeconds: number;
  run: () => Promise<unknown>;
}

export async function loadPeriodicTasks(): Promise<PeriodicTask[]> {
  const [recurring, budgets, bills, notifications, reports, retention, backups, sessions, jobs, investments, fx, goals, cash, subscriptions] = await Promise.all([
    import("../modules/recurring/jobs"),
    import("../modules/budgets/jobs"),
    import("../modules/bills/jobs"),
    import("../modules/notifications/jobs"),
    import("../modules/reports/jobs"),
    import("../modules/retention/jobs"),
    import("../modules/backups/jobs"),
    import("../auth/session"),
    import("./maintenance"),
    import("../modules/investments/service"),
    import("../modules/fx/service"),
    import("../modules/goals/alerts"),
    import("../modules/alerts/cash"),
    import("../modules/subscriptions/service"),
  ]);
  return [
    { name: "recurring:generate", everySeconds: 15 * 60, run: () => recurring.runRecurringJobs() },
    { name: "budgets:alerts", everySeconds: 5 * 60, run: () => budgets.runBudgetAlertJobs() },
    { name: "bills:reminders", everySeconds: 60 * 60, run: () => bills.runBillReminderJobs() },
    // Meta de ganho (faixas, meta batida, ritmo no fim do mês) e metas de economia (faixas, prazo).
    { name: "goals:alerts", everySeconds: 10 * 60, run: () => goals.runGoalAlertJobs() },
    // "Vai faltar dinheiro" (projeção de 30 dias) e assinaturas esquecidas / mais caras.
    { name: "alerts:cash", everySeconds: 3 * 60 * 60, run: () => cash.runCashShortfallAlerts() },
    { name: "alerts:subscriptions", everySeconds: 6 * 60 * 60, run: () => subscriptions.runSubscriptionJobs() },
    { name: "notifications:dispatch", everySeconds: 60, run: () => notifications.runNotificationDispatch() },
    { name: "reports:scheduled", everySeconds: 15 * 60, run: () => reports.runScheduledReports() },
    { name: "retention:purge", everySeconds: 6 * 60 * 60, run: () => retention.runRetentionJobs() },
    { name: "backups:run", everySeconds: 60 * 60, run: () => backups.runBackupJob() },
    { name: "sessions:purge", everySeconds: 12 * 60 * 60, run: () => sessions.purgeExpiredSessions() },
    { name: "jobs:recover", everySeconds: 2 * 60, run: () => jobs.recoverStuckJobs() },
    { name: "clarifications:expire", everySeconds: 10 * 60, run: () => jobs.expireClarifications() },
    // Taxas do Banco Central + rendimento das contas de investimento (BCB fora → tenta na próxima).
    { name: "investments:yield", everySeconds: 3 * 60 * 60, run: () => investments.runInvestmentYieldJobs() },
    // Cotação PTAX das moedas das contas estrangeiras (BCB fora → tenta na próxima).
    { name: "fx:rates", everySeconds: 3 * 60 * 60, run: () => fx.runFxJobs() },
  ];
}
