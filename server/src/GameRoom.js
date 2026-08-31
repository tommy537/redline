import CANNON from 'cannon'
import { PhysicsWorld } from './PhysicsWorld.js'
import { PlayerStatsStore } from './PlayerStatsStore.js'
import { NETWORK, SPAWN_GRID } from '../../shared/constants.js'

const { tickRate, physicsRate, maxPlayers } = NETWORK
const TEAM_MAX_PLAYERS = 8
const TEAM_SIZE = 4
const TEAM_MATCH_MS = 3 * 60 * 1000
const TEAM_COUNTDOWN_MS = 3000
const COMBAT_RESPAWN_MS = 4000
const METEOR_FALL_MS = 2200
const METEOR_DAMAGE = 30
const METEOR_RADIUS = 5.5
const CAR_COLORS_HEX = [0xff3333, 0x3366ff, 0x33cc66, 0xff8833, 0xaa44ff, 0x33cccc, 0xff66aa, 0xeeeeee]
const TEAM_BALANCE = {
  maxDamage: 30,
  handicap: { easy: 0.70, normal: 1, pro: 1.15 },
  catchUpThreshold: 2,
  catchUpDamage: 1.15,
  maxBotsPerTeam: 2,
}
const BOT_OBSTACLES = [
  { x: 0, y: 0, r: 11 }, { x: 28, y: 28, r: 10 },
  { x: -28, y: 29, r: 8 }, { x: 28, y: -28, r: 7 }, { x: -28, y: -28, r: 7 },
]
const ARENA_PICKUPS = [
  { x: 0, y: 0, type: 'health', value: 50 }, { x: 28, y: 28, type: 'health', value: 35 },
  { x: 24, y: 32, type: 'ammo', value: 6 }, { x: -28, y: 35, type: 'ammo', value: 6 },
  { x: 28, y: -36, type: 'ammo', value: 6 }, { x: -28, y: -28, type: 'ammo', value: 6 },
  { x: 0, y: -28, type: 'health', value: 30 }, { x: 12, y: -10, type: 'health', value: 30 },
  { x: -12, y: 10, type: 'health', value: 30 },
]
const TEAM_SPAWNS = {
  red:  [{ x: -18, y: -40 }, { x: -6, y: -40 }, { x: 6, y: -40 }, { x: 18, y: -40 }],
  blue: [{ x: 18, y: 40 }, { x: 6, y: 40 }, { x: -6, y: 40 }, { x: -18, y: 40 }],
}

export class GameRoom {
  constructor(io) {
    this.io      = io
    this.physics = new PhysicsWorld()
    this.players = new Map() // socketId → { id, name, carColor, actions }
    this.teamScores = { red: 0, blue: 0 }
    this.teamMatch = { state: 'waiting', startsAt: 0, endsAt: 0, winner: null, suddenDeath: false }
    this._botCounter = 0
    this.teamHostId = null
    this.statsStore = new PlayerStatsStore()
    this._lastHealingTick = 0

    this._startLoop()
    this._setupSocketEvents()
    this._startMeteorShower()
  }

  _playersForMode(gameMode) {
    return [...this.players.values()].filter(player => player.gameMode === gameMode)
  }

  _getCombatLeaderboard(gameMode) {
    return this._playersForMode(gameMode)
      .map(({ id, name, kills = 0, deaths = 0 }) => ({ id, name, kills, deaths }))
      .sort((a, b) =>
        b.kills - a.kills ||
        a.deaths - b.deaths ||
        a.name.localeCompare(b.name)
      )
  }

  _broadcastCombatLeaderboard(gameMode) {
    if (gameMode !== 'combat' && gameMode !== 'team-combat') return
    this.io.to(gameMode).emit('combat:leaderboard', {
      players: this._getCombatLeaderboard(gameMode),
    })
  }

  _assignTeam() {
    const teamPlayers = this._playersForMode('team-combat')
    const redCount = teamPlayers.filter(player => player.team === 'red').length
    const blueCount = teamPlayers.filter(player => player.team === 'blue').length
    return redCount <= blueCount ? 'red' : 'blue'
  }

  _teamCount(team) {
    return this._playersForMode('team-combat').filter(player => player.team === team).length
  }

  _humanTeamPlayers() {
    return this._playersForMode('team-combat').filter(player => !player.isBot)
  }

  _assignHost() {
    const humans = this._humanTeamPlayers().sort((a, b) => a.joinedAt - b.joinedAt)
    this.teamHostId = humans[0]?.id || null
  }

  _teamSpawn(team) {
    const slots = TEAM_SPAWNS[team]
    const slot = this._teamCount(team) % slots.length
    return { ...slots[slot], z: 12, _index: slot }
  }

  _getTeamState() {
    const players = this._playersForMode('team-combat')
    const makeRoster = team => players
      .filter(player => player.team === team)
      .map(({ id, name, kills = 0, deaths = 0, isBot = false, handicap = 'normal', stats = {}, matchReady = false }) =>
        ({ id, name, kills, deaths, team, isBot, handicap, stats, matchReady, isHost: id === this.teamHostId }))

    const catchUpTeam = Math.abs(this.teamScores.red - this.teamScores.blue) >= TEAM_BALANCE.catchUpThreshold
      ? (this.teamScores.red < this.teamScores.blue ? 'red' : 'blue')
      : null

    return {
      red: { score: this.teamScores.red, players: makeRoster('red') },
      blue: { score: this.teamScores.blue, players: makeRoster('blue') },
      match: { ...this.teamMatch, serverNow: Date.now() },
      hostId: this.teamHostId,
      canStart: this._canStartTeamMatch(),
      balance: { catchUpThreshold: TEAM_BALANCE.catchUpThreshold, catchUpDamage: TEAM_BALANCE.catchUpDamage },
      catchUpTeam,
      funStats: this._getFunStats(players),
      history: this.statsStore.leaderboard(),
    }
  }

  _getFunStats(players = this._playersForMode('team-combat')) {
    const ranked = key => [...players].sort((a, b) => (b.stats?.[key] || 0) - (a.stats?.[key] || 0))[0]
    const mvp = [...players].sort((a, b) => (b.kills || 0) - (a.kills || 0))[0]
    return {
      mvp: mvp ? { name: mvp.name, value: mvp.kills || 0 } : null,
      sharpShooter: ranked('hits') ? { name: ranked('hits').name, value: ranked('hits').stats?.hits || 0 } : null,
      bumper: ranked('bumps') ? { name: ranked('bumps').name, value: ranked('bumps').stats?.bumps || 0 } : null,
    }
  }

  _maybeStartTeamMatch() {
    if (this.teamMatch.state !== 'waiting') return
    if (!this._canStartTeamMatch()) return
    const startsAt = Date.now() + TEAM_COUNTDOWN_MS
    this.teamMatch = { state: 'countdown', startsAt, endsAt: startsAt + TEAM_MATCH_MS, winner: null, suddenDeath: false }
    this._broadcastTeamState()
  }

  _canStartTeamMatch() {
    if (this.teamMatch.state !== 'waiting') return false
    const humans = this._humanTeamPlayers()
    return humans.length > 0 &&
      this._teamCount('red') > 0 && this._teamCount('blue') > 0 &&
      humans.every(player => player.matchReady)
  }

  _updateTeamMatch(now) {
    if (this.teamMatch.state === 'countdown' && now >= this.teamMatch.startsAt) {
      this.teamMatch.state = 'playing'
      this._broadcastTeamState()
    }
    if (this.teamMatch.state === 'playing' && now >= this.teamMatch.endsAt) {
      if (this.teamScores.red === this.teamScores.blue) {
        this.teamMatch.state = 'sudden-death'
        this.teamMatch.suddenDeath = true
      } else {
        this._finishTeamMatch(this.teamScores.red > this.teamScores.blue ? 'red' : 'blue')
      }
      this._broadcastTeamState()
    }
  }

  _finishTeamMatch(winner) {
    if (this.teamMatch.state === 'complete') return
    this.teamMatch.state = 'complete'
    this.teamMatch.winner = winner
    this.teamMatch.suddenDeath = false
    const humans = this._humanTeamPlayers()
    const mvp = [...humans].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0]
    for (const player of humans) {
      this.statsStore.recordMatch(player, { won: player.team === winner, mvp: player.id === mvp?.id })
    }
  }

  _resetTeamMatch() {
    this.teamScores = { red: 0, blue: 0 }
    for (const player of this._playersForMode('team-combat')) {
      player.kills = 0
      player.deaths = 0
      player.stats = { shots: 0, hits: 0, damage: 0, bumps: 0 }
      player.hp = 100
      player.dead = false
      if (!player.isBot) player.matchReady = false
    }
    this.teamMatch = { state: 'waiting', startsAt: 0, endsAt: 0, winner: null, suddenDeath: false }
    this._broadcastCombatLeaderboard('team-combat')
    this._maybeStartTeamMatch()
    this._broadcastTeamState()
  }

  _addBot(team) {
    const teamBots = this._playersForMode('team-combat').filter(player => player.team === team && player.isBot)
    if (this._teamCount(team) >= TEAM_SIZE || teamBots.length >= TEAM_BALANCE.maxBotsPerTeam) return
    const id = `bot-${++this._botCounter}`
    const spawnPos = this._teamSpawn(team)
    this.physics.addCar(id, spawnPos)
    const player = {
      id, name: `BOT ${team.toUpperCase()} ${this._teamCount(team) + 1}`, carColor: team === 'red' ? 0 : 1,
      carType: 'default', gameMode: 'team-combat', team, isBot: true, handicap: 'normal', hp: 100,
      actions: { up: true, down: false, left: false, right: false, brake: false, boost: false, steer: 0, throttle: 0.75 },
      spawnXY: { x: spawnPos.x, y: spawnPos.y }, kills: 0, deaths: 0, stats: { shots: 0, hits: 0, damage: 0, bumps: 0 },
      lastDamagedBy: null, lastDamagedAt: 0, lastDeathAt: 0,
      nextShotAt: Date.now() + 1800 + Math.random() * 1200,
      matchReady: true,
      ammo: 10,
      aiLastPosition: { x: spawnPos.x, y: spawnPos.y },
      aiLastMovedAt: Date.now(),
      aiUnstuckUntil: 0,
      pickupCooldownUntil: 0,
    }
    this.players.set(id, player)
    this.io.to('team-combat').emit('player:joined', { id, name: player.name, carColor: player.carColor, carType: 'default', team, isBot: true })
  }

  _fillFamilyBots() {
    while (this._teamCount('red') < 2) this._addBot('red')
    while (this._teamCount('blue') < 2) this._addBot('blue')
  }

  _updateBots(now) {
    if (!['playing', 'sudden-death'].includes(this.teamMatch.state)) return
    for (const bot of this._playersForMode('team-combat').filter(player => player.isBot)) {
      this._steerBot(bot)
      if (now < bot.nextShotAt) continue
      bot.nextShotAt = now + 1800 + Math.random() * 900
      if (bot.dead || bot.ammo <= 0) continue
      const botCar = this.physics.cars.get(bot.id)
      if (!botCar) continue
      const from = botCar.chassis.position
      const enemies = this._playersForMode('team-combat')
        .filter(player => player.team !== bot.team && !player.dead)
        .map(player => ({ player, position: this._playerPosition(player) }))
        .filter(item => item.position && this._hasLineOfSight(from, item.position))
        .sort((a, b) => Math.hypot(a.position.x - from.x, a.position.y - from.y) - Math.hypot(b.position.x - from.x, b.position.y - from.y))
      const target = enemies[0]?.player
      if (!target) continue
      const to = enemies[0].position
      const dx = to.x - from.x
      const dy = to.y - from.y
      const distance = Math.hypot(dx, dy)
      if (distance > 48 || distance < 1) continue
      bot.stats.shots += 1
      bot.ammo -= 1
      const handicapScale = TEAM_BALANCE.handicap[target.handicap] || 1
      const catchUp = Math.abs(this.teamScores.red - this.teamScores.blue) >= TEAM_BALANCE.catchUpThreshold && this.teamScores[bot.team] < this.teamScores[target.team]
      const amount = Math.round(12 * handicapScale * (catchUp ? TEAM_BALANCE.catchUpDamage : 1) * 10) / 10
      target.lastDamagedBy = bot.id
      target.lastDamagedAt = now
      this.io.to('team-combat').emit('combat:missile', {
        fromId: bot.id, x: from.x, y: from.y, z: from.z + 0.8, dx: dx / distance, dy: dy / distance,
      })
      this._applyDamage(bot, target, amount)
    }
  }

  _hasLineOfSight(from, to) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const lengthSq = dx * dx + dy * dy || 1
    for (const obstacle of BOT_OBSTACLES) {
      const t = Math.max(0, Math.min(1, ((obstacle.x - from.x) * dx + (obstacle.y - from.y) * dy) / lengthSq))
      const px = from.x + dx * t
      const py = from.y + dy * t
      if (Math.hypot(px - obstacle.x, py - obstacle.y) < obstacle.r * 0.78) return false
    }
    return true
  }

  _steerBot(bot) {
    const car = this.physics.cars.get(bot.id)
    if (!car) return
    const pos = car.chassis.position
    const now = Date.now()
    if (bot.dead) {
      bot.actions.throttle = 0
      bot.actions.brake = true
      return
    }
    if (Math.abs(pos.x) > 48 || Math.abs(pos.y) > 48) {
      pos.x = Math.max(-42, Math.min(42, pos.x))
      pos.y = Math.max(-42, Math.min(42, pos.y))
      car.chassis.velocity.set(0, 0, 0)
      car.chassis.angularVelocity.set(0, 0, 0)
      car.chassis.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.atan2(-pos.y, -pos.x))
    }

    const moved = Math.hypot(pos.x - bot.aiLastPosition.x, pos.y - bot.aiLastPosition.y)
    if (moved > 0.8) {
      bot.aiLastPosition = { x: pos.x, y: pos.y }
      bot.aiLastMovedAt = now
    } else if (now - bot.aiLastMovedAt > 2500 && now > bot.aiUnstuckUntil) {
      bot.aiUnstuckUntil = now + 1300
      bot.aiLastMovedAt = now
    }
    if (now < bot.aiUnstuckUntil) {
      bot.actions.steer = bot.id.charCodeAt(bot.id.length - 1) % 2 ? 1 : -1
      bot.actions.throttle = -0.55
      bot.actions.brake = false
      return
    }

    let target = null
    let targetPickup = null
    const wantedType = bot.hp < 55 ? 'health' : bot.ammo <= 2 ? 'ammo' : null
    if (wantedType) {
      const candidates = ARENA_PICKUPS.filter(item => item.type === wantedType)
      if (wantedType === 'health') candidates.push({ x: 0, y: -32, type: 'health', value: 8, zone: true })
      candidates.sort((a, b) => Math.hypot(a.x - pos.x, a.y - pos.y) - Math.hypot(b.x - pos.x, b.y - pos.y))
      targetPickup = candidates[0] || null
      target = targetPickup
    }
    if (!target) {
      const enemies = this._playersForMode('team-combat').filter(player => player.team !== bot.team && !player.dead)
      enemies.sort((a, b) => {
        const ap = this._playerPosition(a)
        const bp = this._playerPosition(b)
        return (ap ? Math.hypot(ap.x - pos.x, ap.y - pos.y) : 999) - (bp ? Math.hypot(bp.x - pos.x, bp.y - pos.y) : 999)
      })
      const enemyPos = enemies[0] && this._playerPosition(enemies[0])
      if (enemyPos) target = { x: enemyPos.x, y: enemyPos.y }
    }
    if (!target) target = { x: 0, y: 0 }

    let vx = target.x - pos.x
    let vy = target.y - pos.y
    if (targetPickup && Math.hypot(targetPickup.x - pos.x, targetPickup.y - pos.y) < 3 && now >= bot.pickupCooldownUntil) {
      if (targetPickup.type === 'health') this._healPlayer(bot, targetPickup.value)
      else bot.ammo = Math.min(20, bot.ammo + targetPickup.value)
      bot.pickupCooldownUntil = now + (targetPickup.zone ? 1000 : 8000)
    }
    for (const obstacle of BOT_OBSTACLES) {
      const ox = pos.x - obstacle.x
      const oy = pos.y - obstacle.y
      const distance = Math.hypot(ox, oy)
      if (distance < obstacle.r && distance > 0.1) {
        const force = (obstacle.r - distance) * 4
        vx += ox / distance * force
        vy += oy / distance * force
      }
    }
    if (Math.abs(pos.x) > 43 || Math.abs(pos.y) > 43) {
      vx = -pos.x * 2
      vy = -pos.y * 2
    }
    const forward = car.chassis.quaternion.vmult(new CANNON.Vec3(1, 0, 0))
    const desiredLength = Math.hypot(vx, vy) || 1
    const desiredX = vx / desiredLength
    const desiredY = vy / desiredLength
    const cross = forward.x * desiredY - forward.y * desiredX
    const dot = Math.max(-1, Math.min(1, forward.x * desiredX + forward.y * desiredY))
    const angle = Math.atan2(cross, dot)
    bot.actions.steer = Math.max(-1, Math.min(1, -angle * 1.4))
    bot.actions.throttle = Math.abs(angle) > 1.8 ? 0.3 : 0.82
    bot.actions.brake = Math.abs(angle) > 2.5
  }

  _scoreTeamKill(killer) {
    this.teamScores[killer.team] += 1
    if (this.teamMatch.state === 'sudden-death') this._finishTeamMatch(killer.team)
  }

  _playerPosition(player) {
    const snapshot = player?.clientSnapshot
    if (Array.isArray(snapshot?.pos)) return { x: snapshot.pos[0], y: snapshot.pos[1], z: snapshot.pos[2] || 0 }
    const position = this.physics.cars.get(player?.id)?.chassis?.position
    return position ? { x: position.x, y: position.y, z: position.z } : null
  }

  _applyDamage(attacker, target, amount) {
    if (!target || target.dead || !Number.isFinite(amount) || amount <= 0) return false
    target.hp = Math.max(0, Math.round((target.hp - amount) * 10) / 10)
    if (attacker?.stats) {
      attacker.stats.hits += 1
      attacker.stats.damage += amount
    }
    const targetSocket = this.io.sockets.sockets.get(target.id)
    targetSocket?.emit('player:combatDamage', { fromId: attacker?.id || null, amount, hp: target.hp })
    this.io.to(target.gameMode).emit('combat:health', { id: target.id, hp: target.hp })
    if (target.hp <= 0) this._handlePlayerDeath(target, attacker)
    return true
  }

  _healPlayer(player, amount) {
    if (!player || player.dead || player.hp >= 100 || !Number.isFinite(amount) || amount <= 0) return
    const previous = player.hp
    player.hp = Math.min(100, Math.round((player.hp + amount) * 10) / 10)
    const healed = player.hp - previous
    this.io.sockets.sockets.get(player.id)?.emit('player:combatHealth', { hp: player.hp, amount: healed })
    this.io.to(player.gameMode).emit('combat:health', { id: player.id, hp: player.hp })
  }

  _handlePlayerDeath(victim, killer) {
    if (!victim || victim.dead) return
    victim.dead = true
    victim.hp = 0
    victim.lastDeathAt = Date.now()
    victim.deaths += 1

    const position = this._playerPosition(victim) || { x: victim.spawnXY.x, y: victim.spawnXY.y, z: 0 }
    const velocity = victim.clientSnapshot?.vel || [0, 0, 0]
    this.io.to(victim.gameMode).emit('combat:carDestroyed', {
      fromId: victim.id, x: position.x, y: position.y, z: position.z,
      vx: velocity[0] || 0, vy: velocity[1] || 0, color: CAR_COLORS_HEX[victim.carColor] || CAR_COLORS_HEX[0],
    })

    const validKiller = killer && killer.id !== victim.id && killer.gameMode === victim.gameMode
    if (validKiller) {
      killer.kills += 1
      if (victim.gameMode === 'team-combat' && killer.team !== victim.team) this._scoreTeamKill(killer)
      this.io.to(victim.gameMode).emit('combat:kill', {
        killerId: killer.id, killerName: killer.name, killerTeam: killer.team,
        victimId: victim.id, victimName: victim.name, victimTeam: victim.team, kills: killer.kills,
      })
    }

    victim.lastDamagedBy = null
    victim.lastDamagedAt = 0
    this._broadcastCombatLeaderboard(victim.gameMode)
    if (victim.gameMode === 'team-combat') this._broadcastTeamState()

    setTimeout(() => {
      if (!this.players.has(victim.id)) return
      victim.dead = false
      victim.hp = 100
      const car = this.physics.cars.get(victim.id)
      if (car) {
        car.chassis.position.set(victim.spawnXY.x, victim.spawnXY.y, 3)
        car.chassis.velocity.set(0, 0, 0)
        car.chassis.angularVelocity.set(0, 0, 0)
      }
      this.io.sockets.sockets.get(victim.id)?.emit('player:combatRespawn', { hp: 100, spawnPos: victim.spawnXY })
      this.io.to(victim.gameMode).emit('combat:carRespawn', { id: victim.id, hp: 100 })
    }, COMBAT_RESPAWN_MS)
  }

  _damageBot(bot, attacker, amount) {
    if (!['playing', 'sudden-death'].includes(this.teamMatch.state)) return
    this._applyDamage(attacker, bot, amount)
  }

  _broadcastTeamState() {
    this.io.to('team-combat').emit('team:state', this._getTeamState())
  }

  _impactMeteor(gameMode, x, y) {
    for (const player of this._playersForMode(gameMode)) {
      if (player.dead) continue
      const position = this._playerPosition(player)
      if (!position || position.z >= 4 || Math.hypot(position.x - x, position.y - y) >= METEOR_RADIUS) continue
      const matchActive = gameMode !== 'team-combat' || ['playing', 'sudden-death'].includes(this.teamMatch.state)
      if (matchActive) this._applyDamage(null, player, METEOR_DAMAGE)
    }
  }

  _updateHealingZones(now) {
    if (now - this._lastHealingTick < 250) return
    this._lastHealingTick = now
    for (const player of this.players.values()) {
      if (player.dead || player.hp >= 100 || (player.gameMode !== 'combat' && player.gameMode !== 'team-combat')) continue
      if (player.gameMode === 'team-combat' && !['playing', 'sudden-death'].includes(this.teamMatch.state)) continue
      const position = this._playerPosition(player)
      if (position && position.z < 2 && Math.hypot(position.x, position.y + 32) < 4) this._healPlayer(player, 2)
    }
  }

  // Server-driven meteor shower so all players see the same impacts.
  // Skips emit when nobody is connected to save bandwidth.
  _startMeteorShower() {
    const SPAWN_RANGE = 38
    const tick = () => {
      const delay = 250 + Math.random() * 350   // 250–600ms (avg ~425ms)
      setTimeout(() => {
        const activeModes = new Set(
          [...this.players.values()]
            .map(player => player.gameMode)
            .filter(mode => mode === 'combat' || mode === 'team-combat')
        )
        for (const gameMode of activeModes) {
          const x = (Math.random() - 0.5) * SPAWN_RANGE * 2
          const y = (Math.random() - 0.5) * SPAWN_RANGE * 2
          this.io.to(gameMode).emit('combat:meteor', { x, y, t: Date.now() })
          setTimeout(() => this._impactMeteor(gameMode, x, y), METEOR_FALL_MS)
        }
        tick()
      }, delay)
    }
    tick()
  }

  _setupSocketEvents() {
    this.io.on('connection', (socket) => {
      console.log(`[+] ${socket.id}`)

      socket.on('ping', (cb) => {
        // Return the server's current epoch time so clients can compute
        // (clock skew + half RTT) and align interpolation timestamps
        if(typeof cb === 'function') cb(Date.now())
      })

      socket.on('player:join', ({ name, carColor, carType, gameMode: requestedMode, preferredTeam, handicap, fillBots }) => {
        if (this.players.has(socket.id)) return

        const gameMode = ['race', 'combat', 'team-combat'].includes(requestedMode)
          ? requestedMode
          : 'combat'
        const modePlayers = this._playersForMode(gameMode)
        const modeLimit = gameMode === 'team-combat' ? TEAM_MAX_PLAYERS : maxPlayers
        if (modePlayers.length >= modeLimit && gameMode !== 'team-combat') {
          socket.emit('room:full')
          return
        }

        const requestedTeam = preferredTeam === 'blue' ? 'blue' : 'red'
        if (gameMode === 'team-combat' && this._teamCount(requestedTeam) >= TEAM_SIZE) {
          const replaceableBot = this._playersForMode('team-combat').find(player => player.team === requestedTeam && player.isBot)
          if (replaceableBot) {
            this.physics.removeCar(replaceableBot.id)
            this.players.delete(replaceableBot.id)
            this.io.to('team-combat').emit('player:left', { id: replaceableBot.id })
          } else {
            socket.emit('team:full', { team: requestedTeam })
            return
          }
        }
        const team = gameMode === 'team-combat' ? requestedTeam : null
        const spawnPos = team ? this._teamSpawn(team) : this._getSpawnPosition(gameMode)
        socket.join(gameMode)
        this.physics.addCar(socket.id, spawnPos)

        this.players.set(socket.id, {
          id:       socket.id,
          name:     name || 'Anonymous',
          carColor: carColor ?? 0,
          carType:  carType || 'default',
          gameMode,
          team,
          handicap: ['easy', 'normal', 'pro'].includes(handicap) ? handicap : 'normal',
          isBot: false,
          joinedAt: Date.now(),
          matchReady: false,
          hp: 100,
          dead: false,
          stats: { shots: 0, hits: 0, damage: 0, bumps: 0 },
          actions:  { up: false, down: false, left: false, right: false, brake: false, boost: false, steer: 0, throttle: 0 },
          spawnXY:  { x: spawnPos.x, y: spawnPos.y },
          kills:    0,
          deaths:   0,
          lastDamagedBy: null,
          lastDamagedAt: 0,
          lastDeathAt: 0,
          pickupCooldowns: {},
        })
        if (gameMode === 'team-combat' && !this.teamHostId) this.teamHostId = socket.id

        // Send existing players to new joiner
        const existingPlayers = [...this.players.values()]
          .filter(p => p.id !== socket.id && p.gameMode === gameMode)
          .map(({ id, name, carColor, carType, team, isBot }) => ({ id, name, carColor, carType, team, isBot }))

        // Include spawn position so client can initialise the local car at the same spot
        socket.emit('room:joined', {
          id: socket.id,
          existingPlayers,
          spawnPos: { x: spawnPos.x, y: spawnPos.y, _index: spawnPos._index },
          gameMode,
          team,
          teamState: gameMode === 'team-combat' ? this._getTeamState() : null,
        })

        // Notify everyone else
        socket.to(gameMode).emit('player:joined', {
          id: socket.id,
          name: name || 'Anonymous',
          carColor: carColor ?? 0,
          carType:  carType || 'default',
          team,
          isBot: false,
        })

        this._broadcastCombatLeaderboard(gameMode)
        if (gameMode === 'team-combat') {
          if (fillBots) this._fillFamilyBots()
          this._maybeStartTeamMatch()
          this._broadcastTeamState()
        }

        console.log(`[join] ${name} (${socket.id}) — ${gameMode}${team ? `/${team}` : ''}`)
      })

      socket.on('player:ready', () => {
        // Client reveal animation just started — reset server car to spawn z=12 so both fall together
        const car    = this.physics.cars.get(socket.id)
        const player = this.players.get(socket.id)
        if (car && player) {
          const { x, y } = player.spawnXY
          car.chassis.position.set(x, y, 12)
          car.chassis.velocity.set(0, 0, 0)
          car.chassis.angularVelocity.set(0, 0, 0)
          car.chassis.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), 0)
          console.log(`[ready] ${player.name} — car reset to (${x.toFixed(2)}, ${y.toFixed(2)}, 12)`)
        }
      })

      socket.on('player:input', (actions) => {
        const player = this.players.get(socket.id)
        if (player) player.actions = actions
      })

      socket.on('player:bump', ({ targetId, fromPos }) => {
        // Relay bump to the target player so their car reacts too
        const targetSocket = this.io.sockets.sockets.get(targetId)
        const source = this.players.get(socket.id)
        const target = this.players.get(targetId)
        if (source?.stats) source.stats.bumps += 1
        if (targetSocket && source && target && source.gameMode === target.gameMode) {
          targetSocket.emit('player:bumped', { fromId: socket.id, fromPos })
        }
      })

      socket.on('chat:message', ({ text }) => {
        const player = this.players.get(socket.id)
        if (!player || !text || typeof text !== 'string') return
        const clean = text.slice(0, 120).trim()
        if (!clean) return
        // Broadcast to everyone else
        socket.to(player.gameMode).emit('chat:message', {
          name: player.name,
          text: clean,
          color: player.carColor ?? 0,
        })
      })

      socket.on('combat:missile', (data) => {
        const player = this.players.get(socket.id)
        if (!player || player.dead) return
        if (player.stats) player.stats.shots += 1
        player.lastMissileAt = Date.now()
        console.log(`[combat] missile from ${socket.id}`, data)
        socket.to(player.gameMode).emit('combat:missile', { fromId: socket.id, ...data })
      })

      socket.on('player:combatDamage', ({ targetId, amount }) => {
        console.log(`[combat] damage from ${socket.id} → ${targetId} (${amount}hp)`)
        const attacker = this.players.get(socket.id)
        const target = this.players.get(targetId)
        const sameMode = attacker && target && attacker.gameMode === target.gameMode
        const friendlyFire = sameMode && attacker.gameMode === 'team-combat' && attacker.team === target.team
        const rawAmount = Number.isFinite(amount) && amount > 0 ? Math.min(amount, TEAM_BALANCE.maxDamage) : 0
        const handicapScale = TEAM_BALANCE.handicap[target?.handicap] || 1
        const catchUpTeam = Math.abs(this.teamScores.red - this.teamScores.blue) >= TEAM_BALANCE.catchUpThreshold
          ? (this.teamScores.red < this.teamScores.blue ? 'red' : 'blue') : null
        const catchUpScale = attacker?.team && attacker.team === catchUpTeam ? TEAM_BALANCE.catchUpDamage : 1
        const validAmount = Math.round(rawAmount * handicapScale * catchUpScale * 10) / 10
        const matchActive = attacker?.gameMode !== 'team-combat' || ['playing', 'sudden-death'].includes(this.teamMatch.state)
        const now = Date.now()
        const recentMissile = attacker && now - (attacker.lastMissileAt || 0) <= 4000
        const hitRateValid = attacker && now - (attacker.lastConfirmedHitAt || 0) >= 500
        const attackerPos = this._playerPosition(attacker)
        const targetPos = this._playerPosition(target)
        const inRange = attackerPos && targetPos && Math.hypot(attackerPos.x - targetPos.x, attackerPos.y - targetPos.y) <= 85
        if (sameMode && !friendlyFire && targetId !== socket.id && validAmount > 0 && matchActive && recentMissile && hitRateValid && inRange) {
          attacker.lastConfirmedHitAt = now
          target.lastDamagedBy = socket.id
          target.lastDamagedAt = now
          this._applyDamage(attacker, target, validAmount)
        }
      })

      socket.on('combat:explosion', (data) => {
        const player = this.players.get(socket.id)
        if (!player) return
        // Broadcast explosion position to all other players
        socket.to(player.gameMode).emit('combat:explosion', { fromId: socket.id, ...data })
      })

      socket.on('combat:pickup', ({ idx, type }) => {
        const player = this.players.get(socket.id)
        const pickup = ARENA_PICKUPS[idx]
        if (!player || player.dead || !pickup || pickup.type !== type) return
        const position = this._playerPosition(player)
        const now = Date.now()
        if (!position || Math.hypot(position.x - pickup.x, position.y - pickup.y) > 4) return
        if (now < (player.pickupCooldowns[idx] || 0)) return
        player.pickupCooldowns[idx] = now + 8500
        if (pickup.type === 'health') this._healPlayer(player, pickup.value)
      })

      socket.on('combat:carDestroyed', (data) => {
        // Legacy clients may still announce their own destruction. HP, death,
        // scoring and respawn are server-owned, so this event is intentionally ignored.
      })

      socket.on('player:snapshot', (state) => {
        // Client sends its own authoritative physics state.
        // We cache it and use it in world:snapshot broadcasts so that remote
        // players see exactly the same thing as the local player.
        const player = this.players.get(socket.id)
        if (player) player.clientSnapshot = state
      })

      socket.on('team:rematch', () => {
        const player = this.players.get(socket.id)
        if (player?.gameMode === 'team-combat' && this.teamMatch.state === 'complete') this._resetTeamMatch()
      })

      socket.on('team:setReady', ({ ready }) => {
        const player = this.players.get(socket.id)
        if (!player || player.gameMode !== 'team-combat' || this.teamMatch.state !== 'waiting') return
        player.matchReady = Boolean(ready)
        this._broadcastTeamState()
      })

      socket.on('team:startMatch', () => {
        const player = this.players.get(socket.id)
        if (!player || player.id !== this.teamHostId || player.gameMode !== 'team-combat') return
        if (!this._canStartTeamMatch()) {
          socket.emit('team:startDenied', { reason: 'Every human player must be ready and both teams need a player.' })
          return
        }
        this._maybeStartTeamMatch()
      })

      socket.on('disconnect', () => {
        this.physics.removeCar(socket.id)
        const player = this.players.get(socket.id)
        this.players.delete(socket.id)
        if (player) {
          this.io.to(player.gameMode).emit('player:left', { id: socket.id })
          this._broadcastCombatLeaderboard(player.gameMode)
          if (player.gameMode === 'team-combat') {
            if (player.id === this.teamHostId) this._assignHost()
            const humans = this._playersForMode('team-combat').filter(p => !p.isBot)
            if (humans.length === 0) {
              for (const bot of this._playersForMode('team-combat').filter(p => p.isBot)) {
                this.physics.removeCar(bot.id)
                this.players.delete(bot.id)
              }
              this.teamScores.red = 0
              this.teamScores.blue = 0
              this.teamMatch = { state: 'waiting', startsAt: 0, endsAt: 0, winner: null, suddenDeath: false }
            }
            this._broadcastTeamState()
          }
        }
        console.log(`[-] ${player?.name ?? socket.id} — ${this.players.size} online`)
      })
    })
  }

  _startLoop() {
    const physicsInterval  = 1000 / physicsRate
    const broadcastInterval = 1000 / tickRate
    let last             = Date.now()
    let broadcastAccum   = 0

    setInterval(() => {
      const now   = Date.now()
      const delta = (now - last) / 1000
      last = now
      this._updateTeamMatch(now)
      this._updateBots(now)
      this._updateHealingZones(now)

      // Apply inputs
      for (const [id, player] of this.players) {
        this.physics.applyInputs(id, player.actions)
      }

      // Step physics
      this.physics.step(delta)

      // Broadcast at tickRate — use client-reported snapshots so remote players
      // see exactly what the local player sees (same physics, no server divergence).
      broadcastAccum += delta * 1000
      if (broadcastAccum >= broadcastInterval) {
        broadcastAccum -= broadcastInterval
        const carsByMode = new Map()
        for (const [id, player] of this.players) {
          const state = player.clientSnapshot || (player.isBot ? this.physics.cars.get(id)?.getState() : null)
          if (state) {
            if (!carsByMode.has(player.gameMode)) carsByMode.set(player.gameMode, [])
            carsByMode.get(player.gameMode).push({ id, ...state })
          }
        }
        for (const [gameMode, cars] of carsByMode) {
          this.io.to(gameMode).emit('world:snapshot', { t: now, cars })
        }
      }
    }, physicsInterval)
  }

  _getSpawnPosition(gameMode) {
    // Assign grid slot based on current player count (wraps if full)
    const slot = this._playersForMode(gameMode).length % SPAWN_GRID.length
    const { x, y } = SPAWN_GRID[slot]
    return { x, y, z: 12 }
  }
}
