"use client";

import { useEffect, useRef, type ReactNode } from "react";

export default function BracketViewport({
  children,
  finalCenter,
  personalCenter,
}: Readonly<{
  children: ReactNode;
  finalCenter: number;
  personalCenter?: number;
}>) {
  const viewport = useRef<HTMLDivElement>(null);
  const initialCenter = personalCenter ?? finalCenter;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0)
        element.scrollLeft = initialCenter - element.clientWidth / 2;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [initialCenter]);

  function goTo(position: "left" | "final" | "right" | "personal") {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({
      left:
        position === "left"
          ? 0
          : position === "right"
            ? element.scrollWidth
            : (position === "personal"
                ? (personalCenter ?? finalCenter)
                : finalCenter) -
              element.clientWidth / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }

  return (
    <div>
      {personalCenter !== undefined ? (
        <div className="border-b border-white/8 px-4">
          <button
            type="button"
            onClick={() => goTo("personal")}
            className="min-h-11 rounded-md text-xs font-medium text-orange-200 focus-visible:outline-2 focus-visible:outline-orange-300"
          >
            定位我的对局
          </button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-b border-white/8 px-2 py-1 text-xs text-slate-400 sm:px-4">
        <button
          type="button"
          onClick={() => goTo("left")}
          className="min-h-10 rounded-md px-2 hover:text-white focus-visible:outline-2 focus-visible:outline-orange-300"
        >
          ← 左半区
        </button>
        <button
          type="button"
          onClick={() => goTo("final")}
          className="min-h-10 rounded-md px-3 font-medium text-slate-200 hover:text-white focus-visible:outline-2 focus-visible:outline-orange-300"
        >
          定位决赛
        </button>
        <button
          type="button"
          onClick={() => goTo("right")}
          className="min-h-10 rounded-md px-2 hover:text-white focus-visible:outline-2 focus-visible:outline-orange-300"
        >
          右半区 →
        </button>
      </div>
      <div
        ref={viewport}
        className="overflow-x-auto p-2 sm:p-4"
        role="region"
        aria-label="淘汰赛签表，可横向滚动"
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
