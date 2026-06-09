import { NextResponse } from "next/server";
import { TeamRegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

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

  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      teamRegistrations: {
        where: {
          status: {
            not: TeamRegistrationStatus.cancelled,
          },
        },
        include: {
          captain: {
            select: {
              nickname: true,
            },
          },
          members: {
            include: {
              user: {
                select: {
                  nickname: true,
                },
              },
            },
            orderBy: { joinedAt: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!match) {
    return NextResponse.json({ error: "比赛不存在。" }, { status: 404 });
  }

  if (match.type !== "team") {
    return NextResponse.json({ error: "该比赛不是团体赛。" }, { status: 400 });
  }

  const headers = [
    "比赛名",
    "队名",
    "状态",
    "队长",
    "联系方式",
    "队员列表",
    "人数",
    "备注",
    "审核备注",
  ];

  const minMembers = match.teamMinMembers ?? 3;
  const rows = match.teamRegistrations.map((team) => {
    const members = team.members
      .map((member) => member.user.nickname)
      .join("；");
    return [
      match.title,
      team.name,
      team.members.length >= minMembers ? "已成队" : "组建中",
      team.captain.nickname,
      team.contact ?? "",
      members,
      team.members.length,
      team.remark ?? "",
      team.reviewNote ?? "",
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  return new NextResponse(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="team-registrations-${id}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
