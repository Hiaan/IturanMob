import { Suspense } from "react";
import type { Metadata } from "next";
import { TransactionsView } from "@/features/transactions/transactions-view";

export const metadata: Metadata = { title: "Transações" };

export default function TransactionsPage() {
  return (
    <Suspense>
      <TransactionsView />
    </Suspense>
  );
}
