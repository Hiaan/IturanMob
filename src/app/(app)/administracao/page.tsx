import type { Metadata } from "next";
import { AdminView } from "@/features/instance/admin-view";

export const metadata: Metadata = { title: "Administração" };

export default function AdminPage() {
  return <AdminView />;
}
