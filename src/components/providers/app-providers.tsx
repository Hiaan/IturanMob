"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PwaRuntime } from "@/components/pwa/pwa-runtime";
import { ApiError } from "@/lib/client/api";

/** Avisos no tema atual e fora do entalhe/barra de status do iPhone (app instalado). */
function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="top-center"
      richColors
      closeButton
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      offset={{ top: "calc(var(--safe-top) + 16px)", left: "calc(var(--safe-left) + 16px)", right: "calc(var(--safe-right) + 16px)" }}
      mobileOffset={{ top: "calc(var(--safe-top) + 12px)", left: "calc(var(--safe-left) + 12px)", right: "calc(var(--safe-right) + 12px)" }}
      toastOptions={{ classNames: { toast: "rounded-xl" } }}
    />
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          {children}
          <AppToaster />
          <PwaRuntime />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
