// Local, synthetic previews only: this script never loads .env or a database.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
process.chdir(root);
execFileSync(process.execPath, [
  require.resolve("typescript/bin/tsc"),
  "src/lib/server/certificate-pdf.ts",
  "--outDir", ".v2-test-build/certificate-preview",
  "--module", "commonjs", "--target", "ES2020",
  "--esModuleInterop", "--skipLibCheck", "--strict", "--types", "node",
], { stdio: "inherit" });

const { buildCertificatePdf } = require("../.v2-test-build/certificate-preview/certificate-pdf.js");
const outputDir = path.resolve(process.argv[2] ?? "output/pdf");
await mkdir(outputDir, { recursive: true });
const sample = {
  matchTitle: "第十八届继往开来男子组",
  fullName: "张明",
  studentId: "PB26000001",
  email: "participant@example.com",
  certificateNo: "PPC-PREVIEW-20261022",
};
const options = { preview: true, generatedAt: new Date("2026-10-22T00:00:00+08:00") };
const output = path.join(outputDir, "participation-certificate-preview.pdf");
await writeFile(output, await buildCertificatePdf(sample, options));
console.log(`Preview: ${output}`);

if (process.argv.includes("--stress")) {
  const cases = [
    ["long-fields", {
      ...sample,
      matchTitle: "中国科学技术大学第十八届继往开来乒乓球比赛暨秋季校园体育文化交流赛混合团体公开组决赛阶段参赛证明排版测试",
      fullName: "测试长姓名".repeat(8), // Route limit: 40 characters.
      studentId: "PB" + "1234567890".repeat(3), // Route limit: 32 characters.
      email: "m".repeat(63) + "@" + Array(3).fill("w".repeat(62)).join(".") + ".a", // 254 wide characters.
    }],
    ["latin-name", {
      ...sample,
      fullName: "Alexandria Catherine Montgomery-Williams",
      matchTitle: "第十八届继往开来混合团体比赛（东区 / 西区）",
    }],
  ];
  for (const [name, data] of cases) {
    const file = path.join(outputDir, `${name}.pdf`);
    await writeFile(file, await buildCertificatePdf(data, options));
    console.log(`Boundary preview: ${file}`);
  }
}
