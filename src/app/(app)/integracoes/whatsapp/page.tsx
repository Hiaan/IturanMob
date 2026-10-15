import type { Metadata } from "next";
import { Suspense } from "react";
import { WhatsAppView } from "@/features/whatsapp/whatsapp-view";

export const metadata: Metadata = { title: "WhatsApp" };

export default function WhatsAppPage() {
  return (
    <Suspense>
      <WhatsAppView />
    </Suspense>
  );
}
