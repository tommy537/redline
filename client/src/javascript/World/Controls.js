import mobileDoubleTriangle from '../../images/mobile/doubleTriangle.png'
import mobileCross          from '../../images/mobile/cross.png'
import EventEmitter         from '../Utils/EventEmitter'

export default class Controls extends EventEmitter
{
    constructor(_options)
    {
        super()

        this.config = _options.config
        this.sizes = _options.sizes
        this.time = _options.time
        this.camera = _options.camera
        this.sounds = _options.sounds

        // Set by World after Network is ready
        this.network = null

        this.setActions()
        this.setKeyboard()

        // Auto-init touch UI on touch-capable devices. The Application's
        // global touchstart handler used to do this on first tap, but that
        // tap fires on the title screen *before* World/Controls exists, so
        // `world?.controls.setTouch()` no-ops and the listener (`once: true`)
        // is consumed — leaving touch users with no on-screen controls.
        const touchCapable =
            ('ontouchstart' in window) ||
            (navigator.maxTouchPoints > 0) ||
            (navigator.msMaxTouchPoints > 0)

        if(touchCapable)
        {
            // Defer one frame so the DOM is settled and World has registered
            // its tick listeners (the joystick reads from this.time on tick).
            requestAnimationFrame(() => this.setTouch())
        }
    }

    setActions()
    {
        this.actions = {}
        this.actions.up = false
        this.actions.right = false
        this.actions.down = false
        this.actions.left = false
        this.actions.brake = false
        this.actions.boost = false
        this.actions.steer = 0
        this.actions.throttle = 0

        document.addEventListener('visibilitychange', () =>
        {
            if(!document.hidden)
            {
                this.actions.up = false
                this.actions.right = false
                this.actions.down = false
                this.actions.left = false
                this.actions.brake = false
                this.actions.boost = false
                this.actions.steer = 0
                this.actions.throttle = 0
                this._sendInput()
            }
        })
    }

    _sendInput()
    {
        if(this.network)
        {
            this.network.sendInput({ ...this.actions })
        }
    }

    setKeyboard()
    {
        this.keyboard = {}
        this.keyboard.events = {}

        this.keyboard.events.keyDown = (_event) =>
        {
            // Don't steal keys from text inputs (chat, lobby forms)
            const tag = document.activeElement?.tagName
            if(tag === 'INPUT' || tag === 'TEXTAREA') return

            switch(_event.code)
            {
                case 'ArrowUp':
                case 'KeyW':
                    this.camera.pan.reset()
                    this.actions.up = true
                    this.actions.throttle = 1
                    this._sendInput()
                    break

                case 'ArrowRight':
                case 'KeyD':
                    this.actions.right = true
                    this.actions.steer = 1
                    this._sendInput()
                    break

                case 'ArrowDown':
                case 'KeyS':
                    this.camera.pan.reset()
                    this.actions.down = true
                    this.actions.throttle = -1
                    this._sendInput()
                    break

                case 'ArrowLeft':
                case 'KeyA':
                    this.actions.left = true
                    this.actions.steer = -1
                    this._sendInput()
                    break

                case 'ControlLeft':
                case 'ControlRight':
                case 'KeyX':
                    this.actions.brake = true
                    this._sendInput()
                    break

                case 'Space':
                    // Tap action — handled by World, not held.
                    // preventDefault stops the browser from scrolling on space.
                    _event.preventDefault()
                    this.trigger('action', ['jump'])
                    break

                case 'ShiftLeft':
                case 'ShiftRight':
                    this.actions.boost = true
                    this._sendInput()
                    break

                case 'KeyF':
                    this.trigger('action', ['fire'])
                    break
            }
        }

        this.keyboard.events.keyUp = (_event) =>
        {
            switch(_event.code)
            {
                case 'ArrowUp':
                case 'KeyW':
                    this.actions.up = false
                    this.actions.throttle = this.actions.down ? -1 : 0
                    this._sendInput()
                    break

                case 'ArrowRight':
                case 'KeyD':
                    this.actions.right = false
                    this.actions.steer = this.actions.left ? -1 : 0
                    this._sendInput()
                    break

                case 'ArrowDown':
                case 'KeyS':
                    this.actions.down = false
                    this.actions.throttle = this.actions.up ? 1 : 0
                    this._sendInput()
                    break

                case 'ArrowLeft':
                case 'KeyA':
                    this.actions.left = false
                    this.actions.steer = this.actions.right ? 1 : 0
                    this._sendInput()
                    break

                case 'ControlLeft':
                case 'ControlRight':
                case 'KeyX':
                    this.actions.brake = false
                    this._sendInput()
                    break

                case 'ShiftLeft':
                case 'ShiftRight':
                    this.actions.boost = false
                    this._sendInput()
                    break

                case 'KeyR':
                    this.trigger('action', ['reset'])
                    break
            }
        }

        document.addEventListener('keydown', this.keyboard.events.keyDown)
        document.addEventListener('keyup', this.keyboard.events.keyUp)
    }

    setTouch()
    {
        if(this.touch?.$root) return        // idempotent — only build once

        this.touch = {}

        this.touch.$root = document.createElement('div')
        this.touch.$root.id = 'rl-touch-controls'
        document.body.appendChild(this.touch.$root)

        // Refcount sets for actions that multiple sources can press
        // (joystick + forward/backward/boost buttons).
        this._upHeldBy   = new Set()
        this._downHeldBy = new Set()

        this._buildTouchJoystick()
        this._buildTouchButtons()

        // Fade in once the countdown completes (called from World.setReveal)
        this.touch.reveal = () =>
        {
            this.touch.$root.classList.add('visible')
        }

        // Combat mode unhides the Fire button (called from World.setCombat)
        this.touch.showFire = () =>
        {
            if(this.touch.fire) this.touch.fire.style.display = ''
        }
    }

    // ── 2-axis analog joystick ───────────────────────────────────────────
    _buildTouchJoystick()
    {
        const joy = this.touch.joystick = {
            active:   false,
            pointerId: null,
            current:  { x: 0, y: 0 },
            origin:   { x: 0, y: 0 },   // where the finger first landed
            sentSteer: 0,
            sentThrottle: 0,
        }

        const $j = document.createElement('div')
        $j.className = 'rl-touch-joystick'
        $j.innerHTML = `
            <div class="rl-touch-joystick-ring"></div>
            <div class="rl-touch-joystick-cursor"></div>
        `
        this.touch.$root.appendChild($j)
        joy.$element = $j
        joy.$cursor  = $j.querySelector('.rl-touch-joystick-cursor')

        // 2-axis steering: X = left/right, Y = forward/back.
        //
        // Deflection is measured from where the FINGER first landed, not
        // the geometric center of the element. That way casual contact
        // anywhere inside the joystick is treated as neutral — only an
        // intentional drag from the touch origin counts as input. Fixes
        // the case where the player's thumb naturally lands in the lower
        // half of the joystick and the car immediately reverses.
        this.time.on('tick', () =>
        {
            if(!joy.active) return

            const dx = joy.current.x - joy.origin.x
            const dy = joy.current.y - joy.origin.y
            const DEADZONE = 7
            const MAX_RADIUS = 52
            const normalizeAxis = (value) =>
            {
                const magnitude = Math.min(Math.abs(value), MAX_RADIUS)
                if(magnitude <= DEADZONE) return 0
                return Math.sign(value) * (magnitude - DEADZONE) / (MAX_RADIUS - DEADZONE)
            }

            const normalizedX = normalizeAxis(dx)
            const normalizedY = normalizeAxis(dy)
            const steer = normalizedX === 0
                ? 0
                : Math.sign(normalizedX) * Math.pow(Math.abs(normalizedX), 1.5)
            const throttle = - normalizedY

            const left  = steer < 0
            const right = steer > 0
            const up    = throttle > 0
            const down  = throttle < 0

            if(up)   this._upHeldBy.add('joystick');   else this._upHeldBy.delete('joystick')
            if(down) this._downHeldBy.add('joystick'); else this._downHeldBy.delete('joystick')
            const newUp   = this._upHeldBy.size   > 0
            const newDown = this._downHeldBy.size > 0

            const changed =
                left   !== this.actions.left  ||
                right  !== this.actions.right ||
                newUp  !== this.actions.up    ||
                newDown !== this.actions.down ||
                Math.abs(steer - joy.sentSteer) >= 0.01 ||
                Math.abs(throttle - joy.sentThrottle) >= 0.01

            this.actions.left  = left
            this.actions.right = right
            this.actions.up    = newUp
            this.actions.down  = newDown
            this.actions.steer = steer
            this.actions.throttle = throttle

            if(changed)
            {
                joy.sentSteer = steer
                joy.sentThrottle = throttle
                this._sendInput()
            }

            // Cursor visualization: also relative to origin so the visual
            // matches where the user feels their thumb has moved
            const dist = Math.min(Math.hypot(dx, dy), MAX_RADIUS)
            const ang  = Math.atan2(dy, dx)
            joy.$cursor.style.transform =
                `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px)`
        })

        // Pointer down: snapshot the landing point as the new origin so the
        // first frame doesn't read any deflection from a casual contact.
        $j.addEventListener('pointerdown', (e) =>
        {
            e.preventDefault()
            if(joy.active) return
            joy.active    = true
            joy.pointerId = e.pointerId
            joy.origin.x  = e.clientX
            joy.origin.y  = e.clientY
            joy.current.x = e.clientX
            joy.current.y = e.clientY
            $j.setPointerCapture(e.pointerId)
            this.camera?.pan?.reset?.()
        })

        $j.addEventListener('pointermove', (e) =>
        {
            if(!joy.active || e.pointerId !== joy.pointerId) return
            e.preventDefault()
            joy.current.x = e.clientX
            joy.current.y = e.clientY
        })

        const releaseJoy = (e) =>
        {
            if(!joy.active || e.pointerId !== joy.pointerId) return
            joy.active  = false
            joy.pointerId = null
            joy.$cursor.style.transform = 'translate(0,0)'

            this._upHeldBy.delete('joystick')
            this._downHeldBy.delete('joystick')
            const newUp   = this._upHeldBy.size   > 0
            const newDown = this._downHeldBy.size > 0

            let changed = false
            if(this.actions.left)              { this.actions.left  = false; changed = true }
            if(this.actions.right)             { this.actions.right = false; changed = true }
            if(this.actions.up   !== newUp)    { this.actions.up    = newUp;  changed = true }
            if(this.actions.down !== newDown)  { this.actions.down  = newDown; changed = true }
            if(this.actions.steer !== 0)        { this.actions.steer = 0; changed = true }
            if(this.actions.throttle !== 0)     { this.actions.throttle = 0; changed = true }
            joy.sentSteer = 0
            joy.sentThrottle = 0
            if(changed) this._sendInput()
        }
        $j.addEventListener('pointerup', releaseJoy)
        $j.addEventListener('pointercancel', releaseJoy)
    }

    // ── Right-thumb action buttons ───────────────────────────────────────
    // Bottom-up: brake · boost · jump · fire
    _buildTouchButtons()
    {
        // Hold-style button with a PNG icon
        const makeIconHold = (id, iconUrl, iconRotate, slot, onPress, onRelease, accent) =>
        {
            const $b = document.createElement('button')
            $b.className = 'rl-touch-btn rl-touch-btn-icon'
            $b.id = `rl-touch-${id}`
            $b.dataset.slot = String(slot)
            if(accent) $b.dataset.accent = accent

            const $img = document.createElement('img')
            $img.src = iconUrl
            $img.alt = id
            $img.draggable = false
            if(iconRotate) $img.style.transform = `rotate(${iconRotate}deg)`
            $b.appendChild($img)

            this.touch.$root.appendChild($b)

            let pointerId = null

            $b.addEventListener('pointerdown', (e) =>
            {
                e.preventDefault()
                if(pointerId !== null) return
                pointerId = e.pointerId
                $b.setPointerCapture(e.pointerId)
                $b.classList.add('active')
                onPress()
            })

            const release = (e) =>
            {
                if(e.pointerId !== pointerId) return
                pointerId = null
                $b.classList.remove('active')
                onRelease()
            }
            $b.addEventListener('pointerup', release)
            $b.addEventListener('pointercancel', release)
            return $b
        }

        // Tap-style button with a text label
        const makeTextTap = (id, label, slot, onTap, accent, hidden = false) =>
        {
            const $b = document.createElement('button')
            $b.className = 'rl-touch-btn rl-touch-btn-text'
            $b.id = `rl-touch-${id}`
            $b.dataset.slot = String(slot)
            if(accent) $b.dataset.accent = accent
            if(hidden) $b.style.display = 'none'
            $b.textContent = label
            this.touch.$root.appendChild($b)

            $b.addEventListener('pointerdown', (e) =>
            {
                e.preventDefault()
                $b.setPointerCapture(e.pointerId)
                $b.classList.add('active')
                window.setTimeout(() => $b.classList.remove('active'), 120)
                onTap()
            })
            return $b
        }

        // Slot 0 (bottom): brake — cross
        this.touch.brake = makeIconHold('brake', mobileCross, 0, 0,
            () => { this.actions.brake = true;  this._sendInput() },
            () => { this.actions.brake = false; this._sendInput() })

        // Slot 1: boost — double triangle
        this.touch.boost = makeIconHold('boost', mobileDoubleTriangle, 0, 1,
            () =>
            {
                this._upHeldBy.add('boost')
                this.actions.up = true
                this.actions.boost = true
                this.camera?.pan?.reset?.()
                this._sendInput()
            },
            () =>
            {
                this._upHeldBy.delete('boost')
                this.actions.up = this._upHeldBy.size > 0
                this.actions.boost = false
                this._sendInput()
            },
            'amber')

        // Slot 2: jump — text label, cyan accent
        this.touch.jump = makeTextTap('jump', 'JUMP', 2,
            () => this.trigger('action', ['jump']),
            'cyan')

        // Slot 3: fire — text label, redline accent, combat-mode only
        this.touch.fire = makeTextTap('fire', 'FIRE', 3,
            () => this.trigger('action', ['fire']),
            'redline',
            true)
    }
}
