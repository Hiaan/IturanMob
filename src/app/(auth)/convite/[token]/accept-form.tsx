"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/client/api";

const schema = z.object({
  name: z.string().trim().min(2, "Informe seu nome"),
  relation: z.string().trim().max(40).optional(),
  password: z
    .string()
    .min(10, "Use pelo menos 10 caracteres")
    .refine((p) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3, "Use ao menos três tipos: minúsculas, maiúsculas, números e símbolos"),
});

export function AcceptInviteForm({ token, email, householdName }: { token: string; email: string; householdName: string }) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: "", relation: "", password: "" } });
  const e = form.formState.errors;
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post("/api/auth/invite/accept", { ...values, token });
      window.location.href = "/";
    } catch (err) {
      setError(errorMessage(err));
    }
  });
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Entrar em {householdName}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Crie sua senha para acessar as finanças da família ({email}).</p>
      <form onSubmit={onSubmit} method="post" className="mt-8 grid gap-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Seu nome" htmlFor="name" error={e.name?.message}>
            <Input id="name" autoComplete="name" {...form.register("name")} />
          </Field>
          <Field label="Parentesco" htmlFor="relation" hint="Ex.: Esposa">
            <Input id="relation" {...form.register("relation")} />
          </Field>
        </div>
        <Field label="Senha" htmlFor="password" error={e.password?.message}>
          <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" variant="brand" size="lg" loading={form.formState.isSubmitting}>
          Aceitar convite
        </Button>
      </form>
    </div>
  );
}
