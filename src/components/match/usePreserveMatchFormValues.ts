"use client";

import { useEffect, useRef } from "react";

export default function usePreserveMatchFormValues() {
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const preventReset = (event: Event) => event.preventDefault();
    // Action forms reset during React's commit, when delegated handlers may not run.
    form.addEventListener("reset", preventReset);
    return () => form.removeEventListener("reset", preventReset);
  }, []);

  return formRef;
}
