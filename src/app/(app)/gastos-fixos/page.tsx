import type { Metadata } from "next";
import { FixedExpensesView } from "@/features/fixed-expenses/fixed-expenses-view";

export const metadata: Metadata = { title: "Gastos fixos" };

export default function FixedExpensesPage() {
  return <FixedExpensesView />;
}
