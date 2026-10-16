-- Perguntas de complemento depois do registro (categoria ou conta que faltaram).
ALTER TYPE "ClarificationKind" ADD VALUE IF NOT EXISTS 'COMPLETE_TRANSACTION';
