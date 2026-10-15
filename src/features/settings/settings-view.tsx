"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Bell, History, House, Lock, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan, useMe } from "@/features/me/use-me";
import { NotificationPreferencesForm } from "@/features/notifications/preferences-form";
import { HouseholdSection } from "./household-section";
import { MembersSection } from "./members-section";
import { PreferencesSection } from "./preferences-section";
import { PrivacyAiSection } from "./privacy-ai-section";
import { SecuritySection } from "./security-section";
import { AuditSection } from "./audit-section";
import { SETTINGS_EXTRA_TABS } from "./extra-tabs";

const TABS = [
  { value: "familia", label: "Família", icon: House },
  { value: "membros", label: "Membros", icon: Users },
  { value: "preferencias", label: "Preferências", icon: SlidersHorizontal },
  { value: "privacidade", label: "Privacidade e IA", icon: ShieldCheck },
  { value: "notificacoes", label: "Notificações", icon: Bell },
  { value: "seguranca", label: "Segurança", icon: Lock },
] as const;

export function SettingsView() {
  const params = useSearchParams();
  const router = useRouter();
  const canAudit = useCan("audit:read");
  const tab = params.get("tab") ?? "familia";
  const { data: me } = useMe();
  const extra = SETTINGS_EXTRA_TABS.filter((t) => !t.permission || Boolean(me?.permissions.includes(t.permission)));
  return (
    <div className="space-y-6">
      <PageHeader title="Configurações" description="Família, pessoas, permissões, privacidade, notificações e segurança." />
      <Tabs value={tab} onValueChange={(v) => router.replace(`/configuracoes?tab=${v}`, { scroll: false })}>
        <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                <t.icon /> {t.label}
              </TabsTrigger>
            ))}
            {extra.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                <t.icon /> {t.label}
              </TabsTrigger>
            ))}
            {canAudit && (
              <TabsTrigger value="auditoria">
                <History /> Auditoria
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        <TabsContent value="familia">
          <HouseholdSection />
        </TabsContent>
        <TabsContent value="membros">
          <MembersSection />
        </TabsContent>
        <TabsContent value="preferencias">
          <PreferencesSection />
        </TabsContent>
        <TabsContent value="privacidade">
          <PrivacyAiSection />
        </TabsContent>
        <TabsContent value="notificacoes">
          <NotificationPreferencesForm />
        </TabsContent>
        <TabsContent value="seguranca">
          <SecuritySection />
        </TabsContent>
        {extra.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            <t.Component />
          </TabsContent>
        ))}
        {canAudit && (
          <TabsContent value="auditoria">
            <AuditSection />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
