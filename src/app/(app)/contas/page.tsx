import { Suspense } from "react";
import type { Metadata } from "next";
import { AccountsView } from "@/features/accounts/accounts-view";

export const metadata: Metadata = { title: "Contas" };

export default function AccountsPage() {
  return (
    <Suspense>
      <AccountsView />
    </Suspense>
  );
}
