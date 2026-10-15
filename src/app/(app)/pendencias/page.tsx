import type { Metadata } from "next";
import { PendingView } from "@/features/pending/pending-view";

export const metadata: Metadata = { title: "Pendências" };

export default function PendingPage() {
  return <PendingView />;
}
