"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

type FixtureDetail = Readonly<{
  fixtureId: string;
  title: string;
  content: ReactNode;
}>;

const FixtureDialogContext = createContext<
  ((fixtureId: string, trigger: HTMLButtonElement) => void) | null
>(null);

export function FixtureTrigger({
  fixtureId,
  children,
  className,
  style,
  label,
}: Readonly<{
  fixtureId: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  label: string;
}>) {
  const openFixture = useContext(FixtureDialogContext);
  return (
    <button
      type="button"
      data-fixture-id={fixtureId}
      aria-label={label}
      aria-haspopup="dialog"
      title={label}
      className={className}
      style={style}
      onClick={(event) => openFixture?.(fixtureId, event.currentTarget)}
    >
      {children}
    </button>
  );
}

export default function ScheduleFixtureDialog({
  fixtures,
  children,
}: Readonly<{
  fixtures: readonly FixtureDetail[];
  children: ReactNode;
}>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const selected = fixtures.find((fixture) => fixture.fixtureId === selectedId);
  const selectedExists = Boolean(selected);

  useEffect(() => {
    if (!selectedId) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!selectedExists) {
      dialog.close();
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, [selectedId, selectedExists]);

  return (
    <FixtureDialogContext.Provider
      value={(fixtureId, trigger) => {
        triggerRef.current = trigger;
        setSelectedId(fixtureId);
      }}
    >
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-white/15 bg-[#0b1019] p-0 text-slate-100 shadow-2xl backdrop:bg-black/75"
        onClose={() => {
          setSelectedId(null);
          triggerRef.current?.focus({ preventScroll: true });
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            event.currentTarget.close();
        }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-[#0b1019] px-4 py-3 sm:px-5">
          <h2 id={titleId} className="text-sm font-semibold">
            {selected?.title ?? "对局详情"}
          </h2>
          <button
            type="button"
            aria-label="关闭对局详情"
            className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-orange-400"
            onClick={() => dialogRef.current?.close()}
            autoFocus
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 sm:p-6">{selected?.content}</div>
      </dialog>
    </FixtureDialogContext.Provider>
  );
}
