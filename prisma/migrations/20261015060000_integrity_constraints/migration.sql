-- Restrições de integridade financeira (não expressáveis no schema Prisma)

-- Valores de transações sempre positivos (o sentido vem do tipo) e com limite.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_amount_positive" CHECK ("amountCents" > 0 AND "amountCents" <= 1000000000);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_installments_range" CHECK ("installmentCount" BETWEEN 1 AND 72);
-- Transferência exige origem e destino distintos.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_transfer_accounts" CHECK (
  "type" <> 'TRANSFER' OR ("accountId" IS NOT NULL AND "destinationAccountId" IS NOT NULL AND "accountId" <> "destinationAccountId")
);
-- Pagamento de fatura exige conta pagadora e cartão.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_card_payment_refs" CHECK (
  "type" <> 'CARD_PAYMENT' OR ("accountId" IS NOT NULL AND "creditCardId" IS NOT NULL)
);
-- Responsável individual obrigatório quando a titularidade é individual.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_individual_responsible" CHECK (
  "ownership" <> 'INDIVIDUAL' OR "responsibleMemberId" IS NOT NULL
);

ALTER TABLE "TransactionAllocation" ADD CONSTRAINT "Allocation_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_nonzero" CHECK ("amountCents" <> 0);
ALTER TABLE "Installment" ADD CONSTRAINT "Installment_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "Installment" ADD CONSTRAINT "Installment_number_range" CHECK ("number" >= 1 AND "number" <= "totalInstallments");

ALTER TABLE "CreditCard" ADD CONSTRAINT "CreditCard_days_range" CHECK ("closingDay" BETWEEN 1 AND 31 AND "dueDay" BETWEEN 1 AND 31);
ALTER TABLE "CreditCard" ADD CONSTRAINT "CreditCard_limit_nonnegative" CHECK ("limitCents" >= 0);
ALTER TABLE "CreditCardStatement" ADD CONSTRAINT "Statement_reference_format" CHECK ("referenceMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "Budget" ADD CONSTRAINT "Budget_limit_positive" CHECK ("limitCents" > 0);
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "FinancialGoal" ADD CONSTRAINT "Goal_target_positive" CHECK ("targetCents" > 0);
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_nonzero" CHECK ("amountCents" <> 0);
ALTER TABLE "RecurringTransaction" ADD CONSTRAINT "Recurring_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "RecurringTransaction" ADD CONSTRAINT "Recurring_interval_positive" CHECK ("interval" >= 1);
ALTER TABLE "ScheduledPayment" ADD CONSTRAINT "Scheduled_amount_positive" CHECK ("amountCents" > 0);

ALTER TABLE "HouseholdSettings" ADD CONSTRAINT "Settings_confidence_range" CHECK (
  "confidenceHigh" BETWEEN 0 AND 1 AND "confidenceMedium" BETWEEN 0 AND 1 AND "confidenceMedium" <= "confidenceHigh"
);
