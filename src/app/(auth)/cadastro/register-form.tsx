"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/client/api";

const schema = z.object({
  householdName: z.string().trim().min(2, "Dê um nome à família").max(80),
  name: z.string().trim().min(2, "Informe seu nome").max(80),
  relation: z.string().trim().max(40).optional(),
  email: z.string().trim().email("Informe um e-mail válido"),
  password: z
    .string()
    .min(10, "Use pelo menos 10 caracteres")
    .refine((p) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3, "Use ao menos três tipos: minúsculas, maiúsculas, números e símbolos"),
});

export function RegisterForm({ firstRun }: { firstRun: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { householdName: "", name: "", relation: "", email: "", password: "" } });
  const e = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post("/api/auth/register", { ...values, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      window.location.href = "/?boasvindas=1";
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{firstRun ? "Configure sua família" : "Criar nova família"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {firstRun ? "Este é o primeiro acesso. Você será o proprietário e poderá convidar seu cônjuge depois." : "Crie uma nova família e convide os participantes."}
      </p>
      <form onSubmit={onSubmit} method="post" className="mt-8 grid gap-4" noValidate>
        <Field label="Nome da família" htmlFor="householdName" error={e.householdName?.message}>
          <Input id="householdName" placeholder="Ex.: Família Silva" {...form.register("householdName")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Seu nome" htmlFor="name" error={e.name?.message}>
            <Input id="name" autoComplete="name" {...form.register("name")} />
          </Field>
          <Field label="Parentesco" htmlFor="relation" hint="Ex.: Marido">
            <Input id="relation" {...form.register("relation")} />
          </Field>
        </div>
        <Field label="E-mail" htmlFor="email" error={e.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
        </Field>
        <Field label="Senha" htmlFor="password" error={e.password?.message} hint="Mínimo de 10 caracteres, misturando letras, números e símbolos">
          <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" variant="brand" size="lg" loading={form.formState.isSubmitting}>
          Criar família
        </Button>
      </form>
      {!firstRun && (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Já tem conta?{" "}
          <Link href="/login" className="font-medium text-brand hover:underline">
            Entrar
          </Link>
        </p>
      )}
    </div>
  );
}
