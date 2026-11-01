-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "installmentOffset" INTEGER NOT NULL DEFAULT 0;

-- Compras parceladas trazidas da planilha a partir de uma parcela do meio ("parcelas 3 a 10"):
-- guarda as parcelas já pagas antes do registro e renumera as parcelas guardadas com a numeração
-- original (3/10 … 10/10). Só quando a descrição bate com a quantidade de parcelas registrada.
WITH m AS (
  SELECT t.id, t."installmentCount" AS cnt, regexp_match(t.description, 'parcelas (\d+) a (\d+)') AS r
  FROM "Transaction" t
  WHERE t."creditCardId" IS NOT NULL AND t."installmentCount" > 1 AND t.description ~ 'parcelas \d+ a \d+'
)
UPDATE "Transaction" t
SET "installmentOffset" = m.r[1]::int - 1
FROM m
WHERE t.id = m.id AND m.r[1]::int > 1 AND m.r[2]::int - m.r[1]::int + 1 = m.cnt;

-- Renumera por uma cópia (apaga e insere de novo) para não esbarrar na unicidade (transação, número)
-- nem na faixa válida do número durante a troca.
CREATE TEMP TABLE "_InstallmentRenumber" AS
SELECT i.id, i."householdId", i."transactionId", i."statementId", i.number + t."installmentOffset" AS number,
       i."totalInstallments" + t."installmentOffset" AS "totalInstallments", i."amountCents", i."dueDate", i."createdAt"
FROM "Installment" i JOIN "Transaction" t ON t.id = i."transactionId"
WHERE t."installmentOffset" > 0;

DELETE FROM "Installment" WHERE id IN (SELECT id FROM "_InstallmentRenumber");

INSERT INTO "Installment" (id, "householdId", "transactionId", "statementId", number, "totalInstallments", "amountCents", "dueDate", "createdAt")
SELECT id, "householdId", "transactionId", "statementId", number, "totalInstallments", "amountCents", "dueDate", "createdAt" FROM "_InstallmentRenumber";

DROP TABLE "_InstallmentRenumber";
