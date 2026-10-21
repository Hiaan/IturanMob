import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Briefcase,
  CalendarDays,
  Camera,
  Check,
  CreditCard,
  FileSpreadsheet,
  Landmark,
  Lock,
  MessageCircle,
  Mic,
  Receipt,
  ShieldCheck,
  Sun,
  Target,
  TrendingDown,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Finance AI — suas finanças no WhatsApp, com inteligência artificial" },
  description:
    "Mande um áudio, uma foto ou uma mensagem no grupo da família e o gasto está lançado. Contas a pagar, cartões, boletos, relatórios, agenda e avisos — tudo pelo WhatsApp.",
  robots: { index: true, follow: true },
};

/*
 * Identidade visual do site: troque só estas variáveis para aplicar outra paleta (logo e cores da T9).
 */
const THEME = {
  "--t9-ink": "#0b2545",
  "--t9-ink-deep": "#071a33",
  "--t9-accent": "#10b981",
  "--t9-accent-strong": "#059669",
  "--t9-soft": "#e8f7f0",
  "--t9-bg": "#f6f8fb",
  "--t9-text": "#0b1b33",
  "--t9-muted": "#56657c",
  "--t9-line": "#e3e8ef",
} as React.CSSProperties;

function contactLink(): string | null {
  const number = env().SITE_CONTACT_WHATSAPP;
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent("Olá! Quero conhecer o Finance AI.")}`;
}

const STEPS: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: Users, title: "Conecte o grupo da família", text: "O Finance AI entra no grupo de WhatsApp que vocês escolherem. Só lê as mensagens de quem autorizou." },
  { icon: Mic, title: "Mande do jeito que preferir", text: "“50 no mercado”, um áudio, a foto do comprovante ou o PDF do boleto. Ele entende e lança." },
  { icon: BarChart3, title: "Acompanhe tudo no painel", text: "Gastos por categoria, contas a pagar, cartões, metas e relatórios — no celular ou no computador." },
];

const FEATURES: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: MessageCircle, title: "Lançamento pelo WhatsApp", text: "Texto, áudio ou foto. Vários gastos numa mensagem só, com categoria, cartão e parcelas." },
  { icon: Receipt, title: "Boleto vira conta a pagar", text: "Foto, PDF ou código do boleto: valor e vencimento conferidos pelo próprio código, com lembrete antes de vencer." },
  { icon: CreditCard, title: "Cartões e parcelas", text: "Fatura de cada cartão, compras parceladas e o que já está comprometido nos próximos meses." },
  { icon: Bell, title: "Contas a pagar e lembretes", text: "Aviso antes de vencer, no dia e quando ficou para trás. Marque como paga pelo WhatsApp." },
  { icon: TrendingDown, title: "Avisos inteligentes", text: "Avisa quando vai faltar dinheiro nos próximos 30 dias, quando aparece uma assinatura esquecida ou quando ela fica mais cara." },
  { icon: FileSpreadsheet, title: "Relatórios na conversa", text: "Peça “manda o relatório do mês” e o PDF ou a planilha chegam no grupo." },
  { icon: Landmark, title: "Conexão com os bancos", text: "Pelo Open Finance (Meu Pluggy), os lançamentos das contas e cartões chegam para você conferir." },
  { icon: CalendarDays, title: "Agenda e Google Agenda", text: "“Marca dentista amanhã às 15h”. Lembrete 1 hora antes e a sua agenda do Google junto." },
  { icon: Sun, title: "Resumo do dia", text: "Toda manhã: compromissos, contas do dia e quanto saiu ontem." },
  { icon: Target, title: "Metas e orçamentos", text: "Limite por categoria, metas de economia e meta de ganho do mês, com avisos de progresso." },
  { icon: Briefcase, title: "Pessoa física e empresa", text: "Separe o que é da casa e o que é do negócio — em grupos diferentes ou na mesma conversa." },
  { icon: Wallet, title: "Extratos e planilhas", text: "Importe extratos (PDF, OFX, CSV, Excel) e traga o histórico da sua planilha, sem duplicar nada." },
];

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Preciso instalar algum aplicativo?",
    a: "Não. Você usa o WhatsApp que já tem. O painel abre no navegador e pode ser instalado na tela inicial do celular, como um app.",
  },
  {
    q: "O Finance AI lê as minhas outras conversas?",
    a: "Não. Ele só processa o grupo que vocês autorizarem e só as mensagens de quem deu consentimento. Outras conversas e contatos não são lidos.",
  },
  {
    q: "É o WhatsApp oficial da Meta?",
    a: "Há dois modos. O mais usado conecta um número pelo QR Code, como o WhatsApp Web — não é uma integração oficial da Meta e existe risco de restrição do número. O modo oficial (API do WhatsApp Business) usa conversas diretas, sem grupo. Explicamos os dois antes de você escolher.",
  },
  {
    q: "A inteligência artificial pode errar um valor?",
    a: "Ela nunca grava nada sem validação: valores são conferidos, o que fica em dúvida vira uma pergunta e você pode corrigir pela própria conversa (“foram 15”, “foi no crédito”).",
  },
  {
    q: "Meus dados ficam seguros?",
    a: "Senhas e chaves ficam criptografadas, cada família vê só os próprios dados, contas podem ser privadas e tudo segue a LGPD — inclusive exportar e excluir seus dados.",
  },
  {
    q: "Funciona para casal e para quem tem empresa?",
    a: "Sim. Cada pessoa da família participa, com contas e cartões compartilhados ou privados, e dá para separar pessoa física e empresa nos relatórios.",
  },
  {
    q: "A conexão com os bancos é obrigatória?",
    a: "Não. Ela é opcional e usa o Meu Pluggy (Open Finance), em modo somente leitura. Sem ela, tudo funciona pelo WhatsApp e pela importação de extratos.",
  },
];

/** Conversa ilustrativa (exemplo de uso, não é de um cliente real). */
const CHAT: Array<{ from: "me" | "bot"; text: string }> = [
  { from: "me", text: "gastei 87,50 na padaria no débito" },
  { from: "bot", text: "✅ Padaria — R$ 87,50 · Alimentação · débito Nubank" },
  { from: "me", text: "🎙️ áudio · 0:06" },
  { from: "bot", text: "🎙️ Ouvi: “uber 23 reais”\n✅ Uber — R$ 23,00 · Transporte" },
  { from: "me", text: "manda o relatório do mês" },
  { from: "bot", text: "📊 Relatório — outubro de 2026\n📎 relatorio-mensal.pdf" },
];

function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-8 place-items-center rounded-lg bg-[var(--t9-accent)] text-sm font-bold text-[var(--t9-ink-deep)]">T9</span>
      <span className={light ? "text-white" : "text-[var(--t9-ink)]"}>
        Finance <span className="text-[var(--t9-accent)]">AI</span>
      </span>
    </span>
  );
}

function CTA({ href, children, variant = "solid" }: { href: string; children: React.ReactNode; variant?: "solid" | "ghost" }) {
  const external = href.startsWith("http");
  const cls =
    variant === "solid"
      ? "inline-flex items-center justify-center gap-2 rounded-full bg-[var(--t9-accent)] px-6 py-3 text-sm font-semibold text-[var(--t9-ink-deep)] shadow-sm transition hover:bg-[var(--t9-accent-strong)] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t9-accent)]"
      : "inline-flex items-center justify-center gap-2 rounded-full border border-white/25 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10";
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

function PhoneMockup() {
  return (
    <div className="relative mx-auto w-full max-w-[320px]" aria-label="Exemplo de conversa no WhatsApp" role="img">
      <div className="rounded-[2.2rem] border-[6px] border-[var(--t9-ink-deep)] bg-[#efeae2] shadow-2xl">
        <div className="flex items-center gap-2 rounded-t-[1.7rem] bg-[#075e54] px-4 py-3 text-white">
          <span className="grid size-8 place-items-center rounded-full bg-white/20 text-xs font-bold">💰</span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">Finanças da família</p>
            <p className="text-[11px] text-white/75">você, Ana, Finance AI</p>
          </div>
        </div>
        <div className="space-y-2 px-3 py-4 text-[13px]">
          {CHAT.map((m, i) => (
            <div key={i} className={m.from === "me" ? "flex justify-end" : "flex justify-start"}>
              <p className={`max-w-[85%] whitespace-pre-line rounded-lg px-3 py-1.5 shadow-sm ${m.from === "me" ? "bg-[#d9fdd3] text-[#111b21]" : "bg-white text-[#111b21]"}`}>{m.text}</p>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-white/60">Exemplo ilustrativo</p>
    </div>
  );
}

export default function SitePage() {
  const contact = contactLink();
  const price = env().SITE_PLAN_PRICE ?? null;
  const primaryHref = contact ?? "#planos";

  return (
    <div style={THEME} className="min-h-dvh bg-[var(--t9-bg)] text-[var(--t9-text)]">
      {/* Topo */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[var(--t9-ink-deep)]/95 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6" aria-label="Principal">
          <Link href="/" aria-label="Finance AI — início">
            <Logo light />
          </Link>
          <div className="hidden items-center gap-6 text-sm text-white/80 md:flex">
            <a href="#como-funciona" className="hover:text-white">Como funciona</a>
            <a href="#funcionalidades" className="hover:text-white">Funcionalidades</a>
            <a href="#planos" className="hover:text-white">Planos</a>
            <a href="#duvidas" className="hover:text-white">Dúvidas</a>
          </div>
          <Link href="/login" className="rounded-full border border-white/25 px-4 py-1.5 text-sm font-medium text-white hover:bg-white/10">
            Entrar
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-[var(--t9-ink-deep)] text-white">
          <div className="pointer-events-none absolute -right-40 -top-40 size-[520px] rounded-full bg-[var(--t9-accent)]/15 blur-3xl" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:grid-cols-[1.15fr_1fr] md:py-24">
            <div>
              <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-[var(--t9-accent)]">
                <MessageCircle className="size-3.5" aria-hidden /> Finanças pelo WhatsApp, com IA
              </p>
              <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
                Mande uma mensagem.
                <br />
                <span className="text-[var(--t9-accent)]">O resto é com a gente.</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg text-white/75">
                Áudio, foto do comprovante, boleto ou “50 no mercado” no grupo da família: o gasto é lançado, as contas ganham lembrete e você vê para onde vai o dinheiro.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <CTA href={primaryHref}>
                  {contact ? "Quero contratar" : "Ver planos"} <ArrowRight className="size-4" aria-hidden />
                </CTA>
                <CTA href="#como-funciona" variant="ghost">
                  Como funciona
                </CTA>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/70">
                {["Sem instalar app", "Para a família toda", "Dados protegidos (LGPD)"].map((t) => (
                  <li key={t} className="inline-flex items-center gap-1.5">
                    <Check className="size-4 text-[var(--t9-accent)]" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <PhoneMockup />
          </div>
        </section>

        {/* Como funciona */}
        <section id="como-funciona" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-[var(--t9-accent-strong)]">Como funciona</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-[var(--t9-ink)]">Organizar o dinheiro em 3 passos</h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-2xl border border-[var(--t9-line)] bg-white p-6 shadow-sm">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-[var(--t9-soft)] text-[var(--t9-accent-strong)]">
                    <s.icon className="size-5" aria-hidden />
                  </span>
                  <span className="text-sm font-semibold text-[var(--t9-muted)]">Passo {i + 1}</span>
                </div>
                <h3 className="mt-4 text-lg font-semibold text-[var(--t9-ink)]">{s.title}</h3>
                <p className="mt-2 text-[var(--t9-muted)]">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Funcionalidades */}
        <section id="funcionalidades" className="scroll-mt-20 border-y border-[var(--t9-line)] bg-white">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <p className="text-sm font-semibold uppercase tracking-wider text-[var(--t9-accent-strong)]">Funcionalidades</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight text-[var(--t9-ink)]">Tudo o que a sua vida financeira precisa, numa conversa</h2>
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <article key={f.title} className="rounded-2xl border border-[var(--t9-line)] p-6 transition hover:border-[var(--t9-accent)]/50 hover:shadow-md">
                  <f.icon className="size-6 text-[var(--t9-accent-strong)]" aria-hidden />
                  <h3 className="mt-4 font-semibold text-[var(--t9-ink)]">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--t9-muted)]">{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Segurança */}
        <section className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 md:grid-cols-2 md:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-[var(--t9-accent-strong)]">Privacidade</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-[var(--t9-ink)]">Seus dados são seus</h2>
            <p className="mt-4 text-[var(--t9-muted)]">
              O Finance AI foi feito para guardar só o necessário. Nada de ler outras conversas, nada de guardar número completo de cartão, nada de enviar dados a terceiros sem a sua autorização.
            </p>
          </div>
          <ul className="grid gap-4">
            {[
              { icon: Lock, t: "Contas e cartões privados", d: "Cada pessoa decide o que a família vê. Privado nunca vai para o grupo." },
              { icon: ShieldCheck, t: "Criptografia e auditoria", d: "Chaves e senhas criptografadas, histórico de alterações e backups." },
              { icon: Camera, t: "Comprovantes com cuidado", d: "Dados sensíveis de cartão são descartados; só o necessário é guardado." },
            ].map((x) => (
              <li key={x.t} className="flex gap-4 rounded-2xl border border-[var(--t9-line)] bg-white p-5">
                <x.icon className="mt-0.5 size-5 shrink-0 text-[var(--t9-accent-strong)]" aria-hidden />
                <div>
                  <p className="font-semibold text-[var(--t9-ink)]">{x.t}</p>
                  <p className="text-sm text-[var(--t9-muted)]">{x.d}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Planos */}
        <section id="planos" className="scroll-mt-20 bg-[var(--t9-ink-deep)] text-white">
          <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
            <p className="text-sm font-semibold uppercase tracking-wider text-[var(--t9-accent)]">Planos</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">Um plano, tudo incluído</h2>
            <div className="mx-auto mt-10 max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 text-left">
              <p className="text-lg font-semibold">Finance AI Família</p>
              {price ? (
                <p className="mt-3">
                  <span className="text-4xl font-bold">R$ {price}</span>
                  <span className="text-white/70"> /mês</span>
                </p>
              ) : (
                <p className="mt-3 text-white/75">Fale com a gente para saber o valor.</p>
              )}
              <ul className="mt-6 space-y-2.5 text-sm text-white/85">
                {[
                  "Lançamentos pelo WhatsApp (texto, áudio e foto)",
                  "Boletos, contas a pagar e lembretes",
                  "Cartões, parcelas e faturas",
                  "Relatórios em PDF e planilha",
                  "Avisos de falta de dinheiro e assinaturas",
                  "Agenda, Google Agenda e resumo do dia",
                  "Para toda a família, com contas privadas",
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-[var(--t9-accent)]" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                {contact ? (
                  <CTA href={contact}>
                    Quero contratar <ArrowRight className="size-4" aria-hidden />
                  </CTA>
                ) : (
                  <CTA href="/login">Já sou cliente: entrar</CTA>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Dúvidas */}
        <section id="duvidas" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-20 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-[var(--t9-accent-strong)]">Dúvidas</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-[var(--t9-ink)]">Perguntas frequentes</h2>
          <div className="mt-8 divide-y divide-[var(--t9-line)] rounded-2xl border border-[var(--t9-line)] bg-white">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-[var(--t9-ink)]">
                  {f.q}
                  <span className="text-xl leading-none text-[var(--t9-accent-strong)] transition group-open:rotate-45" aria-hidden>
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-[var(--t9-muted)]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Chamada final */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-[var(--t9-soft)] p-8 md:flex-row md:items-center md:p-12">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-[var(--t9-ink)]">Comece a organizar hoje</h2>
              <p className="mt-2 text-[var(--t9-muted)]">A primeira mensagem já vira lançamento.</p>
            </div>
            <CTA href={primaryHref}>
              {contact ? "Falar no WhatsApp" : "Ver planos"} <ArrowRight className="size-4" aria-hidden />
            </CTA>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--t9-line)] bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-[var(--t9-muted)] sm:flex-row sm:items-center sm:px-6">
          <Logo />
          <p>© {new Date().getFullYear()} T9 Company · Finance AI</p>
          <Link href="/login" className="font-medium text-[var(--t9-ink)] hover:underline">
            Entrar
          </Link>
        </div>
      </footer>
    </div>
  );
}
