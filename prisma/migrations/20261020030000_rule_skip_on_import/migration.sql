-- Confirmar fatura: regra "não importar" (a linha vem desmarcada na prévia da importação).
ALTER TABLE "FinancialRule" ADD COLUMN IF NOT EXISTS "skipOnImport" BOOLEAN NOT NULL DEFAULT false;
