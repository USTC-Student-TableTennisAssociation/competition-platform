"use client";

import { useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type EloTrendPoint = {
  elo: number;
  createdAt: string;
};

type ChartPoint = {
  index: number;
  elo: number;
  dateLabel: string;
};

type Props = {
  points: EloTrendPoint[];
  compact?: boolean;
  readable?: boolean;
  responsiveCompact?: boolean;
};

export default function EloTrendChart({ points, compact: forceCompact = false, readable = false, responsiveCompact = false }: Props) {
  const [narrow, setNarrow] = useState(false);
  const compact = forceCompact || (responsiveCompact && narrow);
  const rawId = useId();
  const gradientId = `elo-gradient-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const chartData = useMemo<ChartPoint[]>(
    () =>
      points.map((point, index) => ({
        index,
        elo: point.elo,
        dateLabel: new Date(point.createdAt).toLocaleDateString("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "2-digit",
          day: "2-digit",
        }),
      })),
    [points],
  );

  if (chartData.length === 0) {
    return (
      <div className={readable ? "grid h-full place-items-center rounded-xl bg-white/[0.025] px-5 text-center text-base text-slate-400" : "grid h-full place-items-center text-xs text-slate-500"}>
        {responsiveCompact ? "暂无 ELO 记录" : readable ? "完成比赛后，这里会记录你的 ELO 变化。" : "暂无曲线数据"}
      </div>
    );
  }

  return (
    <ResponsiveContainer
      width="100%" height="100%" minWidth={1} minHeight={1}
      onResize={responsiveCompact ? (width) => setNarrow(width < 260) : undefined}
    >
      <AreaChart
        data={chartData}
        margin={
          compact
            ? { top: 4, right: 2, left: 2, bottom: 2 }
            : { top: 8, right: 8, left: 0, bottom: 4 }
        }
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(34,211,238)" stopOpacity={0.22} />
            <stop offset="55%" stopColor="rgb(34,211,238)" stopOpacity={0.08} />
            <stop offset="100%" stopColor="rgb(34,211,238)" stopOpacity={0} />
          </linearGradient>
        </defs>

        {!compact ? (
          <CartesianGrid
            stroke="rgba(148,163,184,0.16)"
            strokeDasharray="3 3"
            vertical={!readable}
          />
        ) : null}

        {!compact ? (
          <XAxis
            dataKey="index"
            type="number"
            tick={{ fill: "rgb(174 184 201)", fontSize: readable ? 14 : 10 }}
            axisLine={{ stroke: "rgba(148,163,184,0.28)" }}
            tickLine={{ stroke: "rgba(148,163,184,0.28)" }}
            domain={[0, Math.max(chartData.length - 1, 0)]}
            allowDecimals={false}
            tickFormatter={(value: number) => chartData[value]?.dateLabel ?? ""}
            minTickGap={readable ? 42 : 18}
            interval="preserveStartEnd"
          />
        ) : null}

        {!compact ? (
          <YAxis
            width={readable ? 52 : 40}
            tick={{ fill: "rgb(174 184 201)", fontSize: readable ? 14 : 10 }}
            tickCount={readable ? 4 : undefined}
            axisLine={{ stroke: "rgba(148,163,184,0.28)" }}
            tickLine={{ stroke: "rgba(148,163,184,0.28)" }}
            tickFormatter={(value: number) => `${value}`}
            domain={[
              (dataMin: number) => Math.floor((dataMin - 10) / 10) * 10,
              (dataMax: number) => Math.ceil((dataMax + 10) / 10) * 10,
            ]}
          />
        ) : (
          <YAxis
            hide
            domain={[
              (dataMin: number) => dataMin - 6,
              (dataMax: number) => dataMax + 6,
            ]}
          />
        )}

        <Tooltip
          cursor={{
            stroke: "rgba(148,163,184,0.22)",
            strokeWidth: 1,
          }}
          contentStyle={{
            backgroundColor: "rgb(15 23 42)",
            border: "1px solid rgb(51 65 85)",
            borderRadius: "0.6rem",
            color: "rgb(226 232 240)",
            fontSize: readable ? "14px" : "11px",
            padding: "6px 8px",
            maxWidth: "180px",
          }}
          labelStyle={{
            color: "rgb(148 163 184)",
            fontSize: readable ? "14px" : "10px",
            marginBottom: "2px",
          }}
          itemStyle={{
            color: "rgb(226 232 240)",
            fontSize: readable ? "14px" : "11px",
            padding: 0,
            margin: 0,
          }}
          wrapperStyle={{ zIndex: 20 }}
          labelFormatter={(_, payload) => {
            const point = payload?.[0]?.payload as ChartPoint | undefined;
            if (!point) return "";
            return `日期：${point.dateLabel}`;
          }}
          formatter={(value: number | undefined) => [`${value ?? "-"}`, "ELO"]}
        />

        <Area
          type="monotone"
          dataKey="elo"
          name="ELO"
          stroke="rgb(34,211,238)"
          strokeWidth={compact ? 2.25 : 2.75}
          fill={`url(#${gradientId})`}
          dot={compact && chartData.length > 1 ? false : { r: 2, fill: "rgb(34,211,238)" }}
          activeDot={{ r: compact ? 3 : 4 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
