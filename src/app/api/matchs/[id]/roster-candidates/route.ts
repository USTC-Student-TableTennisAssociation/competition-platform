import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") return NextResponse.json({ error: "仅管理员可查询换人成员。" }, { status: 403 });
  const { id } = await params;
  const match = await prisma.match.findUnique({ where: { id }, select: { engineVersion: true, isQuickMatch: true, status: true } });
  if (!match || match.engineVersion !== "V2" || match.isQuickMatch || match.status === "finished") return NextResponse.json({ error: "当前比赛不允许换人。" }, { status: 409 });
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 100) ?? "";
  if (!query) return NextResponse.json({ users: [] });
  const users = await prisma.user.findMany({
    where: { isBanned: false, emailVerifiedAt: { not: null }, OR: [{ nickname: { contains: query, mode: "insensitive" } }, { email: { contains: query, mode: "insensitive" } }] },
    orderBy: [{ nickname: "asc" }, { id: "asc" }], take: 20,
    select: { id: true, nickname: true, email: true },
  });
  return NextResponse.json({ users }, { headers: { "Cache-Control": "private, no-store" } });
}
