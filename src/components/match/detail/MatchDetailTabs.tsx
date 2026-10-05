"use client";

import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  useTransition,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

const readHash = () => window.location.hash.slice(1);
const serverHash = () => "";

export type MatchDetailTab = Readonly<{
  id: string;
  label: string;
  count?: number;
  attention?: boolean;
  content: ReactNode;
}>;

export default function MatchDetailTabs({
  tabs,
  defaultId,
  live = false,
  awaitingConfirmation = false,
}: Readonly<{
  tabs: readonly MatchDetailTab[];
  defaultId: string;
  live?: boolean;
  awaitingConfirmation?: boolean;
}>) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const prefix = useId();
  const [selected, setSelected] = useState(defaultId);
  const linked = useSyncExternalStore(subscribeToHash, readHash, serverHash);
  const activeId = tabs.some((tab) => tab.id === linked)
    ? linked
    : tabs.some((tab) => tab.id === selected)
      ? selected
      : defaultId;

  useEffect(() => {
    if (!live) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && !refreshing)
        startRefresh(() => router.refresh());
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [live, refreshing, router]);

  function selectTab(id: string) {
    setSelected(id);
    window.history.replaceState(window.history.state, "", `#${id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next].id);
    document.getElementById(`${prefix}-tab-${tabs[next].id}`)?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="比赛详情"
        className="flex flex-wrap gap-x-4 border-b border-white/10 sm:gap-x-6"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${prefix}-tab-${tab.id}`}
            aria-controls={`${prefix}-panel-${tab.id}`}
            aria-selected={activeId === tab.id}
            tabIndex={activeId === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => navigate(event, index)}
            className={`inline-flex min-h-12 min-w-0 items-center gap-1.5 border-b-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-orange-300 sm:gap-2 sm:text-sm ${activeId === tab.id ? "border-slate-100 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}`}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-400">
                {tab.count}
              </span>
            ) : null}
            {tab.attention ? (
              <span
                role="img"
                aria-label="有待处理的对局"
                className="h-1.5 w-1.5 rounded-full bg-amber-300"
              />
            ) : null}
          </button>
        ))}
      </div>
      {live && awaitingConfirmation ? (
        <div
          className="flex items-center justify-between gap-3 text-xs text-slate-400"
          aria-live="polite"
        >
          <span>待确认的比分会自动更新</span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
            className="min-h-11 shrink-0 px-2 text-slate-200 hover:text-white disabled:opacity-60"
          >
            {refreshing ? "更新中…" : "刷新比分"}
          </button>
        </div>
      ) : null}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${prefix}-panel-${tab.id}`}
          aria-labelledby={`${prefix}-tab-${tab.id}`}
          hidden={activeId !== tab.id}
          tabIndex={0}
          className="pt-6 focus-visible:outline-2 focus-visible:outline-orange-300"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
