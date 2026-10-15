"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Laptop, LogOut } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTimeBR } from "@/lib/dates";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Informe a senha atual"),
    newPassword: z
      .string()
      .min(10, "Use pelo menos 10 caracteres")
      .refine((p) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3, "Use ao menos três tipos de caracteres"),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: "As senhas não conferem" });

interface SessionDTO {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function deviceLabel(ua: string | null): string {
  if (!ua) return "Dispositivo desconhecido";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` · ${os}` : ""}`;
}

export function SecuritySection() {
  const qc = useQueryClient();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { currentPassword: "", newPassword: "", confirm: "" } });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<SessionDTO[]>("/api/v1/me/sessions") });
  const change = useMutation({
    mutationFn: (v: z.infer<typeof schema>) => api.post<{ sessionsRevoked: number }>("/api/v1/me/password", { currentPassword: v.currentPassword, newPassword: v.newPassword }),
    onSuccess: (r) => {
      toast.success("Senha alterada", { description: r.sessionsRevoked ? `${r.sessionsRevoked} outra(s) sessão(ões) encerrada(s).` : undefined });
      form.reset();
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/me/sessions/${id}`),
    onSuccess: () => {
      toast.success("Sessão encerrada");
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const e = form.formState.errors;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Alterar senha</CardTitle>
          <CardDescription>Ao alterar, as demais sessões são encerradas.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit((v) => change.mutate(v))} method="post" className="grid gap-4" noValidate>
            <Field label="Senha atual" htmlFor="cur" error={e.currentPassword?.message}>
              <Input id="cur" type="password" autoComplete="current-password" {...form.register("currentPassword")} />
            </Field>
            <Field label="Nova senha" htmlFor="new" error={e.newPassword?.message}>
              <Input id="new" type="password" autoComplete="new-password" {...form.register("newPassword")} />
            </Field>
            <Field label="Confirmar nova senha" htmlFor="conf" error={e.confirm?.message}>
              <Input id="conf" type="password" autoComplete="new-password" {...form.register("confirm")} />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="brand" loading={change.isPending}>
                Alterar senha
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sessões ativas</CardTitle>
          <CardDescription>Dispositivos conectados à sua conta.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {(sessions.data ?? []).map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-3 text-sm">
                <Laptop className="size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {deviceLabel(s.userAgent)} {s.current && <Badge variant="brand">esta sessão</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.ip ?? "IP desconhecido"} · último uso {formatDateTimeBR(s.lastSeenAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)} aria-label="Encerrar sessão">
                    <LogOut /> Encerrar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
