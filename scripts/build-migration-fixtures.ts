/**
 * Gera as planilhas de teste da migração em tests/fixtures/migration (.xlsx) e, quando o
 * LibreOffice está instalado, as versões .xls, .ods e .csv da lista simples e .ods das abas
 * mensais (para testar os leitores de cada formato).
 *
 *   npx tsx --tsconfig tsconfig.json scripts/build-migration-fixtures.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES } from "../tests/fixtures/migration/build";

const dir = path.resolve("tests/fixtures/migration");

async function main() {
  for (const [name, build] of Object.entries(FIXTURES)) {
    writeFileSync(path.join(dir, `${name}.xlsx`), await build());
    console.log(`ok ${name}.xlsx`);
  }
  // CSV como os bancos brasileiros exportam: ";" e vírgula decimal.
  writeFileSync(
    path.join(dir, "lista-simples.csv"),
    [
      "Data;Descrição;Valor;Categoria",
      "05/01/2025;Supermercado Pão de Açúcar;-320,45;Supermercado",
      "06/01/2025;Salário;5.200,00;Salário",
      "08/01/2025;Posto Shell;-180,00;Combustível",
      "10/01/2025;Drogaria São Paulo;-64,90;Farmácia",
      "12/01/2025;Restaurante Outback;-210,30;Restaurante",
      "15/01/2025;Uber;-23,50;Transporte",
      "20/01/2025;Conta de luz;-189,77;Luz",
      "02/02/2025;Supermercado Extra;-280,00;Supermercado",
      "05/02/2025;Salário;5.200,00;Salário",
      "09/02/2025;Netflix;-55,90;Assinaturas",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const convert = (file: string, to: string) => {
    try {
      execFileSync("soffice", ["--headless", "--convert-to", to, "--outdir", dir, path.join(dir, file)], { stdio: "ignore", timeout: 180_000 });
      console.log(`ok ${file} → ${to}`);
    } catch {
      console.warn(`LibreOffice indisponível: ${file} → ${to} não gerado`);
    }
  };
  convert("lista-simples.xlsx", "xls");
  convert("lista-simples.xlsx", "ods");
  convert("abas-mensais.xlsx", "ods");
  convert("planilha-baguncada.xlsx", "xls");
}

void main();
