"use client";

import { useId, useMemo } from "react";
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
};

export default function EloTrendChart({ points, compact = false }: Props) {
  const rawId = useId();
  const gradientId = `elo-gradient-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const chartData = useMemo<ChartPoint[]>(
    () =>
      points.map((point, index) => ({
        index,
        elo: point.elo,
        dateLabel: new Date(point.createdAt).toLocaleDateString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
        }),
      })),
    [points],
  );

  if (chartData.length === 0) {
    return (
      <div className="grid h-full place-items-center text-xs text-slate-500">
        暂无曲线数据
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
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
          />
        ) : null}

        {!compact ? (
          <XAxis
            dataKey="index"
            type="number"
            tick={{ fill: "rgb(148 163 184)", fontSize: 10 }}
            axisLine={{ stroke: "rgba(148,163,184,0.28)" }}
            tickLine={{ stroke: "rgba(148,163,184,0.28)" }}
            domain={[0, Math.max(chartData.length - 1, 0)]}
            allowDecimals={false}
            tickFormatter={(value: number) => chartData[value]?.dateLabel ?? ""}
            minTickGap={18}
            interval="preserveStartEnd"
          />
        ) : null}

        {!compact ? (
          <YAxis
            width={40}
            tick={{ fill: "rgb(148 163 184)", fontSize: 10 }}
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
            fontSize: "11px",
            padding: "6px 8px",
            maxWidth: "180px",
          }}
          labelStyle={{
            color: "rgb(148 163 184)",
            fontSize: "10px",
            marginBottom: "2px",
          }}
          itemStyle={{
            color: "rgb(226 232 240)",
            fontSize: "11px",
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
          dot={compact ? false : { r: 2, fill: "rgb(34,211,238)" }}
          activeDot={{ r: compact ? 3 : 4 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
