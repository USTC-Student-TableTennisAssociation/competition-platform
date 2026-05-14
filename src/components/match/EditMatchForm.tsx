"use client";

import { useEffect, useState, useTransition } from "react";
import { updateMatchAction } from "@/app/matchs/actions";

type Props = {
  matchId: string;
  initial: {
    title: string;
    description: string;
    location: string;
    dateTimeIso: string;
    type: "single" | "double" | "team";
    format: "group_only" | "group_then_knockout";
    registrationDeadlineIso: string;
  };
};

// 简单的日期时间解析辅助函数
const parseIsoToLocal = (isoString: string) => {
  if (!isoString) return { date: "", time: "" };
  const dateObj = new Date(isoString);
  if (isNaN(dateObj.getTime())) return { date: "", time: "" };

  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
  const time = `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
  return { date, time };
};

export default function EditMatchForm({ matchId, initial }: Props) {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [csrfToken, setCsrfToken] = useState("");

  // 初始化状态
  const initStart = parseIsoToLocal(initial.dateTimeIso);
  const initEnd = parseIsoToLocal(initial.registrationDeadlineIso);

  // 表单状态管理
  const [formDataState, setFormDataState] = useState({
    title: initial.title,
    description: initial.description,
    location: initial.location,
    type: initial.type,
    format: initial.format,
    startDate: initStart.date,
    startTime: initStart.time,
    endDate: initEnd.date,
    endTime: initEnd.time || initStart.time,
  });

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    setFormDataState((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");

    // 1. 客户端校验
    const startDateTimeStr = `${formDataState.startDate}T${formDataState.startTime}`;
    let endDateTimeStr = "";
    if (formDataState.endDate && formDataState.endTime) {
      endDateTimeStr = `${formDataState.endDate}T${formDataState.endTime}`;
    }

    const start = new Date(startDateTimeStr);
    const end = endDateTimeStr ? new Date(endDateTimeStr) : null;

    if (isNaN(start.getTime())) {
      setErrorMessage("比赛开始时间无效");
      return;
    }

    if (end && isNaN(end.getTime())) {
      setErrorMessage("报名截止时间无效");
      return;
    }

    if (end && end >= start) {
      setErrorMessage("报名截止时间必须早于比赛开始时间");
      return;
    }

    // 2. 准备提交的数据
    const formData = new FormData();
    formData.append("title", formDataState.title);
    formData.append("description", formDataState.description);
    formData.append("location", formDataState.location);
    formData.append("type", formDataState.type);
    formData.append("format", formDataState.format);
    // 组合完整的 ISO 字符串或者本地时间字符串传给后端
    formData.append("matchDateTime", startDateTimeStr);
    formData.append("registrationDeadline", endDateTimeStr);

    // 传递时区偏移量（分钟），用于服务端校正
    formData.append("timezoneOffset", String(new Date().getTimezoneOffset()));

    formData.append("csrfToken", csrfToken);

    // 3. 执行 Server Action
    startTransition(async () => {
      try {
        const result = await updateMatchAction(matchId, formData);

        if (result.success) {
          setSuccessMessage("保存成功，正在跳转...");
          // 强制刷新跳转，避免 Next.js 路由缓存导致数据显示旧值
          window.location.href = `/matchs/${matchId}?updated=${Date.now()}`;
        } else {
          setErrorMessage(result.error || "保存失败");
        }
      } catch (error) {
        console.error(error);
        setErrorMessage("请求发生错误，请重试");
      }
    });
  };

  useEffect(() => {
    let isMounted = true;

    const fetchToken = async () => {
      try {
        const response = await fetch("/api/csrf-token", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { token?: string };
        if (isMounted) {
          setCsrfToken(payload.token ?? "");
        }
      } catch {
        // Ignore token fetch failures; server will still validate origin.
      }
    };

    void fetchToken();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <div>
        <label className="mb-1 block text-sm text-slate-300">比赛名称 *</label>
        <input
          name="title"
          value={formDataState.title}
          onChange={handleChange}
          required
          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-slate-300">比赛描述</label>
        <textarea
          name="description"
          rows={4}
          value={formDataState.description}
          onChange={handleChange}
          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
        />
      </div>

      {/* 时间设置区域 */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide text-cyan-200">
          时间设置
        </h2>
        <div className="grid gap-5 lg:grid-cols-2">
          {/* 开始时间 */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <p className="mb-3 text-sm font-medium text-slate-200">
              比赛开始时间 *
            </p>
            <div className="space-y-3">
              <input
                type="date"
                name="startDate"
                value={formDataState.startDate}
                onChange={handleChange}
                required
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
              <input
                type="time"
                name="startTime"
                value={formDataState.startTime}
                onChange={handleChange}
                required
                step={1800} // 30分钟步长
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
            </div>
          </div>

          {/* 截止时间 */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <p className="mb-3 text-sm font-medium text-slate-200">
              报名截止时间 *
            </p>
            <div className="space-y-3">
              <input
                type="date"
                name="endDate"
                value={formDataState.endDate}
                onChange={handleChange}
                max={formDataState.startDate} // 简单的约束
                required
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
              <input
                type="time"
                name="endTime"
                value={formDataState.endTime}
                onChange={handleChange}
                required
                step={1800}
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
            </div>
          </div>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm text-slate-300">地点 *</label>
        <input
          name="location"
          value={formDataState.location}
          onChange={handleChange}
          required
          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm text-slate-300">比赛类型</label>
          <select
            name="type"
            value={formDataState.type}
            onChange={handleChange}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
          >
            <option value="single">单打</option>
            <option value="double">双打</option>
            <option value="team">团体</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-300">赛制</label>
          <select
            name="format"
            value={formDataState.format}
            onChange={handleChange}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
          >
            <option value="group_only">分组比赛</option>
            <option value="group_then_knockout">前期分组后期淘汰</option>
          </select>
        </div>
      </div>

      {/* 错误和成功提示 */}
      {errorMessage && (
        <div className="rounded-md bg-rose-500/10 p-3 text-sm text-rose-300 border border-rose-500/20">
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-300 border border-emerald-500/20">
          {successMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 py-3 font-semibold text-white disabled:opacity-60 hover:opacity-90 transition-opacity"
      >
        {isPending ? "正在保存..." : "保存修改"}
      </button>
    </form>
  );
}
