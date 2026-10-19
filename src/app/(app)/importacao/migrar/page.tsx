import { Suspense } from "react";
import type { Metadata } from "next";
import { MigrationWizard } from "@/features/migration/migration-wizard";

export const metadata: Metadata = { title: "Migrar de planilha" };

export default function MigrationPage() {
  return (
    <Suspense>
      <MigrationWizard />
    </Suspense>
  );
}
