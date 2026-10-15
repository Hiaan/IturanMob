import type { Metadata } from "next";
import Link from "next/link";
import { getInvitationByToken } from "@/server/modules/households/service";
import { AcceptInviteForm } from "./accept-form";

export const metadata: Metadata = { title: "Convite" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await getInvitationByToken(token);
  if (!inv) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Convite inválido</h1>
        <p className="mt-2 text-sm text-muted-foreground">Este convite expirou, foi revogado ou já foi utilizado. Peça um novo link ao administrador.</p>
        <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand hover:underline">
          Ir para o login
        </Link>
      </div>
    );
  }
  return <AcceptInviteForm token={token} email={inv.email} householdName={inv.household.name} />;
}
