import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DEFAULT_FILE = fileURLToPath(new URL('../data/player-stats.json', import.meta.url))

export class PlayerStatsStore {
  constructor(filePath = process.env.PLAYER_STATS_FILE || DEFAULT_FILE) {
    this.filePath = filePath
    this.players = new Map()
    this._load()
  }

  _key(name) {
    return String(name || 'Anonymous').trim().toLocaleLowerCase()
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      for (const item of Array.isArray(parsed.players) ? parsed.players : []) {
        this.players.set(this._key(item.name), item)
      }
    } catch (error) {
      console.warn('[stats] could not load player history:', error.message)
    }
  }

  recordMatch(player, { won, mvp }) {
    if (!player || player.isBot) return
    const key = this._key(player.name)
    const current = this.players.get(key) || {
      name: player.name,
      matches: 0,
      wins: 0,
      losses: 0,
      kills: 0,
      deaths: 0,
      mvps: 0,
      winStreak: 0,
      bestWinStreak: 0,
      lastPlayedAt: 0,
    }
    current.name = player.name
    current.matches += 1
    current.kills += player.kills || 0
    current.deaths += player.deaths || 0
    current.mvps += mvp ? 1 : 0
    current.lastPlayedAt = Date.now()
    if (won) {
      current.wins += 1
      current.winStreak += 1
      current.bestWinStreak = Math.max(current.bestWinStreak, current.winStreak)
    } else {
      current.losses += 1
      current.winStreak = 0
    }
    this.players.set(key, current)
    this._save()
  }

  leaderboard(limit = 12) {
    return [...this.players.values()]
      .sort((a, b) => b.wins - a.wins || b.mvps - a.mvps || b.kills - a.kills || a.deaths - b.deaths)
      .slice(0, limit)
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, players: this.leaderboard(1000) }, null, 2))
      fs.renameSync(tempPath, this.filePath)
    } catch (error) {
      console.warn('[stats] could not save player history:', error.message)
    }
  }
}
