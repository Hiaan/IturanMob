-- Importação de extratos e faturas em PDF (site e WhatsApp).
ALTER TYPE "ImportFormat" ADD VALUE IF NOT EXISTS 'PDF';
ALTER TYPE "ClarificationKind" ADD VALUE IF NOT EXISTS 'CONFIRM_IMPORT';
