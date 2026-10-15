import { Suspense } from "react";
import type { Metadata } from "next";
import { CardsView } from "@/features/cards/cards-view";

export const metadata: Metadata = { title: "Cartões" };

export default function CardsPage() {
  return (
    <Suspense>
      <CardsView />
    </Suspense>
  );
}
