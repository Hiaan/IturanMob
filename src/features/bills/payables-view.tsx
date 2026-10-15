"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, Repeat } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { RecurringTab } from "@/features/recurring/recurring-tab";
import { BillsTab } from "./bills-tab";

type Tab = "contas" | "recorrencias";

/** Contas a pagar: ocorrências previstas/pagas do mês e cadastro de recorrências. */
export function PayablesView() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const initial: Tab = search.get("aba") === "recorrencias" ? "recorrencias" : "contas";
  const [tab, setTab] = useState<Tab>(initial);

  useEffect(() => {
    setTab(search.get("aba") === "recorrencias" ? "recorrencias" : "contas");
  }, [search]);

  const change = (value: string) => {
    const next: Tab = value === "recorrencias" ? "recorrencias" : "contas";
    setTab(next);
    router.replace(next === "contas" ? pathname : `${pathname}?aba=recorrencias`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Contas a pagar" description="Vencimentos do mês, pagamentos e contas que se repetem" />
      <Tabs value={tab} onValueChange={change}>
        <TabsList>
          <TabsTrigger value="contas">
            <CalendarClock aria-hidden /> Contas
          </TabsTrigger>
          <TabsTrigger value="recorrencias">
            <Repeat aria-hidden /> Recorrências
          </TabsTrigger>
        </TabsList>
        <TabsContent value="contas" className="mt-5">
          <BillsTab onGoToRecurring={() => change("recorrencias")} />
        </TabsContent>
        <TabsContent value="recorrencias" className="mt-5">
          <RecurringTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
