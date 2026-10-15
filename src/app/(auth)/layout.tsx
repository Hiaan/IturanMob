import { ShieldCheck, Wallet, MessageCircle, Sparkles } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 size-[30rem] rounded-full bg-sky-500/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white">
            <Wallet className="size-5" />
          </span>
          <span className="text-lg font-semibold text-white">Finance AI</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">As finanças da família, organizadas a partir de uma mensagem.</h2>
          <p className="mt-4 text-sidebar-foreground">Registre gastos por texto, áudio ou foto do comprovante no grupo do WhatsApp. O resto fica com a gente.</p>
          <ul className="mt-8 space-y-4 text-sm">
            <li className="flex items-center gap-3">
              <MessageCircle className="size-5 text-emerald-300" /> Lançamentos em linguagem natural, sem sintaxe para decorar
            </li>
            <li className="flex items-center gap-3">
              <Sparkles className="size-5 text-emerald-300" /> Categorização, parcelamentos e faturas automáticos
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="size-5 text-emerald-300" /> Dados criptografados e isolados por família
            </li>
          </ul>
        </div>
      </div>
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
