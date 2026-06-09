"use client";

import { useActionState, useState } from "react";
import {
  Download,
  LogOut,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import {
  cancelMatchTeamAction,
  createMatchTeamAction,
  joinMatchTeamByInviteAction,
  leaveMatchTeamAction,
  removeMatchTeamMemberAction,
  type MatchFormState,
  updateMatchTeamAction,
} from "@/app/matchs/actions";

type TeamStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "waitlisted"
  | "cancelled";

type TeamMember = {
  userId: string;
  nickname: string;
  avatarUrl?: string | null;
  joinedAt: string;
};

export type TeamRegistrationItem = {
  id: string;
  name: string;
  inviteCode: string;
  captainId: string;
  captainNickname: string;
  contact: string | null;
  remark: string | null;
  reviewNote: string | null;
  status: TeamStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  members: TeamMember[];
};

type Props = {
  matchId: string;
  currentUserId?: string | null;
  isAdmin: boolean;
  registrationOpen: boolean;
  registrationNotStarted: boolean;
  registrationClosed: boolean;
  startsAt: string;
  deadline: string;
  minMembers: number;
  maxMembers: number;
  teams: TeamRegistrationItem[];
};

const initialState: MatchFormState = {};
const TEAMS_PER_PAGE = 8;

const statusMeta: Record<
  TeamStatus,
  { label: string; className: string }
> = {
  draft: {
    label: "组建中",
    className: "bg-slate-400/10 text-slate-200 ring-slate-300/16",
  },
  submitted: {
    label: "组建中",
    className: "bg-amber-400/12 text-amber-100 ring-amber-300/18",
  },
  approved: {
    label: "已成队",
    className: "bg-emerald-400/12 text-emerald-100 ring-emerald-300/18",
  },
  rejected: {
    label: "组建中",
    className: "bg-rose-400/12 text-rose-100 ring-rose-300/18",
  },
  waitlisted: {
    label: "候补",
    className: "bg-sky-400/12 text-sky-100 ring-sky-300/18",
  },
  cancelled: {
    label: "已取消",
    className: "bg-slate-500/12 text-slate-300 ring-slate-300/12",
  },
};

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN");
}

function isEditableStatus(status: TeamStatus) {
  return status !== "cancelled";
}

function getDisplayStatus(team: TeamRegistrationItem, minMembers: number) {
  if (team.status === "cancelled") return statusMeta.cancelled;
  if (team.members.length >= minMembers) return statusMeta.approved;
  return statusMeta.draft;
}

function getMissingMembers(team: TeamRegistrationItem, minMembers: number) {
  return Math.max(0, minMembers - team.members.length);
}

function paginateTeams(teams: TeamRegistrationItem[], page: number) {
  const totalPages = Math.max(1, Math.ceil(teams.length / TEAMS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pagedTeams = teams.slice(
    (currentPage - 1) * TEAMS_PER_PAGE,
    currentPage * TEAMS_PER_PAGE,
  );
  return { totalPages, currentPage, pagedTeams };
}

function ActionMessage({ state }: { state: MatchFormState }) {
  if (state.error) return <p className="text-sm text-rose-300">{state.error}</p>;
  if (state.success) {
    return <p className="text-sm text-emerald-300">{state.success}</p>;
  }
  return null;
}

function CreateTeamForm({
  matchId,
  disabled,
}: {
  matchId: string;
  disabled: boolean;
}) {
  const action = createMatchTeamAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <p className="rounded-2xl bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-100 ring-1 ring-amber-300/12">
        联系方式和备注会展示给其他参赛用户，请勿填写不希望公开的信息。
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300">
          <span>队伍名称</span>
          <input
            name="name"
            required
            maxLength={40}
            placeholder="例如：瀚海削球联队"
            className="input-dark w-full rounded-2xl px-3 py-2 text-slate-100 placeholder:text-slate-600"
          />
        </label>
        <label className="space-y-1 text-sm text-slate-300">
          <span>联系方式</span>
          <input
            name="contact"
            required
            maxLength={100}
            placeholder="手机号、QQ 或微信等"
            className="input-dark w-full rounded-2xl px-3 py-2 text-slate-100 placeholder:text-slate-600"
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm text-slate-300">
        <span>备注</span>
        <textarea
          name="remark"
          rows={3}
          maxLength={500}
          placeholder="可填写年级、院系、特殊说明等"
          className="input-dark w-full rounded-2xl px-3 py-2 text-slate-100 placeholder:text-slate-600"
        />
      </label>
      <button
        type="submit"
        disabled={disabled || pending}
        className="btn-primary inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold disabled:opacity-60"
      >
        <Users className="h-4 w-4" />
        {pending ? "创建中..." : "创建队伍"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function JoinTeamForm({
  matchId,
  disabled,
}: {
  matchId: string;
  disabled: boolean;
}) {
  const action = joinMatchTeamByInviteAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <label className="block space-y-1 text-sm text-slate-300">
        <span>邀请码</span>
        <input
          name="inviteCode"
          required
          maxLength={20}
          placeholder="输入队长分享的邀请码"
          className="input-dark w-full rounded-2xl px-3 py-2 uppercase text-slate-100 placeholder:text-slate-600"
        />
      </label>
      <button
        type="submit"
        disabled={disabled || pending}
        className="btn-secondary inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold disabled:opacity-60"
      >
        <UserPlus className="h-4 w-4" />
        {pending ? "加入中..." : "加入队伍"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function UpdateTeamForm({ team }: { team: TeamRegistrationItem }) {
  const action = updateMatchTeamAction.bind(null, team.id);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <p className="rounded-2xl bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-100 ring-1 ring-amber-300/12">
        联系方式和备注会展示给其他参赛用户，请勿填写不希望公开的信息。
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300">
          <span>队伍名称</span>
          <input
            name="name"
            required
            maxLength={40}
            defaultValue={team.name}
            className="input-dark w-full rounded-2xl px-3 py-2 text-slate-100"
          />
        </label>
        <label className="space-y-1 text-sm text-slate-300">
          <span>联系方式</span>
          <input
            name="contact"
            required
            maxLength={100}
            defaultValue={team.contact ?? ""}
            className="input-dark w-full rounded-2xl px-3 py-2 text-slate-100"
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm text-slate-300">
        <span>备注</span>
        <textarea
          name="remark"
          rows={3}
          maxLength={500}
          defaultValue={team.remark ?? ""}
          className="input-dark w-full rounded-2xl px-3 py-2 text-slate-100"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="btn-secondary inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold disabled:opacity-60"
      >
        <ShieldCheck className="h-4 w-4" />
        {pending ? "保存中..." : "保存队伍信息"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function CancelTeamButton({
  teamId,
  label,
}: {
  teamId: string;
  label: string;
}) {
  const action = cancelMatchTeamAction.bind(null, teamId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-400/40 px-4 py-2 text-sm font-bold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60 sm:w-auto"
      >
        <Trash2 className="h-4 w-4" />
        {pending ? "处理中..." : label}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function LeaveTeamButton({ teamId }: { teamId: string }) {
  const action = leaveMatchTeamAction.bind(null, teamId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-400/40 px-4 py-2 text-sm font-bold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60 sm:w-auto"
      >
        <LogOut className="h-4 w-4" />
        {pending ? "退出中..." : "退出队伍"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function RemoveMemberButton({
  teamId,
  userId,
}: {
  teamId: string;
  userId: string;
}) {
  const action = removeMatchTeamMemberAction.bind(null, teamId, userId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-xl border border-rose-400/32 px-2.5 py-1 text-xs font-bold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
      >
        <UserMinus className="h-3.5 w-3.5" />
        {pending ? "移除中..." : "移除"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function TeamMembersList({
  team,
  canRemove,
}: {
  team: TeamRegistrationItem;
  canRemove: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {team.members.map((member) => (
        <div
          key={member.userId}
          className="flex items-center justify-between gap-3 rounded-2xl bg-slate-950/36 px-3 py-2 ring-1 ring-white/8"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">
              {member.nickname}
              {member.userId === team.captainId ? (
                <span className="ml-2 rounded-full bg-teal-400/10 px-2 py-0.5 text-[11px] text-teal-100 ring-1 ring-teal-300/12">
                  队长
                </span>
              ) : null}
            </p>
            <p className="truncate text-xs text-slate-400">
              加入时间：{formatDateTime(member.joinedAt)}
            </p>
          </div>
          {canRemove && member.userId !== team.captainId ? (
            <RemoveMemberButton teamId={team.id} userId={member.userId} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TeamStatusPill({
  team,
  minMembers,
}: {
  team: TeamRegistrationItem;
  minMembers: number;
}) {
  const meta = getDisplayStatus(team, minMembers);
  return (
    <span className={`status-pill ring-1 ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function MemberChips({ team }: { team: TeamRegistrationItem }) {
  return (
    <div className="flex flex-wrap gap-2">
      {team.members.map((member) => (
        <span
          key={`${team.id}-${member.userId}`}
          className="rounded-full bg-slate-950/42 px-2.5 py-1 text-xs text-slate-200 ring-1 ring-white/8"
        >
          {member.nickname}
          {member.userId === team.captainId ? "（队长）" : ""}
        </span>
      ))}
    </div>
  );
}

function JoinByInviteButton({
  matchId,
  inviteCode,
  disabled,
}: {
  matchId: string;
  inviteCode: string;
  disabled: boolean;
}) {
  const action = joinMatchTeamByInviteAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="inviteCode" defaultValue={inviteCode} />
      <button
        type="submit"
        disabled={disabled || pending}
        className="btn-secondary inline-flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-2 text-xs font-bold disabled:opacity-60 sm:w-auto"
      >
        <UserPlus className="h-3.5 w-3.5" />
        {pending ? "加入中..." : "加入队伍"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function PaginationControls({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  const firstVisiblePage = Math.max(1, currentPage - 2);
  const lastVisiblePage = Math.min(totalPages, currentPage + 2);
  const pages = Array.from(
    { length: lastVisiblePage - firstVisiblePage + 1 },
    (_, index) => firstVisiblePage + index,
  );

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
      <button
        type="button"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        className="btn-secondary rounded-xl px-3 py-1.5 text-xs font-bold disabled:opacity-50"
      >
        上一页
      </button>
      <div className="flex flex-wrap gap-1.5">
        {pages.map((page) => (
          <button
            key={page}
            type="button"
            onClick={() => onPageChange(page)}
            className={`h-8 min-w-8 rounded-xl px-2 text-xs font-bold ring-1 ${
              page === currentPage
                ? "bg-teal-400/16 text-teal-100 ring-teal-300/20"
                : "bg-white/[0.035] text-slate-300 ring-white/8 hover:bg-white/[0.06]"
            }`}
          >
            {page}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        className="btn-secondary rounded-xl px-3 py-1.5 text-xs font-bold disabled:opacity-50"
      >
        下一页
      </button>
    </div>
  );
}

function PublicTeamCard({
  team,
  matchId,
  minMembers,
  maxMembers,
  canJoin,
  registrationOpen,
  variant,
}: {
  team: TeamRegistrationItem;
  matchId: string;
  minMembers: number;
  maxMembers: number;
  canJoin: boolean;
  registrationOpen: boolean;
  variant: "building" | "formed";
}) {
  const missingMembers = getMissingMembers(team, minMembers);
  const isFull = team.members.length >= maxMembers;

  return (
    <article className="rounded-3xl bg-white/[0.025] p-4 ring-1 ring-white/8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-base font-black text-slate-100">
              {team.name}
            </h4>
            <TeamStatusPill team={team} minMembers={minMembers} />
          </div>
          <p className="mt-1 text-sm text-slate-400">
            队长：{team.captainNickname}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-white/[0.045] px-3 py-1 text-xs text-slate-300 ring-1 ring-white/8">
            {team.members.length}/{minMembers}/{maxMembers} 人
          </span>
          <span className="rounded-full bg-teal-400/8 px-3 py-1 font-mono text-xs font-bold tracking-wide text-teal-100 ring-1 ring-teal-300/12">
            邀请码 {team.inviteCode}
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-sm text-slate-300 md:grid-cols-2">
        <p className="rounded-2xl bg-slate-950/28 px-3 py-2 ring-1 ring-white/8">
          联系方式：{team.contact ?? "未填写"}
        </p>
        <p className="rounded-2xl bg-slate-950/28 px-3 py-2 ring-1 ring-white/8">
          {variant === "building"
            ? `还差 ${missingMembers} 人成队`
            : isFull
              ? "已满员"
              : "已成队，可补员"}
        </p>
      </div>

      {team.remark ? (
        <p className="mt-3 rounded-2xl bg-slate-950/28 px-3 py-2 text-sm leading-6 text-slate-300 ring-1 ring-white/8">
          备注：{team.remark}
        </p>
      ) : null}

      <div className="mt-3">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
          Members
        </p>
        <MemberChips team={team} />
      </div>

      {canJoin && !isFull ? (
        <div className="mt-4">
          <JoinByInviteButton
            matchId={matchId}
            inviteCode={team.inviteCode}
            disabled={!registrationOpen}
          />
        </div>
      ) : null}
    </article>
  );
}

export default function TeamRegistrationPanel({
  matchId,
  currentUserId,
  isAdmin,
  registrationOpen,
  registrationNotStarted,
  registrationClosed,
  startsAt,
  deadline,
  minMembers,
  maxMembers,
  teams,
}: Props) {
  const [buildingPage, setBuildingPage] = useState(1);
  const [formedPage, setFormedPage] = useState(1);
  const publicTeams = teams.filter((team) => team.status !== "cancelled");
  const adminVisibleTeams = publicTeams;
  const buildingTeams = publicTeams.filter(
    (team) => team.members.length < minMembers,
  );
  const formedTeams = publicTeams.filter(
    (team) => team.members.length >= minMembers,
  );
  const myTeam = currentUserId
    ? publicTeams.find(
        (team) =>
          (team.members.some((member) => member.userId === currentUserId) ||
            team.captainId === currentUserId),
      )
    : null;
  const buildingPagination = paginateTeams(buildingTeams, buildingPage);
  const formedPagination = paginateTeams(formedTeams, formedPage);
  const canJoinPublicTeam = Boolean(currentUserId && !myTeam && registrationOpen);
  const disabledReason = registrationNotStarted
    ? "团体报名尚未开始"
    : registrationClosed
      ? "团体报名已截止"
      : "当前不可报名";

  return (
    <section className="surface-card rounded-3xl p-4 sm:p-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div>
          <p className="eyebrow">Team Registration</p>
          <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
            团体赛报名
          </h2>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              {minMembers}-{maxMembers} 人/队
            </span>
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              开始：{formatDateTime(startsAt)}
            </span>
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              截止：{formatDateTime(deadline)}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-3xl bg-slate-950/36 px-4 py-3 ring-1 ring-white/8">
            <p className="text-xs text-slate-400">正在组建</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-slate-100">
              {buildingTeams.length} 支
            </p>
          </div>
          <div className="rounded-3xl bg-slate-950/36 px-4 py-3 ring-1 ring-white/8">
            <p className="text-xs text-slate-400">已成队</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-slate-100">
              {formedTeams.length} 支
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <div className="rounded-3xl bg-slate-950/24 p-4 ring-1 ring-white/8 sm:p-5">
          <h3 className="text-base font-bold text-white">我的团体赛报名</h3>
          {!currentUserId ? (
            <p className="mt-3 text-sm text-slate-400">请先登录后报名。</p>
          ) : myTeam ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-lg font-black text-slate-100">
                      {myTeam.name}
                    </h4>
                    <TeamStatusPill team={myTeam} minMembers={minMembers} />
                  </div>
                  <p className="mt-1 text-sm text-slate-400">
                    队长：{myTeam.captainNickname} · {myTeam.members.length}/
                    {maxMembers} 人
                  </p>
                </div>
                <div className="rounded-2xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/8">
                  <p className="text-[11px] text-slate-500">邀请码</p>
                  <p className="font-mono text-sm font-black tracking-wide text-teal-100">
                    {myTeam.inviteCode}
                  </p>
                </div>
              </div>

              <p
                className={`rounded-2xl px-3 py-2 text-sm ring-1 ${
                  myTeam.members.length >= minMembers
                    ? "bg-emerald-400/8 text-emerald-100 ring-emerald-300/12"
                    : "bg-slate-400/8 text-slate-300 ring-slate-300/12"
                }`}
              >
                {myTeam.members.length >= minMembers
                  ? "已成队，系统已自动报名。"
                  : `还差 ${getMissingMembers(myTeam, minMembers)} 人成队。`}
              </p>

              <div className="grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                <p className="rounded-2xl bg-white/[0.025] px-3 py-2 ring-1 ring-white/8">
                  联系方式：{myTeam.contact ?? "未填写"}
                </p>
                <p className="rounded-2xl bg-white/[0.025] px-3 py-2 ring-1 ring-white/8">
                  备注：{myTeam.remark || "无"}
                </p>
              </div>

              <TeamMembersList
                team={myTeam}
                canRemove={
                  Boolean(currentUserId) &&
                  currentUserId === myTeam.captainId &&
                  registrationOpen &&
                  isEditableStatus(myTeam.status)
                }
              />

              {currentUserId === myTeam.captainId &&
              registrationOpen &&
              isEditableStatus(myTeam.status) ? (
                <UpdateTeamForm team={myTeam} />
              ) : null}

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {currentUserId === myTeam.captainId &&
                registrationOpen &&
                myTeam.status !== "cancelled" ? (
                  <CancelTeamButton teamId={myTeam.id} label="解散队伍" />
                ) : null}
                {currentUserId !== myTeam.captainId &&
                registrationOpen &&
                isEditableStatus(myTeam.status) ? (
                  <LeaveTeamButton teamId={myTeam.id} />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="mt-4 grid gap-5 xl:grid-cols-2">
              <CreateTeamForm
                matchId={matchId}
                disabled={!registrationOpen}
              />
              <JoinTeamForm matchId={matchId} disabled={!registrationOpen} />
              {!registrationOpen ? (
                <p className="xl:col-span-2 text-sm text-slate-400">
                  {disabledReason}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="rounded-3xl bg-slate-950/24 p-4 ring-1 ring-white/8 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-white">正在组建的队伍</h3>
            <span className="text-xs text-slate-400">
              {buildingTeams.length} 支队伍 · 第{" "}
              {buildingPagination.currentPage}/{buildingPagination.totalPages} 页
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {buildingTeams.length === 0 ? (
              <p className="text-sm text-slate-400">暂无正在组建的队伍。</p>
            ) : (
              buildingPagination.pagedTeams.map((team) => (
                <PublicTeamCard
                  key={team.id}
                  team={team}
                  matchId={matchId}
                  minMembers={minMembers}
                  maxMembers={maxMembers}
                  canJoin={canJoinPublicTeam}
                  registrationOpen={registrationOpen}
                  variant="building"
                />
              ))
            )}
          </div>
          <PaginationControls
            currentPage={buildingPagination.currentPage}
            totalPages={buildingPagination.totalPages}
            onPageChange={setBuildingPage}
          />
        </div>

        <div className="rounded-3xl bg-slate-950/24 p-4 ring-1 ring-white/8 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-white">已完成组队的队伍</h3>
            <span className="text-xs text-slate-400">
              {formedTeams.length} 支队伍 · 第 {formedPagination.currentPage}/
              {formedPagination.totalPages} 页
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {formedTeams.length === 0 ? (
              <p className="text-sm text-slate-400">暂无已成队队伍。</p>
            ) : (
              formedPagination.pagedTeams.map((team) => (
                <PublicTeamCard
                  key={team.id}
                  team={team}
                  matchId={matchId}
                  minMembers={minMembers}
                  maxMembers={maxMembers}
                  canJoin={canJoinPublicTeam}
                  registrationOpen={registrationOpen}
                  variant="formed"
                />
              ))
            )}
          </div>
          <PaginationControls
            currentPage={formedPagination.currentPage}
            totalPages={formedPagination.totalPages}
            onPageChange={setFormedPage}
          />
        </div>
      </div>

      {isAdmin ? (
        <div className="mt-5 rounded-3xl border border-amber-400/24 bg-amber-400/5 p-4 sm:p-5">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h3 className="text-base font-bold text-amber-100">
                团体报名管理
              </h3>
              <p className="mt-1 text-xs text-amber-100/70">
                共 {adminVisibleTeams.length} 支队伍；人数达标后自动报名，无需管理员审核。
              </p>
            </div>
            <a
              href={`/api/matchs/${matchId}/team-registrations.csv`}
              className="btn-secondary inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold"
            >
              <Download className="h-4 w-4" />
              导出 CSV
            </a>
          </div>

          <div className="mt-4 space-y-3">
            {adminVisibleTeams.length === 0 ? (
              <p className="text-sm text-slate-400">暂无队伍。</p>
            ) : (
              adminVisibleTeams.map((team) => (
                <div
                  key={team.id}
                  className="rounded-3xl bg-slate-950/36 p-4 ring-1 ring-white/8"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-base font-black text-slate-100">
                          {team.name}
                        </h4>
                        <TeamStatusPill team={team} minMembers={minMembers} />
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        队长：{team.captainNickname} · 联系方式：
                        {team.contact ?? "未填写"} · 人数：
                        {team.members.length}/{maxMembers}
                      </p>
                      {team.remark ? (
                        <p className="mt-2 text-sm text-slate-300">
                          备注：{team.remark}
                        </p>
                      ) : null}
                    </div>
                    <div className="rounded-2xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/8">
                      <p className="text-[11px] text-slate-500">邀请码</p>
                      <p className="font-mono text-sm font-black tracking-wide text-teal-100">
                        {team.inviteCode}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3">
                    <TeamMembersList team={team} canRemove={false} />
                  </div>
                  {team.status !== "cancelled" ? (
                    <div className="mt-3">
                      <CancelTeamButton teamId={team.id} label="删除队伍" />
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
