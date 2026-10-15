import { Suspense } from "react";
import type { Metadata } from "next";
import { ImportsView } from "@/features/imports/imports-view";

export const metadata: Metadata = { title: "Importação" };

export default function ImportsPage() {
  return (
    <Suspense>
      <ImportsView />
    </Suspense>
  );
}
