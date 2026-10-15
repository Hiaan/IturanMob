import type { Metadata } from "next";
import { AiSettingsView } from "@/features/ai-settings/ai-settings-view";

export const metadata: Metadata = { title: "Inteligência artificial" };

export default function AiSettingsPage() {
  return <AiSettingsView />;
}
