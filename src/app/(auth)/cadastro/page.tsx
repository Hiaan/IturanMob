import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "@/server/auth/server-session";
import { isFirstRun, registrationOpen } from "@/server/modules/households/service";
import { householdInviteStatus } from "@/server/modules/instance/invites";
import { RegisterForm } from "./register-form";
import Link from "next/link";

export const metadata: Metadata = { title: "Criar família" };
export const dynamic = "force-dynamic";

const INVITE_PROBLEM: Record<"INVALID" | "USED" | "EXPIRED" | "REVOKED", string> = {
  INVALID: "Este link de convite não é válido.",
  USED: "Este convite já foi usado para criar uma família.",
  EXPIRED: "Este convite expirou (os links valem 7 dias).",
  REVOKED: "Este convite foi cancelado por quem o gerou.",
};

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ convite?: string }> }) {
  if (await getServerSession()) redirect("/");
  const { convite } = await searchParams;
  if (!(await registrationOpen())) {
    // Convite de uso único para criar uma nova família (o cadastro público continua fechado).
    if (convite) {
      const invite = await householdInviteStatus(convite);
      if (invite.valid) return <RegisterForm firstRun={false} invite={{ token: convite, expiresAt: invite.expiresAt!.toISOString() }} />;
      return (
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Convite indisponível</h1>
          <p className="mt-2 text-sm text-muted-foreground">{INVITE_PROBLEM[invite.reason ?? "INVALID"]} Peça um novo link a quem enviou o convite.</p>
          <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand hover:underline">
            Voltar para o login
          </Link>
        </div>
      );
    }
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
