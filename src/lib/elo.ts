export type EloPlayer = {
  userId: string
  eloRating: number
  matchesPlayed: number
}

export type EloDelta = {
  userId: string
  before: number
  after: number
  delta: number
  k: number
}

const MIN_K = 12
const MAX_K = 48

function clamp(num: number, min: number, max: number) {
  return Math.max(min, Math.min(max, num))
}

export function getDynamicK(eloRating: number, matchesPlayed: number) {
  let k = 20

  if (matchesPlayed < 10) k = 40
  else if (matchesPlayed < 30) k = 28

  if (eloRating >= 2200) k -= 8
  else if (eloRating >= 2000) k -= 4

  return clamp(k, MIN_K, MAX_K)
}

function expectedScore(selfRating: number, oppRating: number) {
  return 1 / (1 + 10 ** ((oppRating - selfRating) / 400))
}

export function settleSinglesElo(winner: EloPlayer, loser: EloPlayer): [EloDelta, EloDelta] {
  const winnerK = getDynamicK(winner.eloRating, winner.matchesPlayed)
  const loserK = getDynamicK(loser.eloRating, loser.matchesPlayed)

  const winnerExp = expectedScore(winner.eloRating, loser.eloRating)
  const loserExp = expectedScore(loser.eloRating, winner.eloRating)

  const winnerDelta = Math.round(winnerK * (1 - winnerExp))
  const loserDelta = Math.round(loserK * (0 - loserExp))

  return [
    {
      userId: winner.userId,
      before: winner.eloRating,
      after: winner.eloRating + winnerDelta,
      delta: winnerDelta,
      k: winnerK,
    },
    {
      userId: loser.userId,
      before: loser.eloRating,
      after: loser.eloRating + loserDelta,
      delta: loserDelta,
      k: loserK,
    },
  ]
}

export function settleTeamElo(winnerTeam: EloPlayer[], loserTeam: EloPlayer[]) {
  if (winnerTeam.length === 0 || loserTeam.length === 0) {
    throw new Error('双方队伍不能为空。')
  }

  const winnerAvg = winnerTeam.reduce((acc, p) => acc + p.eloRating, 0) / winnerTeam.length
  const loserAvg = loserTeam.reduce((acc, p) => acc + p.eloRating, 0) / loserTeam.length

  const winnerExpected = expectedScore(winnerAvg, loserAvg)
  const loserExpected = expectedScore(loserAvg, winnerAvg)

  const winnerDeltas: EloDelta[] = winnerTeam.map((player) => {
    const k = getDynamicK(player.eloRating, player.matchesPlayed)
    const delta = Math.round(k * (1 - winnerExpected))
    return {
      userId: player.userId,
      before: player.eloRating,
      after: player.eloRating + delta,
      delta,
      k,
    }
  })

  const loserDeltas: EloDelta[] = loserTeam.map((player) => {
    const k = getDynamicK(player.eloRating, player.matchesPlayed)
    const delta = Math.round(k * (0 - loserExpected))
    return {
      userId: player.userId,
      before: player.eloRating,
      after: player.eloRating + delta,
      delta,
      k,
    }
  })

  return [...winnerDeltas, ...loserDeltas]
}
