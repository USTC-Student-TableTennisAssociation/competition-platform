import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

export type CertificatePdfData = Readonly<{
  matchTitle: string;
  email: string;
  fullName: string;
  studentId: string;
  certificateNo: string;
}>;

type RenderOptions = Readonly<{
  fontPath?: string;
  /** The PDF generation date, not a competition or original issuance date. */
  generatedAt?: Date;
  /** Only used by the local preview script, never by the issuing route. */
  preview?: boolean;
}>;

const ORGANIZATION = "中国科学技术大学学生乒乓球协会";
const RED = "#B32624";
const INK = "#151515";

let wordmarkPaths: string[] | undefined;

function drawAssociationHeader(doc: PDFKit.PDFDocument, left: number, width: number) {
  // Preserve the association's original lettering as vector paths, recoloured
  // for the red document header. This trusted SVG contains only paths.
  wordmarkPaths ??= Array.from(
    readFileSync(path.join(process.cwd(), "public/SVG/tta-wordmark.svg"), "utf8")
      .matchAll(/<path\b[^>]*\bd="([^"]+)"/g),
    (match) => match[1],
  );
  if (wordmarkPaths.length === 0) throw new Error("Certificate wordmark has no paths.");
  const wordmarkWidth = Math.min(390, width);
  doc.save().translate(left + (width - wordmarkWidth) / 2, 104).scale(wordmarkWidth / 889.91);
  for (const drawing of wordmarkPaths) doc.path(drawing).fill(RED);
  doc.restore();
}

function normalized(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function textBox(
  doc: PDFKit.PDFDocument,
  value: string,
  box: { x: number; y: number; width: number; height: number },
  style: {
    size: number;
    minSize?: number;
    align?: "left" | "center" | "right";
    color?: string;
    indent?: number;
    lineGap?: number;
  },
) {
  const text = normalized(value);
  const options: PDFKit.Mixins.TextOptions = {
    width: box.width,
    align: style.align ?? "left",
    characterSpacing: 0,
    lineGap: style.lineGap ?? 3,
    indent: style.indent ?? 0,
    paragraphGap: 0,
  };
  let size = style.size;
  let height = doc.fontSize(size).heightOfString(text, options);
  while (height > box.height && size > (style.minSize ?? size)) {
    size = Math.max(style.minSize ?? size, size - 0.5);
    height = doc.fontSize(size).heightOfString(text, options);
  }
  // Never silently truncate identity or competition information.
  if (height > box.height) throw new Error("Certificate text exceeds its printable area.");
  doc.fillColor(style.color ?? INK).text(text, box.x, box.y, options);
  return box.y + height;
}

/** A Chinese document-style certificate; rendering has no business-data side effects. */
export async function buildCertificatePdf(
  data: CertificatePdfData,
  options: RenderOptions = {},
): Promise<Buffer> {
  // Bundle the open-source Song typeface so previews and the Linux deployment
  // use identical typography. A specific serif font can still be configured.
  const fontPath = options.fontPath ?? process.env.CERTIFICATE_SERIF_FONT_PATH
    ?? "assets/fonts/NotoSerifSC-Regular.otf";
  const resolvedFontPath = path.resolve(process.cwd(), fontPath);
  if (!existsSync(resolvedFontPath)) {
    throw new Error(`Certificate font not found: ${resolvedFontPath}`);
  }
  const generatedAt = options.generatedAt ?? new Date();
  const dateLabel = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric",
  }).format(generatedAt);

  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    font: resolvedFontPath,
    info: {
      Title: `${data.matchTitle} - 参赛证明`,
      Author: ORGANIZATION,
      Subject: `参赛证明 ${data.certificateNo}`,
      Creator: "USTC TTA",
      CreationDate: generatedAt,
    },
  });
  doc.registerFont("body", resolvedFontPath);
  doc.registerFont("heading", path.join(process.cwd(), "assets/fonts/TTACertificateHeading-Bold.otf"));
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const left = 79.4;
      const contentWidth = doc.page.width - left - 73.7;
      drawAssociationHeader(doc, left, contentWidth);
      doc.font("body");
      textBox(doc, `证明编号：${data.certificateNo}`, { x: left, y: 163, width: contentWidth, height: 22 },
        { size: 10, minSize: 8, align: "center" });
      doc.moveTo(left, 191).lineTo(left + contentWidth, 191).lineWidth(1).stroke(RED);

      doc.font("heading");
      textBox(doc, "参赛证明", { x: left, y: 232, width: contentWidth, height: 45 },
        { size: 22, align: "center" });
      doc.font("body");

      const statement = `兹证明，${normalized(data.fullName)}同学（学号：${normalized(data.studentId)}）参加了“${normalized(data.matchTitle)}”比赛。`;
      const bodyEnd = textBox(doc, statement, { x: left, y: 307, width: contentWidth, height: 205 },
        { size: 16, minSize: 12, indent: 32, lineGap: 8 });
      const closingEnd = textBox(doc, "特此证明。", { x: left, y: bodyEnd + 20, width: contentWidth, height: 32 },
        { size: 16, indent: 32, lineGap: 8 });

      const signatureY = Math.max(493, closingEnd + 58);
      textBox(doc, ORGANIZATION, { x: left, y: signatureY, width: contentWidth, height: 28 },
        { size: 14, align: "right" });
      textBox(doc, `生成日期：${dateLabel}`, { x: left, y: signatureY + 32, width: contentWidth, height: 26 },
        { size: 12, align: "right" });

      textBox(doc, `账号邮箱：${data.email}`, { x: left, y: 695, width: contentWidth, height: 80 },
        { size: 10, minSize: 8, color: "#555555" });
      if (options.preview) {
        textBox(doc, "样张，仅用于排版预览", { x: left, y: 789, width: contentWidth, height: 18 },
          { size: 8, color: "#777777" });
      }
      doc.end();
    } catch (error) {
      reject(error);
      doc.end();
    }
  });
}
