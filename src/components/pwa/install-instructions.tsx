"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CircleCheck, Copy, Download, MonitorSmartphone, Share, SquarePlus, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { promptInstall, useInstallPromptAvailable, usePwaEnvironment } from "@/lib/client/pwa";

/** Âncora usada pelos avisos ("Como instalar") para chegar a estas instruções em Configurações. */
export const INSTALL_SECTION_ID = "instalar-app";
export const INSTALL_SECTION_HREF = `/configuracoes?tab=notificacoes#${INSTALL_SECTION_ID}`;

/** Passo a passo do Safari no iPhone/iPad: Compartilhar → Adicionar à Tela de Início → Adicionar. */
export function IosInstallSteps({ className, compact }: { className?: string; compact?: boolean }) {
  const glyph = "mx-1 inline-block size-4 align-[-3px] text-brand";
  return (
    <ol className={cn("grid gap-2 text-sm", className)}>
      <Step n={1}>
        Toque em <strong>Compartilhar</strong>
        <Share className={glyph} aria-hidden />
        <span className="sr-only">(ícone de quadrado com seta para cima) </span>
        {!compact && <span className="text-muted-foreground">na barra do Safari. Se não aparecer, toque em ••• e depois em Compartilhar.</span>}
      </Step>
      <Step n={2}>
        Role a lista e toque em
        <SquarePlus className={glyph} aria-hidden />
        <strong>“Adicionar à Tela de Início”</strong>
      </Step>
      <Step n={3}>
        Toque em <strong>Adicionar</strong>
        {!compact && <span className="text-muted-foreground"> (deixe “Abrir como app web” ligado, se aparecer). Depois, abra o Finanças pela Tela de Início.</span>}
      </Step>
    </ol>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground" aria-hidden>
        {n}
      </span>
      <span className="min-w-0 pt-1">
        <span className="sr-only">Passo {n}: </span>
        {children}
      </span>
    </li>
  );
}

/** Botão do convite nativo de instalação (Android/Chrome/Edge). Some quando não há convite. */
export function InstallPromptButton({ size, className }: { size?: "sm" | "default"; className?: string }) {
  const available = useInstallPromptAvailable();
  const [busy, setBusy] = useState(false);
  if (!available) return null;
  return (
    <Button
      type="button"
      variant="brand"
      size={size}
      className={className}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const accepted = await promptInstall();
          if (accepted) toast.success("App instalado. Abra o Finanças pela tela inicial.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download /> Instalar app
    </Button>
  );
}

/**
 * Cartão "Instalar o app" em Configurações → Notificações: instruções conforme o aparelho
 * (Safari no iPhone, outro navegador no iPhone, Android/Chrome com convite, computador).
 */
export function InstallAppCard() {
  const env = usePwaEnvironment();
  const promptAvailable = useInstallPromptAvailable();
  const ref = useRef<HTMLDivElement>(null);

  // Chegando por "Como instalar" (…#instalar-app), rola até aqui depois que a aba renderiza.
  useEffect(() => {
    if (window.location.hash === `#${INSTALL_SECTION_ID}`) ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      toast.success("Endereço copiado. Cole no Safari para instalar.");
    } catch {
      toast.error("Não foi possível copiar. Abra o Safari e digite o endereço do app.");
    }
  };

  return (
    <Card ref={ref} id={INSTALL_SECTION_ID} className="scroll-mt-[calc(5rem+var(--safe-top))]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="size-4 text-brand" aria-hidden /> Instalar o app
        </CardTitle>
        <CardDescription>Abra o Finanças direto da tela inicial, em tela cheia, e receba notificações no celular.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!env ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : env.standalone ? (
          <p className="flex items-center gap-2 text-sm font-medium text-positive">
            <CircleCheck className="size-4" aria-hidden /> Você está usando o app instalado.
          </p>
        ) : env.iosSafari ? (
          <>
            <p className="text-sm text-muted-foreground">No iPhone ou iPad, pelo Safari:</p>
            <IosInstallSteps />
          </>
        ) : env.ios ? (
          <div className="grid gap-3 text-sm">
            <p>
              No iPhone, a instalação é feita pelo <strong>Safari</strong>. Abra este endereço no Safari e siga: Compartilhar → “Adicionar à Tela de Início” → Adicionar.
            </p>
            <Button type="button" variant="outline" className="w-fit" onClick={copyLink}>
              <Copy /> Copiar endereço
            </Button>
          </div>
        ) : promptAvailable ? (
          <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground">Este navegador permite instalar o app neste aparelho.</p>
            <InstallPromptButton className="w-fit" />
          </div>
        ) : env.android ? (
          <p className="flex items-start gap-2 text-sm">
            <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              No Chrome: toque no menu <strong>⋮</strong> e em <strong>“Instalar app”</strong> (ou “Adicionar à tela inicial”).
            </span>
          </p>
        ) : (
          <div className="grid gap-2 text-sm">
            <p>
              <strong>No iPhone:</strong> abra no Safari → Compartilhar (⬆︎) → “Adicionar à Tela de Início” → Adicionar.
            </p>
            <p>
              <strong>No Android:</strong> no Chrome, menu ⋮ → “Instalar app”.
            </p>
            <p className="text-muted-foreground">No computador, use o ícone de instalar na barra de endereço do Chrome ou do Edge.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
