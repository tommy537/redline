import EventEmitter from '../Utils/EventEmitter.js'

const MAX_HP      = 100
const RESPAWN_MS  = 4000

export default class HealthSystem extends EventEmitter
{
    constructor(_options)
    {
        super()
        this.physics = _options.physics
        this.spawnPos = _options.spawnPos || { x: 5, y: -35 }
        this.authoritative = Boolean(_options.authoritative)
        this.hp      = MAX_HP
        this._dead   = false
    }

    takeDamage(amount, serverHp = null)
    {
        if(this._dead) return
        this.hp = Number.isFinite(serverHp) ? Math.max(0, serverHp) : Math.max(0, this.hp - amount)
        this.trigger('damage', [{ hp: this.hp, amount }])
        if(this.hp <= 0) this._die()
    }

    heal(amount)
    {
        if(this._dead) return
        this.hp = Math.min(MAX_HP, this.hp + amount)
        this.trigger('healed', [{ hp: this.hp }])
    }

    syncHealth(hp, amount = 0)
    {
        if(this._dead || !Number.isFinite(hp)) return
        this.hp = Math.max(0, Math.min(MAX_HP, hp))
        this.trigger('healed', [{ hp: this.hp, amount }])
    }

    isDead() { return this._dead }
    getRespawnSeconds() { return Math.ceil(RESPAWN_MS / 1000) }

    _die()
    {
        this._dead = true
        this.trigger('death', [])
        if(!this.authoritative) setTimeout(() => this._respawn(), RESPAWN_MS)
    }

    _respawn()
    {
        this._dead = false
        this.hp    = MAX_HP

        const body = this.physics.car.chassis.body
        body.sleep()
        body.position.set(this.spawnPos.x, this.spawnPos.y, 12)
        body.quaternion.set(0, 0, 0, 1)
        body.velocity.set(0, 0, 0)
        body.angularVelocity.set(0, 0, 0)
        body.wakeUp()

        this.trigger('respawn', [{ hp: this.hp }])
    }

    respawnFromServer(spawnPos = this.spawnPos, hp = MAX_HP)
    {
        this.spawnPos = spawnPos || this.spawnPos
        this._dead = false
        this.hp = hp
        this._respawn()
    }
}
