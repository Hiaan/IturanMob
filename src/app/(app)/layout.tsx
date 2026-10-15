import { redirect } from "next/navigation";
import { getServerSession } from "@/server/auth/server-session";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  return (
    <AppShell
      user={{
        name: session.member.displayName,
        email: session.user.email,
        color: session.member.color,
        role: session.member.role,
        householdName: session.household.name,
      }}
    >
      {children}
    </AppShell>
  );
}
