"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { validateCsrfToken } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { createV2ProgressiveKnockoutActionHandlers, type V2ProgressiveKnockoutActionState } from "@/modules/competitions-v2/adapters/progressive-knockout-actions";

const handlers = createV2ProgressiveKnockoutActionHandlers({
  db:prisma,getCurrentUser,validateCsrfToken,
  revalidatePaths(paths) { for (const path of paths) revalidatePath(path); },
  logError(message,error) { console.error(message,{name:error instanceof Error?error.name:"UnknownError"}); },
});

export async function publishEarlyKnockoutScheduleAction(_previous:V2ProgressiveKnockoutActionState,formData:FormData):Promise<V2ProgressiveKnockoutActionState> {
  return handlers.publish(formData);
}

export async function freezeGroupQualificationAction(_previous:V2ProgressiveKnockoutActionState,formData:FormData):Promise<V2ProgressiveKnockoutActionState> {
  return handlers.freezeGroup(formData);
}
