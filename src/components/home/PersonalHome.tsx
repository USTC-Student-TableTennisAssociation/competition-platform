import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { HomeUserCompetitionProjection } from "@/modules/competitions-v2/read-model/home-user-competition";
import FreeMatchHall, { type FreeMatchPostItem } from "./FreeMatchHall";
import EloTrendChart from "./EloTrendChart";
import HomePortrait from "./HomePortrait";
import HomeMatchPanel from "./HomeMatchPanel";
import styles from "./PersonalHome.module.css";

type HomePlayer = {
  id: string;
  nickname: string;
  bio: string | null;
  avatarUrl: string | null;
  eloRating: number;
  points: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
};

export type HomeOpenMatch = {
  id: string;
  title: string;
  type: "single" | "double" | "team";
  dateTime: Date;
  deadline: Date;
  location: string;
  participants: number;
  participantUnit: "people" | "pairs" | "teams";
  maxParticipants: number;
  isRegistered: boolean;
};

export default function PersonalHome({ user, rank, competition, matches, posts, eloPoints, eloChange, nearbyPlayers }: {
  user: HomePlayer | null;
  rank: number | null;
  nearbyPlayers: Array<{ id: string; nickname: string; eloRating: number; rank: number }>;
  competition: HomeUserCompetitionProjection;
  matches: HomeOpenMatch[];
  posts: FreeMatchPostItem[];
  eloPoints: Array<{ elo: number; createdAt: string }>;
  eloChange: number | null;
}) {
  return (
    <div className={styles.home}>
      <section className={styles.personal} data-player={user !== null} aria-label={user ? "我的个人信息" : "科大乒协"}>
        <div className={styles.identity}>
          <Link
            href={user ? "/profile/edit" : "/auth"}
            className={styles.portrait}
            aria-label={user ? "编辑头像" : "登录账号"}
          >
            <HomePortrait avatarUrl={user?.avatarUrl ?? null} nickname={user?.nickname ?? "TTA"} />
          </Link>
          <h1>{user?.nickname ?? "科大乒协"}</h1>
          {user?.bio ? <p className={styles.bio}>{user.bio}</p> : null}
          <Link href={user ? "/profile" : "/auth"} className={styles.profileLink}>
            {user ? "个人主页" : "登录 / 注册"}
            <ArrowRight size={17} aria-hidden="true" />
          </Link>
        </div>

        {user ? (
          <div className={styles.performance}>
            <div className={styles.ratingOverview}>
              <div className={styles.ratingHeader}>
                <div>
                  <h2>ELO 等级分</h2>
                  <strong className={styles.rating}>{user.eloRating}</strong>
                </div>
                {eloChange !== null ? (
                  <span className={styles.ratingChange}>
                    近期 {eloChange > 0 ? "+" : ""}{eloChange}
                  </span>
                ) : null}
              </div>
              <div className={styles.chart} aria-label="最近二十次 ELO 变化">
                <EloTrendChart points={eloPoints} readable responsiveCompact />
              </div>
            </div>
            <div className={styles.stats}>
              <Link href="/rankings">
                <span>排名</span>
                <strong>{rank ? `#${rank}` : "—"}</strong>
              </Link>
              <Link href="/profile/history">
                <span>胜 / 负</span>
                <strong>{user.wins}<span className={styles.statSeparator}> / </span>{user.losses}</strong>
              </Link>
              <Link href="/profile">
                <span>积分</span>
                <strong>{user.points}</strong>
              </Link>
            </div>
            <div className={styles.recentResults}>
              <span>最近战绩</span>
              <div className={styles.resultList}>
                {competition.recentResults.map(result => (
                  <Link
                    key={result.id}
                    href={`/matchs/${result.matchId}`}
                    className={result.isWin ? styles.win : styles.loss}
                    title={`${result.isWin ? "胜" : "负"} · ${result.opponentLabel}${result.eloDelta !== null ? ` · ELO ${result.eloDelta > 0 ? "+" : ""}${result.eloDelta}` : ""}`}
                    aria-label={`${result.isWin ? "战胜" : "负于"} ${result.opponentLabel}，查看比赛`}
                  >{result.isWin ? "胜" : "负"}</Link>
                ))}
                {competition.recentResults.length === 0 ? <span className={styles.muted}>暂无已确认战绩</span> : null}
              </div>
              <Link className={styles.historyLink} href="/profile/history">全部 <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
          </div>
        ) : (
          <div className={styles.guest}>
            <h2>你的比赛，从这里开始。</h2>
            <p>参加赛事、认识球友，记录自己的成长。</p>
            <Link href="/matchs" className={styles.primary}>
              浏览比赛 <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        )}
      </section>

      <div className={styles.lobby}>
        <HomeMatchPanel
          myMatches={competition.myMatches}
          openMatches={matches.map(match => ({
            id: match.id,
            title: match.title,
            dateTime: match.dateTime.toISOString(),
            deadline: match.deadline.toISOString(),
            location: match.location,
            isRegistered: match.isRegistered,
            type: match.type,
          }))}
        />
        <aside className={styles.sidebar} aria-label="排名与自由约球">
          <section className={styles.rankings} aria-label={user ? "我附近的排名" : "排名领先的选手"}>
            <div className={styles.matchHeader}>
              <h2 className={styles.sectionTitle}>{user ? "附近排名" : "排行榜"}</h2>
              <Link className={styles.allMatches} href="/rankings">榜单 <ArrowRight size={17} aria-hidden="true" /></Link>
            </div>
            <div className={styles.rankLabels}><span>选手</span><span>ELO</span></div>
            {nearbyPlayers.map(player => (
              <Link key={player.id} className={styles.rankRow} data-self={player.id === user?.id} href={player.id === user?.id ? "/profile" : `/profile/${player.id}`}>
                <span className={styles.rankNumber}>{player.rank}</span>
                <span className={styles.rankName}>{player.id === user?.id ? "我" : player.nickname}</span>
                <strong>{player.eloRating}</strong>
              </Link>
            ))}
            {nearbyPlayers.length === 0 ? <p className={styles.muted}>暂无排名</p> : null}
          </section>
          <FreeMatchHall posts={posts} currentUserId={user?.id ?? null} compact />
        </aside>
      </div>
    </div>
  );
}
