"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

type BackLinkButtonProps = {
  fallbackHref: string;
  label?: string;
};

export default function BackLinkButton({
  fallbackHref,
  label = "返回上一页",
}: BackLinkButtonProps) {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
          return;
        }
        router.push(fallbackHref);
      }}
      className="inline-flex items-center gap-2 text-slate-400 hover:text-slate-200"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </button>
  );
}
