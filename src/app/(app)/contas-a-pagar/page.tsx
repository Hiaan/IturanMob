import { Suspense } from "react";
import type { Metadata } from "next";
import { PayablesView } from "@/features/bills/payables-view";

export const metadata: Metadata = { title: "Contas a pagar" };

export default function PayablesPage() {
  return (
    <Suspense>
      <PayablesView />
    </Suspense>
  );
}
