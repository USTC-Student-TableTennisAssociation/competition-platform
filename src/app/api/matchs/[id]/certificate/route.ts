import { getCurrentUser } from "@/lib/auth";
import {
normalizeIdentityInput
} from "@/lib/certificate";
import { validateCsrfToken } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import {
createV2CertificateApplicationService,
V2CertificateApplicationError,
} from "@/modules/competitions-v2/application/certificates";
import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

export const runtime = "nodejs";

function v2CertificateErrorResponse(error: V2CertificateApplicationError) {
  if (error.code === "MATCH_NOT_FOUND") {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error.code === "ACTOR_NOT_ACTIVE") {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (
    error.code === "INVALID_INPUT" ||
    error.code === "NOT_ELIGIBLE" ||
    error.code === "IDENTITY_MISMATCH"
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (
    error.code === "UNSUPPORTED_MATCH" ||
    error.code === "CONCURRENT_WRITE_CONFLICT"
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error.code === "INTEGRITY_ERROR") {
    console.error("v2-certificate-integrity-failed", error.details);
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return NextResponse.json({ error: error.message }, { status: 500 });
}

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

    const matchDiscriminator = await prisma.match.findUnique({
      where: { id },
      select: { id: true, engineVersion: true },
    });
    if (!matchDiscriminator) {
      return NextResponse.json({ error: "比赛不存在或已删除。" }, { status: 404 });
    }

    if (matchDiscriminator.engineVersion === "V2") {
      let issued;
      try {
        issued = await createV2CertificateApplicationService({ db: prisma }).issue({
          matchId: id,
          actorId: currentUser.id,
          fullName: rawName,
          studentId: rawStudentId,
        });
      } catch (error) {
        if (error instanceof V2CertificateApplicationError) {
          return v2CertificateErrorResponse(error);
        }
        throw error;
      }

      // The durable number is committed before rendering. A font/PDF failure
      // therefore retains the same retry behavior as the legacy branch.
      const pdfBuffer = await buildPdfBuffer({
        matchTitle: issued.matchTitle,
        email: issued.email,
        fullName: rawName,
        studentId: rawStudentId,
        certificateNo: issued.certificateNo,
      });
      const filename = `participation-certificate-${issued.certificateNo}.pdf`;
      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Certificate-Number": issued.certificateNo,
        },
      });
    }

    return NextResponse.json({ error: "历史比赛已归档，不再提供证明签发。" }, { status: 410 });
  } catch (error) {
    console.error("certificate-export-failed", error);
    return NextResponse.json(
      { error: "参赛证明生成失败，请联系管理员检查证书字体配置。" },
      { status: 500 },
    );
  }
}
