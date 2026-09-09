import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  TEAM_REGISTRATION_CSV_HEADERS,
  mapV2TeamRegistrationCsvRows,
} from "@/modules/competitions-v2/adapters/team-registration-csv";
import {
  V2TeamRegistrationIntegrityError,
  getV2TeamRegistrationReadState,
} from "@/modules/competitions-v2/read-model/team-registration";

export const runtime = "nodejs";

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const currentUser = await getCurrentUser();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可导出团体报名名单。" }, { status: 403 });
  }

  const discriminator = await prisma.match.findUnique({
    where: { id },
    select: { id: true, type: true, engineVersion: true },
  });

  if (!discriminator) {
    return NextResponse.json({ error: "比赛不存在。" }, { status: 404 });
  }

  if (discriminator.type !== "team") {
    return NextResponse.json({ error: "该比赛不是团体赛。" }, { status: 400 });
  }

  if (discriminator.engineVersion === "V2") {
    try {
      const state = await getV2TeamRegistrationReadState(prisma, id);
      if (state.kind !== "TEAM_V2_REGISTRATION") {
        return NextResponse.json(
          { error: "该 V2 团体赛当前不支持导出报名名单。" },
          { status: 409 },
        );
      }
      return csvResponse(id, [
        TEAM_REGISTRATION_CSV_HEADERS,
        ...mapV2TeamRegistrationCsvRows(state),
      ]);
    } catch (error) {
      if (error instanceof V2TeamRegistrationIntegrityError) {
        console.error("[V2_TEAM_REGISTRATION_EXPORT_INTEGRITY]", {
          matchId: id,
          entityId: error.entityId,
        });
        return NextResponse.json(
          { error: "V2 团体报名数据异常，暂不能导出，请联系管理员。" },
          { status: 409 },
        );
      }
      throw error;
    }
  }

  return NextResponse.json({ error: "历史比赛已归档，不再提供报名名单导出。" }, { status: 410 });
}

function csvResponse(
  matchId: string,
  rows: readonly (readonly unknown[])[],
) {
  const csv = rows
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  return new NextResponse(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="team-registrations-${matchId}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
