import { CompetitionFormat } from '@prisma/client'

export type SeedPlayer = {
  id: string
  nickname: string
  eloRating: number
  points: number
}

export type GroupSeedMethod = 'min_diff' | 'snake'

type BracketMatch = {
  id: string
  homeLabel: string
  awayLabel: string
}

type BracketRound = {
  name: string
  matches: BracketMatch[]
}

type QualifierLabel = {
  groupIndex: number
  rank: number
  label: string
}

type GroupingPayload = {
  generatedAt: string
  format: CompetitionFormat
  config: {
    groupCount: number
    qualifiersPerGroup?: number
    seedMethod?: GroupSeedMethod
  }
  tableAssignments?: {
    group?: Record<string, string[]>
    knockout?: Record<string, string[]>
  }
  groups: Array<{
    name: string
    players: SeedPlayer[]
    averagePoints: number
  }>
  knockout?: {
    stage: string
    bracketSize: number
    rounds: BracketRound[]
  }
}

function snakeDistribute(players: SeedPlayer[], groupCount: number) {
  const groups: SeedPlayer[][] = Array.from({ length: groupCount }, () => [])
  players.forEach((player, index) => {
    const round = Math.floor(index / groupCount)
    const offset = index % groupCount
    const targetIndex = round % 2 === 0 ? offset : groupCount - 1 - offset
    groups[targetIndex].push(player)
  })
  return groups
}

function distributeByMinSpread(players: SeedPlayer[], groupCount: number) {
  const total = players.length
  const baseSize = Math.floor(total / groupCount)
  const remainder = total % groupCount
  const targetSizes = Array.from({ length: groupCount }, (_, index) =>
    index < remainder ? baseSize + 1 : baseSize,
  )

  const groups: SeedPlayer[][] = Array.from({ length: groupCount }, () => [])
  let startIndex = 0

  targetSizes.forEach((size, index) => {
    groups[index] = players.slice(startIndex, startIndex + size)
    startIndex += size
  })

  return groups
}

function averageElo(players: SeedPlayer[]) {
  if (players.length === 0) return 0
  return Math.round(players.reduce((sum, p) => sum + p.eloRating, 0) / players.length)
}

function isPowerOfTwo(value: number) {
  return value > 0 && (value & (value - 1)) === 0
}

function getRoundNameBySize(size: number) {
  return size === 2 ? '决赛' : size === 4 ? '半决赛' : size === 8 ? '1/4 决赛' : '淘汰赛首轮'
}

function buildBracketRounds(firstRoundMatches: BracketMatch[], bracketSize: number): BracketRound[] {
  const rounds: BracketRound[] = []

  let currentRoundMatches = firstRoundMatches

  rounds.push({
    name: getRoundNameBySize(bracketSize),
    matches: currentRoundMatches,
  })

  let roundIndex = 2
  while (currentRoundMatches.length > 1) {
    const nextMatches = Array.from({ length: currentRoundMatches.length / 2 }, (_, i) => ({
      id: `R${roundIndex}-M${i + 1}`,
      homeLabel: `胜者 ${currentRoundMatches[i * 2].id}`,
      awayLabel: `胜者 ${currentRoundMatches[i * 2 + 1].id}`,
    }))

    rounds.push({
      name: nextMatches.length === 1 ? '决赛' : nextMatches.length === 2 ? '半决赛' : `${nextMatches.length * 2} 强赛`,
      matches: nextMatches,
    })

    currentRoundMatches = nextMatches
    roundIndex += 1
  }

  return rounds
}

function buildFirstRoundMatches(
  groups: Array<{ name: string }>,
  qualifiersPerGroup: number,
): BracketMatch[] {
  const groupCount = groups.length

  const qualifiersByGroup: QualifierLabel[][] = groups.map((group, groupIndex) =>
    Array.from({ length: qualifiersPerGroup }, (_, rankIndex) => ({
      groupIndex,
      rank: rankIndex + 1,
      label: `${group.name}第 ${rankIndex + 1} 名`,
    })),
  )

  if (qualifiersPerGroup === 2 && groupCount > 1) {
    return Array.from({ length: groupCount }, (_, i) => {
      const mirrorGroupIndex = groupCount - 1 - i
      const home = qualifiersByGroup[i][0]
      const away = qualifiersByGroup[mirrorGroupIndex][1]

      return {
        id: `R1-M${i + 1}`,
        homeLabel: home.label,
        awayLabel: away.label,
      }
    })
  }

  const pool = qualifiersByGroup.flat().sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.groupIndex - b.groupIndex
  })

  const matches: BracketMatch[] = []
  const used = new Set<number>()

  const getNextUnused = () => pool.findIndex((_, index) => !used.has(index))

  while (used.size < pool.length) {
    const firstIndex = getNextUnused()
    if (firstIndex < 0) break

    used.add(firstIndex)
    const first = pool[firstIndex]

    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY

    for (let index = pool.length - 1; index >= 0; index -= 1) {
      if (used.has(index)) continue
      const candidate = pool[index]

      const score =
        (candidate.groupIndex !== first.groupIndex ? 1000 : 0) +
        candidate.rank * 10 +
        Math.abs(candidate.groupIndex - first.groupIndex)

      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }

    if (bestIndex < 0) {
      break
    }

    used.add(bestIndex)
    const second = pool[bestIndex]

    matches.push({
      id: `R1-M${matches.length + 1}`,
      homeLabel: first.label,
      awayLabel: second.label,
    })
  }

  return matches
}

export function generateGroupingPayload(
  format: CompetitionFormat,
  participants: SeedPlayer[],
  config: { groupCount: number; qualifiersPerGroup?: number; seedMethod?: GroupSeedMethod },
): GroupingPayload {
  const sorted = [...participants].sort((a, b) => b.eloRating - a.eloRating || b.points - a.points)
  const total = sorted.length

  if (config.groupCount < 1 || config.groupCount > total) {
    throw new Error('组数不合法。')
  }

  const seedMethod = config.seedMethod ?? 'min_diff'
  const groupPlayers =
    seedMethod === 'snake'
      ? snakeDistribute(sorted, config.groupCount)
      : distributeByMinSpread(sorted, config.groupCount)

  const groups = groupPlayers.map((players, index) => ({
    name: `第 ${index + 1} 组`,
    players,
    averagePoints: averageElo(players),
  }))

  const payload: GroupingPayload = {
    generatedAt: new Date().toISOString(),
    format,
    config: {
      ...config,
      seedMethod,
    },
    groups,
  }

  if (format === 'group_then_knockout') {
    const qualifiersPerGroup = config.qualifiersPerGroup ?? 1
    const totalQualified = qualifiersPerGroup * config.groupCount

    if (!isPowerOfTwo(totalQualified)) {
      throw new Error('组数×每组晋级人数必须为 2 的次幂。')
    }

    const hasEnoughPerGroup = groups.every((group) => group.players.length >= qualifiersPerGroup)
    if (!hasEnoughPerGroup) {
      throw new Error('存在小组人数小于设定晋级人数，请调小组数或晋级人数。')
    }

    const firstRoundMatches = buildFirstRoundMatches(groups, qualifiersPerGroup)

    payload.knockout = {
      stage:
        totalQualified <= 2
          ? '决赛'
          : totalQualified <= 4
            ? '半决赛'
            : totalQualified <= 8
              ? '1/4 决赛'
              : '淘汰赛首轮',
      bracketSize: totalQualified,
      rounds: buildBracketRounds(firstRoundMatches, totalQualified),
    }
  }

  return payload
}
