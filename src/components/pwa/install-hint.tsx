"use client";

import { useEffect, useState } from "react";
import { Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INSTALL_HINT_DISMISSED_KEY, readLocal, useInstallPromptAvailable, usePwaEnvironment, writeLocal } from "@/lib/client/pwa";
import { InstallPromptButton, IosInstallSteps } from "./install-instructions";

/**
 * Aviso "Instale o app" no topo das páginas:
 * - Safari no iPhone/iPad fora do app instalado → passo a passo (Compartilhar → Adicionar à Tela de Início);
 * - Android com convite do navegador → botão "Instalar app".
 * Some ao dispensar (lembrado neste aparelho); as instruções continuam em Configurações → Notificações.
 */
export function InstallHint() {
  const env = usePwaEnvironment();
  const promptAvailable = useInstallPromptAvailable();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(Boolean(readLocal(INSTALL_HINT_DISMISSED_KEY)));
  }, []);

  if (!env || env.standalone || dismissed) return null;
  const ios = env.iosSafari;
  const android = env.android && promptAvailable;
  if (!ios && !android) return null;

  const dismiss = () => {
    writeLocal(INSTALL_HINT_DISMISSED_KEY, new Date().toISOString());
    setDismissed(true);
  };

  return (
    <section aria-labelledby="install-hint-title" className="relative mb-6 overflow-hidden rounded-xl border border-brand/30 bg-accent/60 p-4 pr-12 text-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white" aria-hidden>
          <Smartphone className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="install-hint-title" className="font-semibold text-foreground">
            {ios ? "Instale o app no iPhone" : "Instale o app no celular"}
          </h2>
          <p className="mt-0.5 text-muted-foreground">Abra direto da tela inicial, em tela cheia, e receba notificações.</p>
          {ios ? <IosInstallSteps compact className="mt-3" /> : <InstallPromptButton size="sm" className="mt-3" />}
          <Button type="button" variant="ghost" size="sm" className="-ml-3 mt-2 text-muted-foreground" onClick={dismiss}>
            Agora não
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Dispensar aviso de instalação"
      >
        <X className="size-4" />
      </button>
    </section>
  );
}
