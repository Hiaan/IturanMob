import type { Metadata } from "next";
import { GoalsView } from "@/features/goals/goals-view";

export const metadata: Metadata = { title: "Metas" };

export default function GoalsPage() {
  return <GoalsView />;
}
