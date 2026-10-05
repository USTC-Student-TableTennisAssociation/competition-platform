"use client";

import { useState } from "react";

import { defaultVenue, parseMatchVenues, VENUE_OPTIONS } from "@/lib/locations";

export default function MatchVenueSelect({
  id,
  initialLocation = defaultVenue(),
}: Readonly<{
  id: string;
  initialLocation?: string;
}>) {
  const [selected, setSelected] = useState(
    () => parseMatchVenues(initialLocation) ?? [defaultVenue()],
  );
  const empty = selected.length === 0;

  return (
    <fieldset aria-describedby={`${id}-hint`}>
      <legend className="mb-2 text-sm text-slate-300">比赛地点 *</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {VENUE_OPTIONS.map((venue, index) => {
          const checked = selected.includes(venue);
          return (
            <label
              key={venue}
              htmlFor={`${id}-${index}`}
              className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-teal-400 ${
                checked
                  ? "border-teal-500/60 bg-teal-500/10 text-teal-100"
                  : "border-slate-700 bg-slate-950/35 text-slate-300 hover:border-slate-500"
              }`}
            >
              <input
                id={`${id}-${index}`}
                type="checkbox"
                checked={checked}
                required={empty && index === 0}
                onChange={(event) => {
                  const nextChecked = event.target.checked;
                  setSelected((current) =>
                    VENUE_OPTIONS.filter((option) =>
                      option === venue ? nextChecked : current.includes(option),
                    ),
                  );
                }}
                className="h-4 w-4 shrink-0 accent-teal-500"
              />
              {venue}
            </label>
          );
        })}
      </div>
      <p
        id={`${id}-hint`}
        className={`mt-2 text-xs ${empty ? "text-rose-300" : "text-slate-400"}`}
      >
        {empty ? "请至少选择一个比赛地点。" : "可多选，至少选择一个地点。"}
      </p>
      <input type="hidden" name="location" value={selected.join("、")} />
    </fieldset>
  );
}
