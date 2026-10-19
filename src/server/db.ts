import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createClient() {
  return new PrismaClient({
    log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

/** Cliente Prisma único por processo. */
export const prisma: PrismaClient = globalForPrisma.__prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = prisma;

/** Cliente transacional (dentro de prisma.$transaction) ou o cliente padrão. */
export type Db = Prisma.TransactionClient | PrismaClient;

/** Executa em transação serializável com novas tentativas em conflitos de serialização. */
export async function withTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { retries?: number; timeout?: number }): Promise<T> {
  const retries = opts?.retries ?? 3;
  let attempt = 0;
  for (;;) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: opts?.timeout ?? 30_000,
      });
    } catch (err) {
      attempt++;
      const code = (err as { code?: string }).code;
      if (attempt <= retries && (code === "P2034" || code === "40001")) continue;
      throw err;
    }
  }
}

export { Prisma };
