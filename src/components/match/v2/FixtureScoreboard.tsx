import type { ReactNode } from "react";

export default function FixtureScoreboard({
  sideAName,
  sideBName,
  scoreA,
  scoreB,
  sideACaption,
  sideBCaption,
}: Readonly<{
  sideAName: string;
  sideBName: string;
  scoreA: ReactNode;
  scoreB: ReactNode;
  sideACaption?: ReactNode;
  sideBCaption?: ReactNode;
}>) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] gap-x-3 gap-y-4 py-6 sm:gap-x-6 sm:py-8">
      <p className="self-end break-words text-center text-sm font-semibold leading-6 text-slate-100 sm:text-base">
        {sideAName}
      </p>
      <span aria-hidden="true" />
      <p className="self-end break-words text-center text-sm font-semibold leading-6 text-slate-100 sm:text-base">
        {sideBName}
      </p>
      <div className="flex min-w-0 items-center justify-center text-5xl font-semibold tabular-nums text-white">
        {scoreA}
      </div>
      <span
        className="self-center text-center text-3xl font-light text-slate-600"
        aria-hidden="true"
      >
        :
      </span>
      <div className="flex min-w-0 items-center justify-center text-5xl font-semibold tabular-nums text-white">
        {scoreB}
      </div>
      {sideACaption || sideBCaption ? (
        <>
          <div className="text-center text-xs text-slate-400">
            {sideACaption}
          </div>
          <span aria-hidden="true" />
          <div className="text-center text-xs text-slate-400">
            {sideBCaption}
          </div>
        </>
      ) : null}
    </div>
  );
}
