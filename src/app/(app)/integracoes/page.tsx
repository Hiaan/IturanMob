import type { Metadata } from "next";
import { IntegrationsHub } from "@/features/integrations/integrations-hub";

export const metadata: Metadata = { title: "Integrações" };

export default function IntegrationsPage() {
  return <IntegrationsHub />;
}
