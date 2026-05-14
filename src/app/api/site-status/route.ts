import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { id: 1 },
      select: { isClosed: true },
    });

    return NextResponse.json({
      isClosed: setting?.isClosed ?? false,
    });
  } catch (error) {
    console.error("Site status fetch failed", error);
    return NextResponse.json({ isClosed: false });
  }
}
