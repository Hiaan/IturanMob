"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/client/api";

const schema = z.object({
  email: z.string().trim().email("Informe um e-mail válido"),
  password: z.string().min(1, "Informe a senha"),
});

export function LoginForm() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post("/api/auth/login", values);
      const next = params.get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Bem-vindo de volta</h1>
      <p className="mt-1 text-sm text-muted-foreground">Entre para acompanhar as finanças da família.</p>
      <form onSubmit={onSubmit} className="mt-8 grid gap-4" noValidate>
        <Field label="E-mail" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} aria-invalid={Boolean(form.formState.errors.email)} />
        </Field>
        <Field label="Senha" htmlFor="password" error={form.formState.errors.password?.message}>
          <div className="relative">
            <Input id="password" type={show ? "text" : "password"} autoComplete="current-password" className="pr-10" {...form.register("password")} />
            <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={show ? "Ocultar senha" : "Mostrar senha"}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" variant="brand" size="lg" loading={form.formState.isSubmitting}>
          Entrar
        </Button>
      </form>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Recebeu um convite? Use o link enviado pelo administrador da família.{" "}
        <Link href="/cadastro" className="font-medium text-brand hover:underline">
          Criar família
        </Link>
      </p>
    </div>
  );
}
