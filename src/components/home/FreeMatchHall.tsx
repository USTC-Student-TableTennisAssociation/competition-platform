"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  Check,
  Clock3,
  Gauge,
  MapPin,
  Plus,
  Send,
  Swords,
  X,
} from "lucide-react";
import {
  acceptMatchApplicationAction,
  applyMatchPostAction,
  cancelMatchPostAction,
  createMatchPostAction,
  type MatchPostFormState,
} from "@/app/match-posts/actions";
import { VENUE_OPTIONS } from "@/lib/locations";

type MatchPostUser = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  eloRating: number;
};

type MatchPostApplication = {
  id: string;
  message: string | null;
  createdAt: string;
  applicant: MatchPostUser;
};

export type FreeMatchPostItem = {
  id: string;
  description: string | null;
  playAt: string;
  durationMinutes: number;
  location: string;
  minElo: number | null;
  maxElo: number | null;
  isRatedPreferred: boolean;
  creator: MatchPostUser;
  applications: MatchPostApplication[];
  currentUserApplicationStatus: string | null;
};

type Props = {
  posts: FreeMatchPostItem[];
  currentUserId: string | null;
};

const initialState: MatchPostFormState = {};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEloRange(minElo: number | null, maxElo: number | null) {
  if (minElo !== null && maxElo !== null) return `ELO ${minElo}-${maxElo}`;
  if (minElo !== null) return `ELO ${minElo}+`;
  if (maxElo !== null) return `ELO ≤ ${maxElo}`;
  return "ELO 不限";
}

function Avatar({ user }: { user: MatchPostUser }) {
  const fallback = (user.nickname.trim().charAt(0) || "?").toUpperCase();

  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border border-white/[0.08] bg-cyan-400/[0.08] text-sm font-semibold text-cyan-100">
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatarUrl}
          alt={user.nickname}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{fallback}</span>
      )}
    </div>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 px-4 py-8">
      <div className="w-full max-w-xl rounded-lg border border-[#30363d] bg-[#0d1117] shadow-2xl shadow-black/30">
        <div className="flex items-center justify-between gap-3 border-b border-[#30363d] px-4 py-3">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md border border-white/[0.08] text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreatePostModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    createMatchPostAction,
    initialState,
  );
  const [timezoneOffset, setTimezoneOffset] = useState("0");

  useEffect(() => {
    setTimezoneOffset(String(new Date().getTimezoneOffset()));
  }, []);

  useEffect(() => {
    if (!state.success) return;
    router.refresh();
    onClose();
  }, [state.success, router, onClose]);

  return (
    <ModalShell title="发布约球" onClose={onClose}>
      <form action={formAction} className="space-y-4 p-4">
        <input type="hidden" name="csrfToken" defaultValue="" />
        <input type="hidden" name="timezoneOffset" value={timezoneOffset} readOnly />

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-400">简介</span>
          <textarea
            name="description"
            required
            maxLength={300}
            rows={3}
            placeholder="简单写一下想练的内容、水平要求或联系方式。"
            className="w-full resize-none rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-400">时间</span>
            <input
              type="datetime-local"
              name="playAt"
              required
              className="w-full rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-400">时长</span>
            <select
              name="durationMinutes"
              defaultValue="90"
              className="w-full rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
            >
              <option value="30">30 分钟</option>
              <option value="60">60 分钟</option>
              <option value="90">90 分钟</option>
              <option value="120">120 分钟</option>
              <option value="180">180 分钟</option>
              <option value="240">240 分钟</option>
            </select>
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-400">地点</span>
          <select
            name="location"
            required
            className="w-full rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
          >
            {VENUE_OPTIONS.map((venue) => (
              <option key={venue} value={venue}>
                {venue}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-400">最低 ELO</span>
            <input
              type="number"
              name="minElo"
              min={0}
              max={4000}
              placeholder="不限"
              className="w-full rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-400">最高 ELO</span>
            <input
              type="number"
              name="maxElo"
              min={0}
              max={4000}
              placeholder="不限"
              className="w-full rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-300">
          <input
            type="checkbox"
            name="isRatedPreferred"
            className="h-4 w-4 accent-cyan-400"
          />
          希望后续可记录结果 / 可计分
        </label>

        {state.error ? <p className="text-sm text-rose-300">{state.error}</p> : null}
        {state.success ? (
          <p className="text-sm text-emerald-300">{state.success}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/[0.08] px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.04]"
          >
            取消
          </button>
          <button
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-[#010409] hover:bg-cyan-400 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {pending ? "发布中..." : "发布约球"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ApplyPostModal({
  post,
  onClose,
}: {
  post: FreeMatchPostItem;
  onClose: () => void;
}) {
  const router = useRouter();
  const action = applyMatchPostAction.bind(null, post.id);
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (!state.success) return;
    router.refresh();
    onClose();
  }, [state.success, router, onClose]);

  return (
    <ModalShell title="申请约球" onClose={onClose}>
      <form action={formAction} className="space-y-4 p-4">
        <input type="hidden" name="csrfToken" defaultValue="" />
        <div className="rounded-md border border-[#30363d] bg-[#010409] p-3">
          <p className="line-clamp-2 text-sm font-semibold text-slate-100">
            {post.description ?? "自由约球"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {formatDateTime(post.playAt)} · {post.location}
          </p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-400">申请留言</span>
          <textarea
            name="message"
            maxLength={200}
            rows={3}
            placeholder="可以简单说明你的水平、时间确认或想练的内容。"
            className="w-full resize-none rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
          />
        </label>
        {state.error ? <p className="text-sm text-rose-300">{state.error}</p> : null}
        {state.success ? (
          <p className="text-sm text-emerald-300">{state.success}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/[0.08] px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.04]"
          >
            取消
          </button>
          <button
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-[#010409] hover:bg-cyan-400 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {pending ? "提交中..." : "提交申请"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function AcceptApplicationForm({
  postId,
  application,
}: {
  postId: string;
  application: MatchPostApplication;
}) {
  const router = useRouter();
  const action = acceptMatchApplicationAction.bind(null, postId, application.id);
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (!state.success) return;
    router.refresh();
  }, [state.success, router]);

  return (
    <form action={formAction} className="mt-2 flex items-center justify-between gap-3 rounded-md border border-[#30363d] bg-[#010409] p-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <div className="flex min-w-0 items-center gap-2">
        <Avatar user={application.applicant} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-200">
            {application.applicant.nickname}
            <span className="ml-2 text-xs font-normal text-cyan-300">
              ELO {application.applicant.eloRating}
            </span>
          </p>
          {application.message ? (
            <p className="line-clamp-1 text-xs text-slate-400">
              {application.message}
            </p>
          ) : (
            <p className="text-xs text-slate-500">未填写留言</p>
          )}
          {state.error ? <p className="text-xs text-rose-300">{state.error}</p> : null}
          {state.success ? (
            <p className="text-xs text-emerald-300">{state.success}</p>
          ) : null}
        </div>
      </div>
      <button
        disabled={pending}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/15 disabled:opacity-50"
      >
        <Check className="h-3.5 w-3.5" />
        接受
      </button>
    </form>
  );
}

function CancelPostForm({ postId }: { postId: string }) {
  const router = useRouter();
  const action = cancelMatchPostAction.bind(null, postId);
  const [state, formAction, pending] = useActionState(action, initialState);

  useEffect(() => {
    if (!state.success) return;
    router.refresh();
  }, [state.success, router]);

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        disabled={pending}
        className="rounded-md border border-white/[0.08] px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.04] disabled:opacity-50"
      >
        {pending ? "取消中..." : "取消约球"}
      </button>
      {state.error ? <p className="text-xs text-rose-300">{state.error}</p> : null}
      {state.success ? (
        <p className="text-xs text-emerald-300">{state.success}</p>
      ) : null}
    </form>
  );
}

function MatchPostCard({
  post,
  currentUserId,
  onApply,
}: {
  post: FreeMatchPostItem;
  currentUserId: string | null;
  onApply: (post: FreeMatchPostItem) => void;
}) {
  const isCreator = currentUserId === post.creator.id;
  const hasApplied = Boolean(post.currentUserApplicationStatus);

  return (
    <article className="grid gap-4 border-t border-[#30363d] px-4 py-4 lg:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-3">
          <Avatar user={post.creator} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-200">
              {post.creator.nickname}
            </p>
            <p className="text-xs text-cyan-300">ELO {post.creator.eloRating}</p>
          </div>
          <span className="ml-auto rounded-md border border-cyan-300/20 bg-cyan-400/10 px-2 py-1 text-xs font-semibold text-cyan-100">
            {post.isRatedPreferred ? "可计分" : "娱乐约球"}
          </span>
        </div>

        <h3 className="line-clamp-2 text-base font-semibold leading-6 text-slate-100">
          {post.description ?? "自由约球"}
        </h3>

        <div className="mt-3 grid gap-2 text-sm text-sky-300/85 sm:grid-cols-2 xl:grid-cols-4">
          <span className="inline-flex min-w-0 items-center gap-2">
            <CalendarDays className="h-4 w-4 shrink-0 text-sky-500" />
            <span className="min-w-0 break-words">{formatDateTime(post.playAt)}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-2">
            <MapPin className="h-4 w-4 shrink-0 text-sky-500" />
            <span className="min-w-0 break-words">{post.location}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-2">
            <Clock3 className="h-4 w-4 shrink-0 text-sky-500" />
            <span>{post.durationMinutes} 分钟</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-2">
            <Gauge className="h-4 w-4 shrink-0 text-sky-500" />
            <span>{formatEloRange(post.minElo, post.maxElo)}</span>
          </span>
        </div>

        {isCreator && post.applications.length > 0 ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-slate-500">
              待处理申请 · {post.applications.length}
            </p>
            {post.applications.map((application) => (
              <AcceptApplicationForm
                key={application.id}
                postId={post.id}
                application={application}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-start justify-end gap-2 lg:w-28 lg:flex-col">
        {isCreator ? (
          <>
            <span className="rounded-md border border-white/[0.08] px-3 py-2 text-sm font-semibold text-slate-300">
              我发布的
            </span>
            <CancelPostForm postId={post.id} />
          </>
        ) : currentUserId ? (
          <button
            type="button"
            disabled={hasApplied}
            onClick={() => onApply(post)}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-[#010409] hover:bg-cyan-400 disabled:cursor-not-allowed disabled:border disabled:border-white/[0.08] disabled:bg-transparent disabled:text-slate-400"
          >
            <Swords className="h-4 w-4" />
            {hasApplied ? "已申请" : "申请约球"}
          </button>
        ) : (
          <a
            href="/auth"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-white/[0.08] px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.04]"
          >
            登录后申请
          </a>
        )}
      </div>
    </article>
  );
}

export default function FreeMatchHall({ posts, currentUserId }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [applyingPost, setApplyingPost] = useState<FreeMatchPostItem | null>(null);

  return (
    <section className="overflow-hidden rounded-lg border border-[#30363d] bg-[#0d1117]">
      <div className="flex flex-col gap-3 border-b border-[#30363d] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-100">自由约球</h2>
          <p className="mt-1 text-sm text-slate-400">
            发布临时约战，寻找合适水平的球友
          </p>
        </div>
        {currentUserId ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-[#010409] hover:bg-cyan-400"
          >
            <Plus className="h-4 w-4" />
            发布约球
          </button>
        ) : (
          <a
            href="/auth"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-white/[0.08] px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-white/[0.04]"
          >
            登录后发布
          </a>
        )}
      </div>

      {posts.length > 0 ? (
        posts.map((post) => (
          <MatchPostCard
            key={post.id}
            post={post}
            currentUserId={currentUserId}
            onApply={setApplyingPost}
          />
        ))
      ) : (
        <div className="grid place-items-center px-4 py-10 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-full border border-cyan-300/15 bg-cyan-400/10 text-cyan-100">
            <Swords className="h-5 w-5" />
          </div>
          <h3 className="mt-3 text-base font-semibold text-slate-100">
            暂无自由约球
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            发布一个约球帖，找人一起打球
          </p>
          {currentUserId ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-[#010409] hover:bg-cyan-400"
            >
              <Plus className="h-4 w-4" />
              发布约球
            </button>
          ) : null}
        </div>
      )}

      {createOpen ? <CreatePostModal onClose={() => setCreateOpen(false)} /> : null}
      {applyingPost ? (
        <ApplyPostModal
          post={applyingPost}
          onClose={() => setApplyingPost(null)}
        />
      ) : null}
    </section>
  );
}
