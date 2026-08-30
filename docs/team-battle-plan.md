# REDLINE Team Battle Plan

## Goal

Add a family-friendly `team-combat` mode for 2–8 players without regressing the existing free-for-all Combat mode. The first playable version is Team Deathmatch: Red vs Blue, friendly fire disabled, three-second respawn, timed match, and a shared team score.

## Current foundation

- Combat arena, missiles, health, pickups, hazards, respawn, and minimap already work.
- The server now tracks kills/deaths and broadcasts the live individual leaderboard.
- Touch steering is analog and tuned for iPad.
- Remaining architectural risk: clients still report hits and destruction. Team rules must be validated by the server before points are awarded.

## Phase 1 — Team identity and lobby

Status: implemented on `fix/controll-more-easy`.

Deliverables:

- Add `team-combat` to the game-mode model.
- Add `team` to each server player record and all join/player payloads.
- Auto-balance joins using the smaller team; alternate Red/Blue when equal.
- Show Red and Blue rosters before the match starts.
- Keep the current `combat` mode unchanged.

Primary files:

- `client/src/javascript/EntryFlow.js`
- `client/src/javascript/LobbyUI.js`
- `client/src/javascript/Network.js`
- `server/src/GameRoom.js`

Acceptance:

- Four joining players are split 2–2.
- Reconnecting players receive an assigned team and all clients show the same rosters.

## Phase 2 — Team combat rules

Status: implemented on `fix/controll-more-easy`.

Deliverables:

- Include attacker identity in the server damage record.
- Reject self-damage and same-team damage for Team Deathmatch.
- Keep friendly fire enabled in free-for-all Combat only where intended.
- Award one team point when the server attributes a valid enemy kill.
- Clear stale attacker records on death/respawn.

Event payloads:

```js
// server -> clients
{
  mode: 'team-combat',
  red: { score: 4, players: [...] },
  blue: { score: 3, players: [...] },
  remainingMs: 132000
}
```

Acceptance:

- Shooting a teammate does not reduce HP or change the score.
- An enemy kill increments both the killer's personal kills and their team score exactly once.

## Phase 3 — Team presentation

Deliverables:

- Persistent `RED score — timer — BLUE score` HUD.
- Team leaderboard with player kills/deaths under each side.
- Red/Blue marker above every car; keep chosen body color underneath.
- Team colors on the arena minimap.
- Separate Red and Blue spawn areas.

Primary files:

- `client/src/javascript/World/index.js`
- `client/src/javascript/World/RemoteCarManager.js`
- `client/src/javascript/World/ArenaMinimap.js`
- `client/src/styles/redline.css`
- `server/src/GameRoom.js`

Acceptance:

- Team identity is readable on an iPad without relying only on car paint.
- Players respawn at their own side and cannot overlap the enemy spawn point.

## Phase 4 — Match lifecycle

Initial rules:

- Match duration: 3 minutes.
- Respawn: 3 seconds.
- Highest team score wins.
- Sudden death on a tied score.
- Host can start/rematch; late joiners enter the smaller team.

Required server state:

```js
{
  state: 'waiting' | 'countdown' | 'playing' | 'complete',
  startedAt: 0,
  endsAt: 0,
  winner: null | 'red' | 'blue'
}
```

Acceptance:

- Every client sees the same timer and winner.
- Score changes stop after match completion.
- Rematch resets team and personal scores without restarting PM2.

## Phase 5 — Family balancing

Add only after the base mode is stable:

- Player difficulty: Easy / Normal / Pro.
- Easy steering assist and faster auto-upright recovery.
- Catch-up pickup weighting for a team trailing by three or more points.
- Optional AI bots when fewer than four humans join.
- Fun end screen: MVP, most assists, most crashes, best comeback.

## Later modes

Build on the same team/match state in this order:

1. Capture the Flag.
2. King of the Hill.
3. Coin Hunt teams.
4. Ball Mode.

## Verification checklist for every phase

- `npm run build`
- Two-client and four-client socket integration tests.
- Join, leave, reconnect, duplicate death, and simultaneous-kill cases.
- iPad Safari touch test while firing/boosting with the second thumb.
- Free-for-all Combat regression test.
- PM2 restart and reconnect test on the Ubuntu server.

## Recommended implementation order

Do Phase 1 and Phase 2 in one branch, then Phase 3 and Phase 4 in separate branches. Do not add weapons, roles, or bots until server-owned team scoring and match state have passed multiplayer testing.
