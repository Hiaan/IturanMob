import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Briefcase,
  CalendarDays,
  Check,
  CreditCard,
  Eye,
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
  title: { absolute: "Finance AI by T9 — suas finanças no WhatsApp" },
  description:
    "Mande um áudio, uma foto ou uma mensagem no WhatsApp e o gasto está lançado. Contas a pagar, cartões, boletos, relatórios, agenda e avisos — tudo numa conversa.",
  robots: { index: true, follow: true },
  icons: { icon: "/brand/t9-icon.svg" },
};

/*
 * Identidade visual (T9 Company): fundo quase preto com brilho vermelho, vermelho T9 como destaque,
 * Lexend no texto e Archivo nos títulos. Para outra paleta, troque só estas variáveis.
 */
const THEME = {
  "--t9-bg": "#0a0506",
  "--t9-bg-2": "#120708",
  "--t9-card": "#160a0b",
  "--t9-line": "rgba(255,255,255,0.09)",
  "--t9-red": "#ff2d38",
  "--t9-red-strong": "#e3121c",
  "--t9-red-soft": "#ff5a63",
  "--t9-band": "#7c0409",
  "--t9-text": "#f6f3f3",
  "--t9-muted": "#a9a2a3",
  fontFamily: '"Lexend", system-ui, sans-serif',
} as React.CSSProperties;

const HEADING = { fontFamily: '"Archivo", "Lexend", system-ui, sans-serif' } as React.CSSProperties;

function contactLink(): string | null {
  const number = env().SITE_CONTACT_WHATSAPP;
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent("Olá! Quero conhecer o Finance AI.")}`;
}

/** Conversa ilustrativa (exemplo de uso, não é de um cliente real). */
const CHAT: Array<{ from: "me" | "bot"; text: string }> = [
  { from: "me", text: "gastei 62 na farmácia no débito" },
  { from: "bot", text: "✅ Farmácia — R$ 62,00\nSaúde · débito Nubank" },
  { from: "me", text: "🎙️ Áudio · 0:05" },
  { from: "bot", text: "🎙️ Ouvi: “uber 23 reais”\n✅ Uber — R$ 23,00 · Transporte" },
  { from: "me", text: "marca dentista amanhã às 15h" },
  { from: "bot", text: "📅 Marquei: Dentista — qua, 22/10 às 15:00. Aviso 1 hora antes." },
  { from: "me", text: "manda o relatório do mês" },
  { from: "bot", text: "📊 Relatório — outubro\n📎 relatorio-mensal.pdf" },
];

/** Exemplos do que dá para pedir (todos funcionam hoje). */
const ASK: string[] = [
  "50 no mercado",
  "paguei a luz, 187,43",
  "foto do comprovante",
  "código do boleto",
  "quanto gastei com comida?",
  "manda a planilha de setembro",
  "agenda de hoje",
  "marca reunião sexta às 10h",
  "meta de ganho da empresa 30 mil",
  "cria categoria Pet",
  "desconsidera esse, é repasse",
  "foi no crédito",
];

const STEPS: Array<{ n: number; title: string; text: string }> = [
  { n: 1, title: "Conecte", text: "O Finance AI entra no grupo de WhatsApp da família. Só lê o grupo autorizado, de quem deu consentimento." },
  { n: 2, title: "Converse", text: "Mande texto, áudio, foto ou PDF. Ele entende, confere e lança — e pergunta quando tiver dúvida." },
  { n: 3, title: "Acompanhe", text: "Painel com gastos por categoria, contas, cartões, metas e relatórios, no celular ou no computador." },
];

const FEATURES: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: MessageCircle, title: "Lançamento pelo WhatsApp", text: "Texto, áudio ou foto. Vários gastos numa mensagem só, com categoria, cartão e parcelas." },
  { icon: Receipt, title: "Boleto vira conta a pagar", text: "Foto, PDF ou código: valor e vencimento conferidos pelo próprio código, com lembrete." },
  { icon: CreditCard, title: "Cartões e parcelas", text: "Fatura de cada cartão, compras parceladas e o que já está comprometido nos próximos meses." },
  { icon: Bell, title: "Contas e lembretes", text: "Aviso antes de vencer, no dia e quando ficou para trás. Marque como paga pela conversa." },
  { icon: TrendingDown, title: "Avisos inteligentes", text: "Quando vai faltar dinheiro nos próximos 30 dias, assinatura esquecida ou que ficou mais cara." },
  { icon: FileSpreadsheet, title: "Relatórios na conversa", text: "“Manda o relatório do mês” e o PDF ou a planilha chegam no grupo." },
  { icon: Landmark, title: "Conexão com os bancos", text: "Open Finance (Meu Pluggy), somente leitura: os lançamentos chegam para você conferir." },
  { icon: CalendarDays, title: "Agenda e Google Agenda", text: "Compromissos pelo WhatsApp, lembrete 1 hora antes e a sua agenda do Google junto." },
  { icon: Sun, title: "Resumo do dia", text: "Toda manhã: compromissos, contas do dia e quanto saiu ontem." },
  { icon: Target, title: "Metas e orçamentos", text: "Limite por categoria, metas de economia e meta de ganho, com avisos de progresso." },
  { icon: Briefcase, title: "Pessoa física e empresa", text: "Separe a casa e o negócio — em grupos diferentes ou na mesma conversa." },
  { icon: Wallet, title: "Extratos e planilhas", text: "Importe extratos (PDF, OFX, CSV, Excel) e o histórico da sua planilha, sem duplicar." },
];

const TRUST: Array<{ icon: LucideIcon; title: string; sub: string }> = [
  { icon: Eye, title: "Acesso somente leitura", sub: "Ninguém movimenta seu dinheiro" },
  { icon: Lock, title: "Dados protegidos", sub: "Criptografia e LGPD" },
  { icon: Users, title: "Para a família toda", sub: "Contas privadas para cada um" },
  { icon: ShieldCheck, title: "Você no controle", sub: "A IA nunca grava sem validar" },
];

const BAND = ["LANÇAMENTOS POR ÁUDIO", "BOLETOS", "CARTÕES", "RELATÓRIOS", "OPEN FINANCE", "AGENDA", "METAS", "AVISOS"];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "Preciso instalar algum aplicativo?", a: "Não. Você usa o WhatsApp que já tem. O painel abre no navegador e pode ser instalado na tela inicial do celular, como um app." },
  { q: "O Finance AI lê as minhas outras conversas?", a: "Não. Ele só processa o grupo que vocês autorizarem e só as mensagens de quem deu consentimento. Outras conversas e contatos não são lidos." },
  {
    q: "É o WhatsApp oficial da Meta?",
    a: "Há dois modos. O mais usado conecta um número pelo QR Code, como o WhatsApp Web — não é uma integração oficial da Meta e existe risco de restrição do número. O modo oficial (API do WhatsApp Business) usa conversas diretas, sem grupo. Explicamos os dois antes de você escolher.",
  },
  { q: "A inteligência artificial pode errar um valor?", a: "Ela nunca grava nada sem validação: valores são conferidos, o que fica em dúvida vira uma pergunta e você corrige pela própria conversa (“foram 15”, “foi no crédito”)." },
  { q: "Meus dados ficam seguros?", a: "Senhas e chaves ficam criptografadas, cada família vê só os próprios dados, contas podem ser privadas e tudo segue a LGPD — inclusive exportar e excluir seus dados." },
  { q: "Funciona para casal e para quem tem empresa?", a: "Sim. Cada pessoa da família participa, com contas e cartões compartilhados ou privados, e dá para separar pessoa física e empresa." },
  { q: "A conexão com os bancos é obrigatória?", a: "Não. É opcional e usa o Meu Pluggy (Open Finance), em modo somente leitura. Sem ela, tudo funciona pelo WhatsApp e pela importação de extratos." },
];

function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/t9-icon.svg" alt="" width={34} height={34} className="size-[34px]" />
      <span className="leading-none">
        <span className="block text-[15px] font-semibold text-white">Finance AI</span>
        <span className="block text-[10px] font-medium tracking-wide text-[var(--t9-muted)]">by T9 Company</span>
      </span>
    </span>
  );
}

function CTA({ href, children, variant = "solid" }: { href: string; children: React.ReactNode; variant?: "solid" | "ghost" }) {
  const external = href.startsWith("http");
  const cls =
    variant === "solid"
      ? "inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-b from-[var(--t9-red)] to-[var(--t9-red-strong)] px-6 py-3 text-sm font-semibold text-white shadow-[0_0_28px_rgba(255,45,56,0.45)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t9-red)]"
      : "inline-flex items-center justify-center gap-2 rounded-full border border-white/20 px-6 py-3 text-sm font-medium text-white transition hover:bg-white/10";
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

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[var(--t9-red-soft)]">{children}</p>;
}

function Phone() {
  return (
    <div className="relative mx-auto w-full max-w-[330px]" role="img" aria-label="Exemplo de conversa no WhatsApp com o Finance AI">
      <div className="pointer-events-none absolute -inset-10 rounded-full bg-[var(--t9-red)]/25 blur-3xl" aria-hidden />
      <div className="relative rounded-[2.6rem] border border-white/15 bg-black p-2 shadow-2xl">
        <div className="overflow-hidden rounded-[2.2rem] bg-[#0b141a]">
          <div className="flex items-center gap-2.5 bg-[#1f2c34] px-4 pb-3 pt-5 text-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/t9-icon.svg" alt="" width={32} height={32} className="size-8" />
            <div className="leading-tight">
              <p className="text-sm font-medium">Finanças da família</p>
              <p className="text-[11px] text-white/60">você, Ana, Finance AI</p>
            </div>
          </div>
          <div className="space-y-2 px-3 py-4 text-[12.5px] leading-snug">
            {CHAT.map((m, i) => (
              <div key={i} className={m.from === "me" ? "flex justify-end" : "flex justify-start"}>
                <p className={`max-w-[86%] whitespace-pre-line rounded-xl px-3 py-1.5 ${m.from === "me" ? "bg-[#005c4b] text-white" : "bg-[#1f2c34] text-white/90"}`}>{m.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="relative mt-4 text-center text-xs text-white/45">Exemplo ilustrativo</p>
    </div>
  );
}

export default function SitePage() {
  const contact = contactLink();
  const price = env().SITE_PLAN_PRICE ?? null;
  const primaryHref = contact ?? "#planos";

  return (
    <div style={THEME} className="min-h-dvh overflow-x-hidden bg-[var(--t9-bg)] text-[var(--t9-text)] antialiased">
      {/* Topo */}
      <header className="fixed inset-x-0 top-0 z-30 px-3 pt-3">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-full border border-[var(--t9-line)] bg-black/60 px-4 py-2.5 backdrop-blur-md sm:px-5" aria-label="Principal">
          <Link href="/" aria-label="Finance AI — início">
            <Logo />
          </Link>
          <div className="hidden items-center gap-7 text-sm text-white/70 md:flex">
            <a href="#como-funciona" className="hover:text-white">Como funciona</a>
            <a href="#o-que-pedir" className="hover:text-white">O que pedir</a>
            <a href="#funcionalidades" className="hover:text-white">Funcionalidades</a>
            <a href="#planos" className="hover:text-white">Planos</a>
            <a href="#duvidas" className="hover:text-white">Dúvidas</a>
          </div>
          <Link href="/login" className="rounded-full border border-white/20 px-4 py-1.5 text-sm font-medium text-white hover:bg-white/10">
            Entrar
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden pt-32">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(ellipse_at_top,rgba(255,45,56,0.28),transparent_60%)]" aria-hidden />
          <div className="pointer-events-none absolute inset-y-0 left-[6%] hidden w-px bg-gradient-to-b from-transparent via-[var(--t9-red)]/40 to-transparent lg:block" aria-hidden />
          <div className="pointer-events-none absolute inset-y-0 right-[6%] hidden w-px bg-gradient-to-b from-transparent via-[var(--t9-red)]/40 to-transparent lg:block" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
            <div className="text-center lg:text-left">
              <p className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--t9-line)] bg-white/5 px-3.5 py-1 text-xs text-white/80 lg:mx-0">
                <span className="size-1.5 rounded-full bg-[var(--t9-red)] shadow-[0_0_10px_var(--t9-red)]" aria-hidden /> Finanças pelo WhatsApp, com IA
              </p>
              <h1 style={HEADING} className="text-4xl font-extrabold leading-[1.05] tracking-tight text-white sm:text-6xl">
                Sua vida financeira organizada <span className="text-[var(--t9-red)]">numa conversa.</span>
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg font-light text-[var(--t9-muted)] lg:mx-0">
                Mande um áudio, a foto do comprovante, o boleto ou “50 no mercado” no WhatsApp. O Finance AI lança, organiza, lembra das contas e mostra para onde vai o dinheiro.
              </p>
              <div className="mt-9 flex flex-wrap justify-center gap-3 lg:justify-start">
                <CTA href={primaryHref}>
                  {contact ? "Quero contratar" : "Ver planos"} <ArrowRight className="size-4" aria-hidden />
                </CTA>
                <CTA href="#como-funciona" variant="ghost">
                  Como funciona
                </CTA>
              </div>
            </div>
            <Phone />
          </div>
        </section>

        {/* Faixa de confiança */}
        <section aria-label="Garantias" className="border-y border-[var(--t9-line)] bg-black/40">
          <ul className="mx-auto grid max-w-6xl grid-cols-1 gap-px px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {TRUST.map((t) => (
              <li key={t.title} className="flex items-center gap-3 py-5">
                <t.icon className="size-5 shrink-0 text-[var(--t9-red-soft)]" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-white">{t.title}</p>
                  <p className="text-[11px] uppercase tracking-wider text-[var(--t9-muted)]">{t.sub}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Como funciona */}
        <section id="como-funciona" className="relative scroll-mt-24 bg-gradient-to-b from-[var(--t9-bg)] to-[#1a0507]">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <Eyebrow>Como funciona</Eyebrow>
            <h2 style={HEADING} className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Três passos. Nenhuma planilha.
            </h2>
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="rounded-2xl border border-[var(--t9-line)] bg-[var(--t9-card)] p-7">
                  <span style={HEADING} className="grid size-11 place-items-center rounded-xl border border-[var(--t9-red)]/40 bg-gradient-to-b from-[#3a0a0d] to-black text-lg font-extrabold text-white shadow-[0_0_18px_rgba(255,45,56,0.25)]">
                    {s.n}
                  </span>
                  <h3 style={HEADING} className="mt-5 text-xl font-bold text-white">
                    {s.title}
                  </h3>
                  <p className="mt-2 font-light text-[var(--t9-muted)]">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Faixa vermelha (como no site da T9) */}
        <div className="overflow-hidden border-y border-[var(--t9-red)]/40 bg-[var(--t9-band)] py-4" aria-hidden>
          <div style={HEADING} className="flex w-max gap-8 whitespace-nowrap text-lg font-extrabold text-white sm:text-xl">
            {[...BAND, ...BAND].map((b, i) => (
              <span key={i} className="inline-flex items-center gap-8">
                {b} <span className="text-[var(--t9-red-soft)]">✦</span>
              </span>
            ))}
          </div>
        </div>

        {/* O que pedir */}
        <section id="o-que-pedir" className="scroll-mt-24">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <Eyebrow>O que pedir</Eyebrow>
            <h2 style={HEADING} className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Fale do seu jeito. Ele entende.
            </h2>
            <p className="mt-4 max-w-2xl font-light text-[var(--t9-muted)]">Alguns exemplos do que dá para mandar no grupo:</p>
            <ul className="mt-8 flex flex-wrap gap-2.5">
              {ASK.map((a) => (
                <li key={a} className="rounded-full border border-[var(--t9-line)] bg-white/[0.04] px-4 py-2 text-sm text-white/85">
                  “{a}”
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Funcionalidades */}
        <section id="funcionalidades" className="scroll-mt-24 border-t border-[var(--t9-line)] bg-[var(--t9-bg-2)]">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <Eyebrow>Funcionalidades</Eyebrow>
            <h2 style={HEADING} className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Tudo o que a sua vida financeira precisa
            </h2>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <article key={f.title} className="group rounded-2xl border border-[var(--t9-line)] bg-[var(--t9-card)] p-6 transition hover:border-[var(--t9-red)]/50 hover:shadow-[0_0_30px_rgba(255,45,56,0.12)]">
                  <span className="grid size-10 place-items-center rounded-xl bg-[var(--t9-red)]/10 text-[var(--t9-red-soft)]">
                    <f.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-semibold text-white">{f.title}</h3>
                  <p className="mt-1.5 text-sm font-light leading-relaxed text-[var(--t9-muted)]">{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Painel */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-24 sm:px-6 md:grid-cols-2">
          <div>
            <Eyebrow>Painel</Eyebrow>
            <h2 style={HEADING} className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Veja tudo de uma vez
            </h2>
            <p className="mt-4 font-light text-[var(--t9-muted)]">
              Além da conversa, um painel completo no navegador ou instalado no celular: gastos por categoria, saldo das contas, faturas dos cartões, contas a pagar, agenda, metas e relatórios.
            </p>
          </div>
          <ul className="grid gap-3">
            {[
              { icon: BarChart3, t: "Gastos por categoria e comparativos" },
              { icon: CreditCard, t: "Faturas e parcelas dos cartões" },
              { icon: Bell, t: "Contas a pagar e o que vence hoje" },
              { icon: Mic, t: "Tudo o que chegou pelo WhatsApp, para conferir" },
            ].map((x) => (
              <li key={x.t} className="flex items-center gap-3 rounded-xl border border-[var(--t9-line)] bg-[var(--t9-card)] px-5 py-4">
                <x.icon className="size-5 shrink-0 text-[var(--t9-red-soft)]" aria-hidden />
                <span className="text-sm text-white/90">{x.t}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Planos */}
        <section id="planos" className="relative scroll-mt-24 overflow-hidden border-t border-[var(--t9-line)]">
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[520px] bg-[radial-gradient(ellipse_at_bottom,rgba(255,45,56,0.22),transparent_60%)]" aria-hidden />
          <div className="relative mx-auto max-w-6xl px-4 py-24 text-center sm:px-6">
            <Eyebrow>Planos</Eyebrow>
            <h2 style={HEADING} className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Um plano, tudo incluído
            </h2>
            <div className="mx-auto mt-12 max-w-md rounded-3xl border border-[var(--t9-red)]/30 bg-[var(--t9-card)]/90 p-8 text-left shadow-[0_0_60px_rgba(255,45,56,0.15)]">
              <p style={HEADING} className="text-xl font-bold text-white">
                Finance AI Família
              </p>
              {price ? (
                <p className="mt-3">
                  <span style={HEADING} className="text-5xl font-extrabold text-white">
                    R$ {price}
                  </span>
                  <span className="text-[var(--t9-muted)]"> /mês</span>
                </p>
              ) : (
                <p className="mt-3 text-[var(--t9-muted)]">Fale com a gente para saber o valor.</p>
              )}
              <ul className="mt-7 space-y-3 text-sm text-white/85">
                {[
                  "Lançamentos pelo WhatsApp (texto, áudio e foto)",
                  "Boletos, contas a pagar e lembretes",
                  "Cartões, parcelas e faturas",
                  "Relatórios em PDF e planilha",
                  "Avisos de falta de dinheiro e de assinaturas",
                  "Agenda, Google Agenda e resumo do dia",
                  "Para toda a família, com contas privadas",
                ].map((t) => (
                  <li key={t} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-[var(--t9-red-soft)]" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex">
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
        <section id="duvidas" className="mx-auto max-w-3xl scroll-mt-24 px-4 py-24 sm:px-6">
          <Eyebrow>Dúvidas</Eyebrow>
          <h2 style={HEADING} className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Perguntas frequentes
          </h2>
          <div className="mt-10 divide-y divide-[var(--t9-line)] rounded-2xl border border-[var(--t9-line)] bg-[var(--t9-card)]">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-6 py-5 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-white">
                  {f.q}
                  <span className="text-2xl leading-none text-[var(--t9-red)] transition group-open:rotate-45" aria-hidden>
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm font-light leading-relaxed text-[var(--t9-muted)]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Chamada final */}
        <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="relative overflow-hidden rounded-3xl border border-[var(--t9-red)]/30 bg-gradient-to-br from-[#3a0a0d] via-[#1a0507] to-black p-8 md:p-14">
            <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-[var(--t9-red)]/25 blur-3xl" aria-hidden />
            <div className="relative flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
              <div>
                <h2 style={HEADING} className="text-3xl font-extrabold tracking-tight text-white">
                  Comece a organizar hoje.
                </h2>
                <p className="mt-2 font-light text-[var(--t9-muted)]">A primeira mensagem já vira lançamento.</p>
              </div>
              <CTA href={primaryHref}>
                {contact ? "Falar no WhatsApp" : "Ver planos"} <ArrowRight className="size-4" aria-hidden />
              </CTA>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--t9-line)]">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-[var(--t9-muted)] sm:flex-row sm:items-center sm:px-6">
          <Logo />
          <p>© {new Date().getFullYear()} T9 Company · Finance AI</p>
          <Link href="/login" className="font-medium text-white hover:underline">
            Entrar
          </Link>
        </div>
      </footer>
    </div>
  );
}
