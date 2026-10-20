import { Suspense } from "react";
import type { Metadata } from "next";
import { AgendaView } from "@/features/agenda/agenda-view";

export const metadata: Metadata = { title: "Agenda" };

export default function AgendaPage() {
  return (
    <Suspense>
      <AgendaView />
    </Suspense>
  );
}
