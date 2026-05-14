import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import EditMatchForm from "@/components/match/EditMatchForm";

export default async function EditMatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [currentUser, match] = await Promise.all([
    getCurrentUser(),
    prisma.match.findUnique({ where: { id } }),
  ]);

  if (!match) notFound();
  if (!currentUser) redirect("/auth");
  if (currentUser.id !== match.createdBy) redirect(`/matchs/${id}`);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Link
        href={`/matchs/${id}`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" />
        返回比赛详情
      </Link>

      <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-8">
        <h1 className="mb-6 text-2xl font-bold text-white">修改比赛</h1>
        <EditMatchForm
          matchId={id}
          initial={{
            title: match.title,
            description: match.description ?? "",
            location: match.location ?? "",
            dateTimeIso: match.dateTime.toISOString(),
            type: match.type,
            format: match.format,
            registrationDeadlineIso: match.registrationDeadline.toISOString(),
          }}
        />
      </div>
    </div>
  );
}
