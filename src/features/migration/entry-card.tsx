"use client";

import Link from "next/link";
import { ArrowRight, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MIGRATION_MODEL_URL } from "./use-migration";

/** Opção "Migrar de planilha" na tela de Importação (separada da importação de extratos). */
export function MigrationEntryCard({ className }: { className?: string }) {
  return (
    <Card className={cn("flex flex-col gap-4 border-brand/30 bg-accent/30 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <FileSpreadsheet className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Migrar de planilha</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Trouxe seus controles de uma planilha? Envie e o app interpreta abas, colunas e categorias.</p>
          <p className="mt-1 text-xs text-muted-foreground">XLSX, XLS, ODS ou CSV · você confere tudo antes de gravar e pode desfazer a migração inteira depois.</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={MIGRATION_MODEL_URL} download>
            <Download aria-hidden /> Baixar planilha modelo
          </a>
        </Button>
        <Button asChild variant="brand" size="sm">
          <Link href="/importacao/migrar">
            Migrar de planilha <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
