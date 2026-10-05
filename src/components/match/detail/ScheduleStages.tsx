"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

type Stage = Readonly<{ id: string; label: string; content: ReactNode }>;

export default function ScheduleStages({
  stages,
  defaultId,
}: Readonly<{
  stages: readonly Stage[];
  defaultId: string;
}>) {
  const prefix = useId();
  const [selected, setSelected] = useState(defaultId);
  const activeId = stages.some((stage) => stage.id === selected)
    ? selected
    : defaultId;
  if (stages.length === 1) return stages[0].content;

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % stages.length
        : event.key === "ArrowLeft"
          ? (index - 1 + stages.length) % stages.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? stages.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setSelected(stages[next].id);
    document.getElementById(`${prefix}-tab-${stages[next].id}`)?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="赛程阶段"
        className="mb-5 flex w-fit gap-1 rounded-lg bg-white/5 p-1"
      >
        {stages.map((stage, index) => (
          <button
            key={stage.id}
            type="button"
            role="tab"
            id={`${prefix}-tab-${stage.id}`}
            aria-controls={`${prefix}-panel-${stage.id}`}
            aria-selected={activeId === stage.id}
            tabIndex={activeId === stage.id ? 0 : -1}
            onClick={() => setSelected(stage.id)}
            onKeyDown={(event) => navigate(event, index)}
            className={`min-h-10 rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-orange-300 ${activeId === stage.id ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            {stage.label}
          </button>
        ))}
      </div>
      {stages.map((stage) => (
        <div
          key={stage.id}
          role="tabpanel"
          hidden={activeId !== stage.id}
          id={`${prefix}-panel-${stage.id}`}
          aria-labelledby={`${prefix}-tab-${stage.id}`}
          tabIndex={0}
          className="focus-visible:outline-2 focus-visible:outline-orange-300"
        >
          {stage.content}
        </div>
      ))}
    </div>
  );
}
