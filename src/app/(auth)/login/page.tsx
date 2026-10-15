import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "@/server/auth/server-session";
import { isFirstRun } from "@/server/modules/households/service";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getServerSession()) redirect("/");
  if (await isFirstRun()) redirect("/cadastro");
  return <LoginForm />;
}
