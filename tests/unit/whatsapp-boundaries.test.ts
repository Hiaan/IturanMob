import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garante que as rotas do Next.js nunca importem o Baileys nem o código exclusivo do worker
 * (a comunicação é via banco + Redis).
 */
const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const WORKER_ONLY = ["src/server/whatsapp/connection-manager.ts", "src/server/whatsapp/providers.ts", "src/server/whatsapp/baileys/"];

function listRoutes(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listRoutes(full);
    return name === "route.ts" ? [full] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Percorre os imports estáticos (ignora `import type` e imports dinâmicos). */
function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = [entry];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(re)) {
      const spec = m[1]!;
      const resolved = resolveImport(file, spec);
      if (resolved) stack.push(resolved);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
  }
  return { files, packages };
}

describe("WhatsApp: fronteira API × worker", () => {
  const routes = [...listRoutes(path.join(SRC, "app/api/v1/integrations/whatsapp")), ...listRoutes(path.join(SRC, "app/api/webhooks/whatsapp"))];

  it("existem rotas da integração e o grafo de imports é percorrido", () => {
    expect(routes.length).toBeGreaterThanOrEqual(13);
    const main = routes.find((r) => r.endsWith(path.join("integrations", "whatsapp", "route.ts")))!;
    const { files, packages } = staticGraph(main);
    const rel = [...files].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(rel).toContain("src/server/whatsapp/service.ts");
    expect(rel).toContain("src/server/whatsapp/ingest.ts");
    expect(packages.has("bullmq")).toBe(true);
    // o próprio worker, por outro lado, alcança o Baileys (import dinâmico na fábrica de provedores)
    expect(readFileSync(path.join(SRC, "server/whatsapp/providers.ts"), "utf8")).toContain('import("./baileys/provider")');
  });

  it.each(routes.map((r) => [path.relative(ROOT, r), r]))("%s não importa baileys nem módulos do worker", (_label, route) => {
    const { files, packages } = staticGraph(route as string);
    expect(packages.has("baileys")).toBe(false);
    const rel = [...files].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    for (const forbidden of WORKER_ONLY) expect(rel.some((f) => f.startsWith(forbidden))).toBe(false);
  });
});
