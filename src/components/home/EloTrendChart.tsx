"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
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
};

export default function EloTrendChart({ points }: Props) {
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
      <div className="grid h-full place-items-center text-xs text-slate-400">
        暂无曲线数据
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={chartData}
        margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
      >
        <CartesianGrid stroke="rgba(148,163,184,0.2)" strokeDasharray="3 3" />
        <XAxis
          dataKey="index"
          type="number"
          tick={{ fill: "rgb(148 163 184)", fontSize: 10 }}
          axisLine={{ stroke: "rgba(148,163,184,0.35)" }}
          tickLine={{ stroke: "rgba(148,163,184,0.35)" }}
          domain={[0, Math.max(chartData.length - 1, 0)]}
          allowDecimals={false}
          tickFormatter={(value: number) => chartData[value]?.dateLabel ?? ""}
          minTickGap={18}
          interval="preserveStartEnd"
        />
        <YAxis
          width={40}
          tick={{ fill: "rgb(148 163 184)", fontSize: 10 }}
          axisLine={{ stroke: "rgba(148,163,184,0.35)" }}
          tickLine={{ stroke: "rgba(148,163,184,0.35)" }}
          tickFormatter={(value: number) => `${value}`}
          domain={[
            (dataMin: number) => Math.floor((dataMin - 10) / 10) * 10,
            (dataMax: number) => Math.ceil((dataMax + 10) / 10) * 10,
          ]}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "rgb(15 23 42)",
            border: "1px solid rgb(51 65 85)",
            borderRadius: "0.75rem",
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
          labelFormatter={(value, payload) => {
            const point = payload?.[0]?.payload as ChartPoint | undefined;
            if (!point) return "";
            return `日期：${point.dateLabel}`;
          }}
          formatter={(value: number | undefined) => [`${value ?? "-"}`, "ELO"]}
        />
        <Line
          type="monotone"
          dataKey="elo"
          name="ELO"
          stroke="rgb(34,211,238)"
          strokeWidth={3}
          dot={{ r: 2, fill: "rgb(34,211,238)" }}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
