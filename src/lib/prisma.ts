import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });

// Separate Next.js server bundles can evaluate this module in the same process.
// Reuse one connection pool in production as well as during development reloads.
global.prisma = prisma;
