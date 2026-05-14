export interface Match {
  id: string
  title: string
  description: string
  date: string
  location: string
  type: 'single' | 'double' | 'team'
  status: 'registration' | 'ongoing' | 'finished'
  participants: User[]
  createdBy: string
  createdAt: string
}

export interface User {
  id: string
  username: string
  nickname: string
  avatar: string
  points: number
  eloRating: number
}

export interface Ranking {
  rank: number
  user: User
  wins: number
  losses: number
  winRate: number
}