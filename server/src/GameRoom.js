import CANNON from 'cannon'
import { PhysicsWorld } from './PhysicsWorld.js'
import { NETWORK, SPAWN_GRID } from '../../shared/constants.js'

const { tickRate, physicsRate, maxPlayers } = NETWORK
const TEAM_MAX_PLAYERS = 8

export class GameRoom {
  constructor(io) {
    this.io      = io
    this.physics = new PhysicsWorld()
    this.players = new Map() // socketId → { id, name, carColor, actions }
    this.teamScores = { red: 0, blue: 0 }

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

  _getTeamState() {
    const players = this._playersForMode('team-combat')
    const makeRoster = team => players
      .filter(player => player.team === team)
      .map(({ id, name, kills = 0, deaths = 0 }) => ({ id, name, kills, deaths, team }))

    return {
      red: { score: this.teamScores.red, players: makeRoster('red') },
      blue: { score: this.teamScores.blue, players: makeRoster('blue') },
    }
  }

  _broadcastTeamState() {
    this.io.to('team-combat').emit('team:state', this._getTeamState())
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
          this.io.to(gameMode).emit('combat:meteor', {
            x: (Math.random() - 0.5) * SPAWN_RANGE * 2,
            y: (Math.random() - 0.5) * SPAWN_RANGE * 2,
            t: Date.now(),
          })
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

      socket.on('player:join', ({ name, carColor, carType, gameMode: requestedMode }) => {
        if (this.players.has(socket.id)) return

        const gameMode = ['race', 'combat', 'team-combat'].includes(requestedMode)
          ? requestedMode
          : 'combat'
        const modePlayers = this._playersForMode(gameMode)
        const modeLimit = gameMode === 'team-combat' ? TEAM_MAX_PLAYERS : maxPlayers
        if (modePlayers.length >= modeLimit) {
          socket.emit('room:full')
          return
        }

        const team = gameMode === 'team-combat' ? this._assignTeam() : null
        const spawnPos = this._getSpawnPosition(gameMode)
        socket.join(gameMode)
        this.physics.addCar(socket.id, spawnPos)

        this.players.set(socket.id, {
          id:       socket.id,
          name:     name || 'Anonymous',
          carColor: carColor ?? 0,
          carType:  carType || 'default',
          gameMode,
          team,
          actions:  { up: false, down: false, left: false, right: false, brake: false, boost: false, steer: 0, throttle: 0 },
          spawnXY:  { x: spawnPos.x, y: spawnPos.y },
          kills:    0,
          deaths:   0,
          lastDamagedBy: null,
          lastDamagedAt: 0,
          lastDeathAt: 0,
        })

        // Send existing players to new joiner
        const existingPlayers = [...this.players.values()]
          .filter(p => p.id !== socket.id && p.gameMode === gameMode)
          .map(({ id, name, carColor, carType, team }) => ({ id, name, carColor, carType, team }))

        // Include spawn position so client can initialise the local car at the same spot
        socket.emit('room:joined', {
          id: socket.id,
          existingPlayers,
          spawnPos: { x: spawnPos.x, y: spawnPos.y },
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
        })

        this._broadcastCombatLeaderboard(gameMode)
        if (gameMode === 'team-combat') this._broadcastTeamState()

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
        if (!player) return
        console.log(`[combat] missile from ${socket.id}`, data)
        socket.to(player.gameMode).emit('combat:missile', { fromId: socket.id, ...data })
      })

      socket.on('player:combatDamage', ({ targetId, amount }) => {
        console.log(`[combat] damage from ${socket.id} → ${targetId} (${amount}hp)`)
        const targetSocket = this.io.sockets.sockets.get(targetId)
        const attacker = this.players.get(socket.id)
        const target = this.players.get(targetId)
        const sameMode = attacker && target && attacker.gameMode === target.gameMode
        const friendlyFire = sameMode && attacker.gameMode === 'team-combat' && attacker.team === target.team
        const validAmount = Number.isFinite(amount) && amount > 0 ? Math.min(amount, 100) : 0
        if (targetSocket && sameMode && !friendlyFire && targetId !== socket.id && validAmount > 0) {
          target.lastDamagedBy = socket.id
          target.lastDamagedAt = Date.now()
          targetSocket.emit('player:combatDamage', { fromId: socket.id, amount: validAmount })
        }
      })

      socket.on('combat:explosion', (data) => {
        const player = this.players.get(socket.id)
        if (!player) return
        // Broadcast explosion position to all other players
        socket.to(player.gameMode).emit('combat:explosion', { fromId: socket.id, ...data })
      })

      socket.on('combat:carDestroyed', (data) => {
        const victim = this.players.get(socket.id)
        if (!victim) return
        console.log(`[combat] car destroyed: ${socket.id}`)
        socket.to(victim.gameMode).emit('combat:carDestroyed', { fromId: socket.id, ...data })

        const now = Date.now()
        if (now - victim.lastDeathAt < 2500) return

        victim.lastDeathAt = now
        victim.deaths += 1

        const killer = this.players.get(victim.lastDamagedBy)
        if (killer && killer.id !== victim.id && killer.gameMode === victim.gameMode && now - victim.lastDamagedAt <= 2000) {
          killer.kills += 1
          if (victim.gameMode === 'team-combat' && killer.team && killer.team !== victim.team) {
            this.teamScores[killer.team] += 1
          }
          this.io.to(victim.gameMode).emit('combat:kill', {
            killerId: killer.id,
            killerName: killer.name,
            killerTeam: killer.team,
            victimId: victim.id,
            victimName: victim.name,
            victimTeam: victim.team,
            kills: killer.kills,
          })
        }

        victim.lastDamagedBy = null
        victim.lastDamagedAt = 0
        this._broadcastCombatLeaderboard(victim.gameMode)
        if (victim.gameMode === 'team-combat') this._broadcastTeamState()
      })

      socket.on('player:snapshot', (state) => {
        // Client sends its own authoritative physics state.
        // We cache it and use it in world:snapshot broadcasts so that remote
        // players see exactly the same thing as the local player.
        const player = this.players.get(socket.id)
        if (player) player.clientSnapshot = state
      })

      socket.on('disconnect', () => {
        this.physics.removeCar(socket.id)
        const player = this.players.get(socket.id)
        this.players.delete(socket.id)
        if (player) {
          this.io.to(player.gameMode).emit('player:left', { id: socket.id })
          this._broadcastCombatLeaderboard(player.gameMode)
          if (player.gameMode === 'team-combat') {
            if (this._playersForMode('team-combat').length === 0) {
              this.teamScores.red = 0
              this.teamScores.blue = 0
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
          if (player.clientSnapshot) {
            if (!carsByMode.has(player.gameMode)) carsByMode.set(player.gameMode, [])
            carsByMode.get(player.gameMode).push({ id, ...player.clientSnapshot })
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
