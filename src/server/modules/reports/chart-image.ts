import sharp from "sharp";
import { formatBRL } from "@/lib/money";

/**
 * Gráfico em imagem (PNG) para mandar no WhatsApp: SVG desenhado aqui e convertido pelo sharp.
 * Dois formatos: barras por mês (uma ou mais séries lado a lado) e barras horizontais por categoria.
 * Paleta fixa por série (a cor acompanha a série, não a posição), legenda sempre com 2+ séries.
 */

const W = 1080;
const H = 760;
const FONT = "DejaVu Sans, Liberation Sans, Arial, sans-serif";
const SERIES = ["#0f766e", "#d97706", "#7c3aed", "#db2777"];
const INK = "#0f172a";
const MUTED = "#64748b";
const GRID = "#e2e8f0";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (cents: number) => {
  const v = cents / 100;
  if (v >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1).replace(".", ",")} mi`;
  if (v >= 10_000) return `R$ ${Math.round(v / 1000)} mil`;
  if (v >= 1_000) return `R$ ${(v / 1000).toFixed(1).replace(".", ",")} mil`;
  return `R$ ${Math.round(v)}`;
};
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function frame(title: string, subtitle: string, body: string, height = H): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">
<rect width="${W}" height="${height}" fill="#ffffff"/>
<text x="48" y="64" font-family="${FONT}" font-size="34" font-weight="700" fill="${INK}">${esc(trunc(title, 52))}</text>
<text x="48" y="100" font-family="${FONT}" font-size="20" fill="${MUTED}">${esc(trunc(subtitle, 90))}</text>
${body}
<text x="${W - 48}" y="${height - 22}" text-anchor="end" font-family="${FONT}" font-size="16" fill="${MUTED}">T9 Finance · Isa</text>
</svg>`;
}

/** Barras verticais por mês; cada série é uma categoria (ou o total). */
export function monthlyBarsSvg(input: { title: string; subtitle: string; months: string[]; series: Array<{ name: string; values: number[] }> }): string {
  const left = 120;
  const right = W - 48;
  const top = input.series.length > 1 ? 170 : 140;
  const bottom = H - 90;
  const max = Math.max(1, ...input.series.flatMap((s) => s.values));
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const y = (v: number) => bottom - (v / yMax) * (bottom - top);
  const parts: string[] = [];
  for (let v = 0; v <= yMax; v += step) {
    parts.push(`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 12}" y="${y(v) + 6}" text-anchor="end" font-family="${FONT}" font-size="16" fill="${MUTED}">${esc(short(v))}</text>`);
  }
  const groupW = (right - left) / Math.max(1, input.months.length);
  const n = input.series.length;
  const barW = Math.min(64, (groupW * 0.7) / n);
  input.months.forEach((m, i) => {
    const gx = left + i * groupW + (groupW - barW * n - 2 * (n - 1)) / 2;
    input.series.forEach((s, j) => {
      const v = s.values[i] ?? 0;
      const x = gx + j * (barW + 2);
      const h = Math.max(0, bottom - y(v));
      if (h > 0) parts.push(`<path d="M${x},${bottom} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${barW - 8} q4,0 4,4 v${Math.max(0, h - 4)} z" fill="${SERIES[j % SERIES.length]}"/>`);
      // Valor em cima só com uma série (com várias, a legenda e o eixo bastam).
      if (n === 1 && v > 0) parts.push(`<text x="${x + barW / 2}" y="${y(v) - 8}" text-anchor="middle" font-family="${FONT}" font-size="15" fill="${INK}">${esc(short(v))}</text>`);
    });
    parts.push(`<text x="${left + i * groupW + groupW / 2}" y="${bottom + 28}" text-anchor="middle" font-family="${FONT}" font-size="17" fill="${MUTED}">${esc(m)}</text>`);
  });
  parts.push(`<line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" stroke="#94a3b8" stroke-width="1.5"/>`);
  if (n > 1) {
    let lx = 48;
    input.series.forEach((s, j) => {
      parts.push(`<rect x="${lx}" y="124" width="18" height="18" rx="4" fill="${SERIES[j % SERIES.length]}"/>`);
      parts.push(`<text x="${lx + 26}" y="139" font-family="${FONT}" font-size="18" fill="${INK}">${esc(trunc(s.name, 24))}</text>`);
      lx += 26 + Math.min(24, s.name.length) * 11 + 34;
    });
  }
  return frame(input.title, input.subtitle, parts.join("\n"));
}

/** Barras horizontais por categoria (as maiores primeiro), com valor e % do total. */
export function categoryBarsSvg(input: { title: string; subtitle: string; items: Array<{ name: string; cents: number }> }): string {
  const items = input.items.slice(0, 9);
  const total = input.items.reduce((s, i) => s + i.cents, 0) || 1;
  const left = 300;
  const right = W - 230;
  const top = 150;
  const rowH = 62;
  const more = input.items.length > items.length;
  const height = Math.max(420, top + items.length * rowH + (more ? 90 : 60));
  const max = Math.max(1, ...items.map((i) => i.cents));
  const parts: string[] = [];
  items.forEach((it, i) => {
    const yy = top + i * rowH;
    const w = Math.max(6, (it.cents / max) * (right - left));
    parts.push(`<text x="${left - 16}" y="${yy + rowH / 2 + 6}" text-anchor="end" font-family="${FONT}" font-size="19" fill="${INK}">${esc(trunc(it.name, 22))}</text>`);
    parts.push(`<rect x="${left}" y="${yy + rowH * 0.2}" width="${w}" height="${rowH * 0.6}" rx="4" fill="${SERIES[0]}"/>`);
    parts.push(`<text x="${left + w + 12}" y="${yy + rowH / 2 + 6}" font-family="${FONT}" font-size="18" fill="${INK}">${esc(formatBRL(it.cents))} · ${Math.round((it.cents / total) * 100)}%</text>`);
  });
  if (input.items.length > items.length) {
    parts.push(`<text x="48" y="${height - 52}" font-family="${FONT}" font-size="16" fill="${MUTED}">+ ${input.items.length - items.length} categorias menores</text>`);
  }
  return frame(input.title, input.subtitle, parts.join("\n"), height);
}

function niceStep(max: number): number {
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export async function svgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}
