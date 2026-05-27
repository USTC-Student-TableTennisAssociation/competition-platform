import { headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type AuditLogParams = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
};

export async function getAuditContext() {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || headerStore.get("x-real-ip") || null;
  const userAgent = headerStore.get("user-agent") || null;
  return { ip, userAgent };
}

export async function writeAuditLog({
  actorId,
  action,
  entityType,
  entityId,
  ip,
  userAgent,
  details,
}: AuditLogParams) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actorId ?? null,
        action,
        entityType,
        entityId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        details:
          details == null ? undefined : (details as Prisma.InputJsonObject),
      },
    });
  } catch (error) {
    console.error("writeAuditLog failed", error);
  }
}
