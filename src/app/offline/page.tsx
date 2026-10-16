import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sem conexão" };
export const dynamic = "force-static";

/** Mostrada pelo app instalado quando não há internet. Não contém dados da família. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <img src="/icons/icon-192.png" alt="" width={72} height={72} className="rounded-2xl" />
      <h1 className="text-xl font-semibold">Sem conexão</h1>
      <p className="max-w-sm text-sm text-muted-foreground">Seus dados aparecem quando a internet voltar. Nenhuma informação financeira fica guardada neste aparelho.</p>
      <a href="/" className="mt-2 inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground">
        Tentar de novo
      </a>
    </main>
  );
}
