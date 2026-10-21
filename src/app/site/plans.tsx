"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";

/**
 * Pacotes do site (mensal × anual). Anual = 10 mensalidades (2 meses grátis), cobrado de uma vez.
 * Os preços e recursos ficam só aqui.
 */
export interface Plan {
  id: string;
  name: string;
  tagline: string;
  /** Mensal, em centavos. */
  monthlyCents: number;
  /** Anual (cobrado de uma vez), em centavos. */
  yearlyCents: number;
  people: string;
  highlight?: boolean;
  /** "Tudo do X, mais:" */
  includesFrom?: string;
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: "essencial",
    name: "Essencial",
    tagline: "Para organizar o dia a dia",
    monthlyCents: 1990,
    yearlyCents: 19900,
    people: "Até 2 pessoas",
    features: [
      "Lançamentos pelo WhatsApp: texto, áudio e foto",
      "Categorias automáticas",
      "Cartões, faturas e parcelas",
      "Contas a pagar com lembretes",
      "Boleto vira conta a pagar",
      "Relatório do mês pelo WhatsApp",
      "Painel no celular e no computador",
    ],
  },
  {
    id: "familia",
    name: "Família",
    tagline: "A casa toda no controle",
    monthlyCents: 2990,
    yearlyCents: 29900,
    people: "Até 5 pessoas",
    highlight: true,
    includesFrom: "Tudo do Essencial, mais:",
    features: [
      "Contas e cartões privados para cada pessoa",
      "Avisos de falta de dinheiro e de assinaturas",
      "Agenda, lembretes e resumo do dia",
      "Google Agenda de cada pessoa",
      "Metas de economia e orçamentos",
      "Importar extratos e a sua planilha",
    ],
  },
  {
    id: "completo",
    name: "Família + Empresa",
    tagline: "Casa e negócio, separados",
    monthlyCents: 4990,
    yearlyCents: 49900,
    people: "Até 5 pessoas",
    includesFrom: "Tudo do Família, mais:",
    features: [
      "Pessoa física e empresa separadas",
      "Grupo de WhatsApp só da empresa",
      "Meta de ganho do mês",
      "Repasses de clientes fora dos relatórios",
      "Conexão com os bancos (Open Finance)*",
      "Relatórios e planilhas a qualquer hora",
    ],
  },
];

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Plans({ contactHref, headingStyle }: { contactHref: string | null; headingStyle: React.CSSProperties }) {
  const [yearly, setYearly] = useState(true);
  return (
    <div>
      <div role="radiogroup" aria-label="Forma de pagamento" className="mx-auto mt-10 inline-flex rounded-full border border-[var(--t9-line)] bg-white/5 p-1 text-sm">
        {[
          { v: false, label: "Mensal" },
          { v: true, label: "Anual" },
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={yearly === o.v}
            onClick={() => setYearly(o.v)}
            className={`rounded-full px-5 py-2 font-medium transition ${yearly === o.v ? "bg-[var(--t9-red)] text-white shadow-[0_0_18px_rgba(255,45,56,0.4)]" : "text-white/70 hover:text-white"}`}
          >
            {o.label}
            {o.v && <span className="ml-1.5 rounded-full bg-black/30 px-2 py-0.5 text-[11px]">2 meses grátis</span>}
          </button>
        ))}
      </div>

      <div className="mt-10 grid gap-5 text-left lg:grid-cols-3">
        {PLANS.map((p) => {
          const perMonth = yearly ? Math.round(p.yearlyCents / 12) : p.monthlyCents;
          return (
            <article
              key={p.id}
              aria-label={`Plano ${p.name}`}
              className={`relative flex flex-col rounded-3xl border p-7 ${
                p.highlight ? "border-[var(--t9-red)]/60 bg-gradient-to-b from-[#2a0709] to-[var(--t9-card)] shadow-[0_0_60px_rgba(255,45,56,0.18)]" : "border-[var(--t9-line)] bg-[var(--t9-card)]"
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-7 rounded-full bg-[var(--t9-red)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">Mais escolhido</span>
              )}
              <h3 style={headingStyle} className="text-xl font-bold text-white">
                {p.name}
              </h3>
              <p className="mt-1 text-sm text-[var(--t9-muted)]">{p.tagline}</p>
              <p className="mt-6">
                <span className="align-top text-sm text-white/70">R$ </span>
                <span style={headingStyle} className="text-5xl font-extrabold text-white">
                  {brl(perMonth).split(",")[0]}
                </span>
                <span style={headingStyle} className="text-xl font-bold text-white">
                  ,{brl(perMonth).split(",")[1]}
                </span>
                <span className="text-[var(--t9-muted)]"> /mês</span>
              </p>
              <p className="mt-1 h-5 text-xs text-[var(--t9-muted)]">
                {yearly ? `R$ ${brl(p.yearlyCents)} por ano, à vista` : `ou R$ ${brl(p.yearlyCents)} no plano anual`}
              </p>
              <p className="mt-5 text-sm font-medium text-white">{p.people}</p>
              {p.includesFrom && <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-[var(--t9-red-soft)]">{p.includesFrom}</p>}
              <ul className="mt-3 flex-1 space-y-2.5 text-sm text-white/85">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-[var(--t9-red-soft)]" aria-hidden /> {f}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                {contactHref ? (
                  <a
                    href={contactHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex w-full items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white transition ${
                      p.highlight ? "bg-gradient-to-b from-[var(--t9-red)] to-[var(--t9-red-strong)] shadow-[0_0_28px_rgba(255,45,56,0.45)] hover:brightness-110" : "border border-white/20 hover:bg-white/10"
                    }`}
                  >
                    Quero o {p.name} <ArrowRight className="size-4" aria-hidden />
                  </a>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled
                      className={`inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white/80 ${p.highlight ? "bg-[var(--t9-red)]/60" : "border border-white/15"}`}
                    >
                      Quero o {p.name}
                    </button>
                    <p className="mt-2 text-center text-xs text-[var(--t9-muted)]">Contratação disponível em breve</p>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-8 text-center text-xs text-[var(--t9-muted)]">
        * A conexão com os bancos usa a sua própria conta gratuita do Meu Pluggy (até 5 bancos, atualização 1 vez por dia), em modo somente leitura.
      </p>
    </div>
  );
}
