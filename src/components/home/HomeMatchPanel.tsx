import Link from "next/link";
import { ArrowRight, Pin } from "lucide-react";
import type { HomeUserMatchItem } from "@/modules/competitions-v2/read-model/home-user-competition";
import styles from "./PersonalHome.module.css";

type OpenMatch = {
  id: string;
  title: string;
  dateTime: string;
  deadline: string;
  location: string;
  isRegistered: boolean;
  type: "single" | "double" | "team";
};

function dateLabel(date: Date | string) {
  return new Date(date).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function ParticipatingMatch({ match, featured = false }: { match: HomeUserMatchItem; featured?: boolean }) {
  return (
    <article className={`${styles.matchCard} ${styles.ownMatch}`} data-featured={featured}>
      <div className={styles.matchMeta}>
        <span className={styles.matchStatus}>{match.status === "ongoing" ? "你正在参加" : "你已报名"}</span>
        <span className={styles.pinned}><Pin size={14} aria-hidden="true" />置顶</span>
      </div>
      <h3><Link href={`/matchs/${match.id}`}>{match.title}</Link></h3>
      <p className={styles.matchSchedule}>{match.status === "registration" ? `${dateLabel(match.dateTime)} 开赛` : match.phase}</p>
      <div className={styles.matchCardBottom}>
        <p>{match.pendingCount > 0 ? `${match.pendingCount} 场成绩待确认` : match.status === "ongoing" ? `${match.confirmedCount} 场已完成` : "等待开赛"}</p>
        <Link className={featured ? styles.primary : styles.textAction} href={`/matchs/${match.id}`}>
          {match.pendingCount > 0 ? "查看比分" : "进入比赛"}<ArrowRight size={17} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

export default function HomeMatchPanel({ myMatches, openMatches }: {
  myMatches: readonly HomeUserMatchItem[];
  openMatches: readonly OpenMatch[];
}) {
  const active = myMatches.filter(match => match.status !== "finished").sort((a, b) =>
    Number(b.pendingCount > 0) - Number(a.pendingCount > 0) ||
    Number(b.status === "ongoing") - Number(a.status === "ongoing") ||
    new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime() || a.id.localeCompare(b.id),
  );
  const ownIds = new Set(active.map(match => match.id));
  const discovery = openMatches.filter(match => !ownIds.has(match.id)).slice(0, active.length ? 2 : 3);

  return (
    <section className={styles.competitions} aria-label="近期赛事">
      <div className={styles.matchHeader}>
        <h2 className={styles.sectionTitle}>近期赛事</h2>
        <Link className={styles.allMatches} href="/matchs">全部赛事 <ArrowRight size={17} aria-hidden="true" /></Link>
      </div>
      <div className={styles.matchGrid}>
        {active.slice(0, 2).map((match, index) => <ParticipatingMatch key={match.id} match={match} featured={index === 0} />)}
        {active.length > 2 ? (
          <details className={styles.moreMatches}>
            <summary>另外 {active.length - 2} 场正在参与的比赛</summary>
            <div className={styles.matchGrid}>{active.slice(2).map(match => <ParticipatingMatch key={match.id} match={match} />)}</div>
          </details>
        ) : null}
        {discovery.map(match => (
          <article className={styles.matchCard} key={match.id}>
            <div className={styles.matchMeta}>
              <span className={styles.openStatus}>{match.isRegistered ? "你已报名" : "报名中"} · {{ single: "单打", double: "双打", team: "团体" }[match.type]}</span>
              <span className={styles.deadline}>{dateLabel(match.deadline)} 截止</span>
            </div>
            <h3><Link href={`/matchs/${match.id}`}>{match.title}</Link></h3>
            <div className={styles.matchCardBottom}>
              <p>{dateLabel(match.dateTime)} · {match.location}</p>
              <Link className={styles.textAction} href={`/matchs/${match.id}`}>查看比赛 <ArrowRight size={17} aria-hidden="true" /></Link>
            </div>
          </article>
        ))}
        {active.length === 0 && discovery.length === 0 ? (
          <div className={styles.empty}>
            <h3>近期暂无赛事</h3>
            <Link className={styles.profileLink} href="/matchs">浏览比赛大厅 <ArrowRight size={18} aria-hidden="true" /></Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
