"use client";
"use no memo";

import * as React from "react";
import { DayPicker, type DayButtonProps } from "react-day-picker";
import { zhCN } from "date-fns/locale";
import { cn } from "@/lib/utils";

/* ---------- Override buttons so they don't submit forms ---------- */

function SafeDayButton({ day, modifiers, ...rest }: DayButtonProps) {
  return <button {...rest} type="button" />;
}

function SafeButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { type: _type, ...rest } = props;
  return <button {...rest} type="button" />;
}

/* ----------------------------------------------------------------- */

type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays
      locale={zhCN}
      className={cn("p-2", className)}
      components={{
        DayButton: SafeDayButton,
        Button: SafeButton,
      }}
      classNames={{
        /* v9 class‑name keys */
        months: "flex flex-col",
        month: "space-y-3",
        month_caption: "flex items-center justify-center pb-1 pt-1",
        caption_label: "text-sm font-semibold text-slate-100",
        nav: "flex items-center gap-1",
        button_previous:
          "h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer",
        button_next:
          "h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-9 text-[11px] font-medium text-slate-400 text-center",
        week: "mt-1 flex w-full",
        day: "relative h-9 w-9 p-0 text-center text-sm",
        day_button:
          "h-9 w-9 rounded-md text-slate-200 hover:bg-slate-700 cursor-pointer",
        selected:
          "bg-cyan-500 text-slate-950 hover:bg-cyan-400 hover:text-slate-950",
        today: "ring-1 ring-cyan-400/60",
        outside: "text-slate-600",
        disabled: "text-slate-600 opacity-50 cursor-default",
        ...classNames,
      }}
      {...props}
    />
  );
}
