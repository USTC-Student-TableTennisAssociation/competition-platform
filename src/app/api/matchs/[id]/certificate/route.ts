import { NextResponse } from "next/server";
import PDFDocument from "pdfkit";
import { Prisma } from "@prisma/client";
import { existsSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { validateCsrfToken } from "@/lib/csrf";
import {
  evaluateCertificateEligibility,
  generateCertificateNumber,
  hashIdentityValue,
  normalizeIdentityInput,
  verifyIdentityValue,
} from "@/lib/certificate";

export const runtime = "nodejs";

function buildPdfBuffer(params: {
  matchTitle: string;
  email: string;
  fullName: string;
  studentId: string;
  certificateNo: string;
}) {
  const { matchTitle, email, fullName, studentId, certificateNo } = params;
  console.info("certificate-export-cwd", process.cwd());
  console.info(
    "certificate-export-font-config",
    process.env.CERTIFICATE_FONT_PATH ?? "(unset)",
  );

  const fontPath = process.env.CERTIFICATE_FONT_PATH;
  if (!fontPath) {
    throw new Error("CERTIFICATE_FONT_PATH is not set.");
  }

  const resolvedFontPath = path.isAbsolute(fontPath)
    ? fontPath
    : path.resolve(process.cwd(), fontPath);
  if (!existsSync(resolvedFontPath)) {
    throw new Error(`Certificate font not found: ${resolvedFontPath}`);
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    // Avoid default Helvetica lookup by using the custom font as default.
    font: resolvedFontPath,
  });
  const chunks: Buffer[] = [];

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  doc.font(resolvedFontPath);

  doc.fontSize(20).text("参赛证明", { align: "center" });
  doc.moveDown(1.5);

  doc.fontSize(12);
  doc.text(`比赛名称：${matchTitle}`);
  doc.moveDown(0.5);
  doc.text(`用户邮箱：${email}`);
  doc.moveDown(0.5);
  doc.text(`用户姓名：${fullName}`);
  doc.moveDown(0.5);
  doc.text(`用户学号：${studentId}`);
  doc.moveDown(0.5);
  doc.text(`证明编号：${certificateNo}`);

  doc.moveDown(2);
  doc.fontSize(10).fillColor("gray");
  doc.text("注：姓名与学号仅用于生成参赛证明，系统会以加密格式保存，无法在数据库中反查。", {
    align: "left",
  });

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const formData = await request.formData();
    const csrfError = await validateCsrfToken(formData);
    if (csrfError) {
      return NextResponse.json({ error: csrfError }, { status: 400 });
    }

    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ error: "请先登录后再导出证明。" }, { status: 401 });
    }

    const rawName = normalizeIdentityInput(String(formData.get("fullName") ?? ""));
    const rawStudentId = normalizeIdentityInput(
      String(formData.get("studentId") ?? ""),
    );

    if (!rawName) {
      return NextResponse.json({ error: "请输入姓名。" }, { status: 400 });
    }

    if (!rawStudentId) {
      return NextResponse.json({ error: "请输入学号。" }, { status: 400 });
    }

    if (rawName.length > 40) {
      return NextResponse.json({ error: "姓名长度不能超过 40 个字符。" }, { status: 400 });
    }

    if (rawStudentId.length > 32) {
      return NextResponse.json({ error: "学号长度不能超过 32 个字符。" }, { status: 400 });
    }

    const match = await prisma.match.findUnique({
      where: { id },
      include: {
        registrations: { select: { userId: true } },
        groupingResult: true,
        results: {
          select: {
            winnerTeamIds: true,
            loserTeamIds: true,
            confirmed: true,
            score: true,
            createdAt: true,
            resultVerifiedAt: true,
          },
        },
      },
    });

    if (!match) {
      return NextResponse.json({ error: "比赛不存在或已删除。" }, { status: 404 });
    }

    const isRegistered = match.registrations.some(
      (item) => item.userId === currentUser.id,
    );
    if (!isRegistered) {
      return NextResponse.json({ error: "你未报名本次比赛，无法导出证明。" }, { status: 403 });
    }

    const eligibility = evaluateCertificateEligibility({
      match: {
        status: match.status,
        type: match.type,
        groupingResult: match.groupingResult,
        groupingGeneratedAt: match.groupingGeneratedAt,
        registrations: match.registrations,
        results: match.results,
      },
      currentUserId: currentUser.id,
    });

    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: eligibility.reason ?? "暂不能导出参赛证明。" },
        { status: 400 },
      );
    }

    const identity = await prisma.userIdentity.findUnique({
      where: { userId: currentUser.id },
    });

    if (!identity) {
      await prisma.userIdentity.create({
        data: {
          userId: currentUser.id,
          nameHash: hashIdentityValue(rawName),
          studentIdHash: hashIdentityValue(rawStudentId),
        },
      });
    } else {
      const nameOk = verifyIdentityValue(rawName, identity.nameHash);
      const studentOk = verifyIdentityValue(rawStudentId, identity.studentIdHash);
      if (!nameOk || !studentOk) {
        return NextResponse.json(
          { error: "姓名或学号与已绑定信息不一致，请联系乒协干事。" },
          { status: 400 },
        );
      }
    }

    let certificate = await prisma.participationCertificate.findUnique({
      where: {
        matchId_userId: {
          matchId: match.id,
          userId: currentUser.id,
        },
      },
    });

    if (!certificate) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const certificateNo = generateCertificateNumber();
        try {
          certificate = await prisma.participationCertificate.create({
            data: {
              matchId: match.id,
              userId: currentUser.id,
              certificateNo,
            },
          });
          break;
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            continue;
          }
          throw error;
        }
      }
    }

    if (!certificate) {
      return NextResponse.json(
        { error: "生成证明编号失败，请稍后重试。" },
        { status: 500 },
      );
    }

    const pdfBuffer = await buildPdfBuffer({
      matchTitle: match.title,
      email: currentUser.email,
      fullName: rawName,
      studentId: rawStudentId,
      certificateNo: certificate.certificateNo,
    });

    const filename = `participation-certificate-${certificate.certificateNo}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Certificate-Number": certificate.certificateNo,
      },
    });
  } catch (error) {
    console.error("certificate-export-failed", error);
    return NextResponse.json(
      { error: "参赛证明生成失败，请联系管理员检查证书字体配置。" },
      { status: 500 },
    );
  }
}
