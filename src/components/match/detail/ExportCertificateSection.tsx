"use client";

import { useState, type FormEvent } from "react";
import type { CertificateEligibility } from "@/lib/certificate";

type Props = {
  matchId: string;
  matchTitle: string;
  currentUserEmail: string;
  identityBound: boolean;
  eligibility: CertificateEligibility;
  existingCertificateNo: string | null;
};

function extractFilename(contentDisposition: string | null) {
  if (!contentDisposition) return null;
  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : null;
}

function sanitizeFilenamePart(value: string) {
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, "-").trim();
  return cleaned || "match";
}

export default function ExportCertificateSection({
  matchId,
  matchTitle,
  currentUserEmail,
  identityBound,
  eligibility,
  existingCertificateNo,
}: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [certificateNo, setCertificateNo] = useState<string | null>(
    existingCertificateNo,
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!eligibility.eligible) {
      setError(eligibility.reason ?? "暂不能导出参赛证明。");
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);

    try {
      setPending(true);
      const response = await fetch(`/api/matchs/${matchId}/certificate`, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(payload?.error ?? "导出失败，请稍后重试。");
        return;
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get("content-disposition");
      const filename =
        extractFilename(contentDisposition) ||
        `participation-certificate-${sanitizeFilenamePart(matchTitle)}.pdf`;
      const headerCertificateNo = response.headers.get("x-certificate-number");

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);

      if (headerCertificateNo) {
        setCertificateNo(headerCertificateNo);
      }

      setSuccess("参赛证明已生成并开始下载。");
      form.reset();
    } catch {
      setError("导出失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-white sm:text-xl">
          参赛证明导出
        </h2>
        {certificateNo ? (
          <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-100">
            证明编号：{certificateNo}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-sm text-slate-300">
        证明内容包含比赛名称、账号邮箱、姓名、学号及证明编号。姓名与学号会以加密格式保存，数据库无法反查。
      </p>
      <p className="mt-1 text-xs text-amber-300">
        姓名/学号只允许绑定一次，如有错误请联系乒协干事处理。
      </p>

      {!eligibility.eligible ? (
        <div className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {eligibility.reason ?? "暂不能导出参赛证明。"}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <input type="hidden" name="csrfToken" defaultValue="" />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-slate-300">
            姓名
            <input
              type="text"
              name="fullName"
              required
              disabled={pending}
              placeholder={
                identityBound ? "已绑定姓名（请确认输入一致）" : "请输入姓名"
              }
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            />
          </label>
          <label className="block text-sm text-slate-300">
            学号
            <input
              type="text"
              name="studentId"
              required
              disabled={pending}
              placeholder={
                identityBound ? "已绑定学号（请确认输入一致）" : "请输入学号"
              }
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            />
          </label>
        </div>

        <div className="text-xs text-slate-400">
          当前账号邮箱：{currentUserEmail}
        </div>

        {error ? <p className="text-sm text-rose-300">{error}</p> : null}
        {success ? <p className="text-sm text-emerald-300">{success}</p> : null}

        <button
          type="submit"
          disabled={pending || !eligibility.eligible}
          className="inline-flex items-center rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60"
        >
          {pending ? "生成中..." : "导出参赛证明 PDF"}
        </button>
      </form>
    </section>
  );
}
