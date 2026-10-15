import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "@/server/auth/server-session";
import { isFirstRun, registrationOpen } from "@/server/modules/households/service";
import { RegisterForm } from "./register-form";
import Link from "next/link";

export const metadata: Metadata = { title: "Criar família" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getServerSession()) redirect("/");
  if (!(await registrationOpen())) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cadastro fechado</h1>
        <p className="mt-2 text-sm text-muted-foreground">Novas contas são criadas apenas por convite. Peça o link ao administrador da sua família.</p>
        <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand hover:underline">
          Voltar para o login
        </Link>
      </div>
    );
  }
  return <RegisterForm firstRun={await isFirstRun()} />;
}
