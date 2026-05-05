# 🚀 Spacecraft Flight Simulator

An interactive, single-page simulator for **interplanetary and interstellar missions** —
combining classical kinematics, the rocket equation, special relativity, and laser-sail
propulsion in one browser tool.

> **Live:** https://explore.odinz.net/apps/spacecraft-simulator/

---

## What it does

Pick (or build) a mission, dial in your engine and craft, and the simulator computes the
full trajectory and reports back:

- **Travel time** — Earth-frame and ship-frame (with time dilation when relativistic
  physics is on).
- **Peak velocity** — as a fraction of `c`, with Lorentz factor γ.
- **Δv budget** — checked against the rocket equation; warns when the mission is
  propellant-infeasible.
- **Telemetry charts** — distance, velocity, acceleration, and γ over time, rendered
  with Chart.js.

---

## Mission classes

Presets are organized by propulsion class so you can compare what's actually possible
with each technology:

| Class       | Tech                    | Example presets                                 |
|-------------|-------------------------|-------------------------------------------------|
| **Racer-X** | Chemical / nuclear-thermal | Mars Close Approach, Mars Far Approach        |
| **Racer-Y** | Fusion torch            | Neptune Brachistochrone, Neptune Dart           |
| **Racer-Z** | Hypothetical 1g drive   | Proxima Centauri (1g constant burn)             |
| **Laser-X** | Beamed-energy lightsail | CubeSat → Mars, Probe → Neptune, Crew → Proxima |

---

## Mission modes

- **Brachistochrone** — accelerate to the midpoint, flip, decelerate to a stop at the
  destination. The "fast and arrive" profile.
- **Dart** — accelerate the whole way. Shortest travel time, but you scream past the
  target.

---

## Physics

- **Classical mode** — constant-acceleration kinematics with the Tsiolkovsky rocket
  equation `Δv = vₑ · ln(m₀/m₁)` enforcing a propellant ceiling.
- **Relativistic mode (SR)** — proper-acceleration integration `dv/dt = a/γ³`, so the
  ship asymptotically approaches `c`. Reports both Earth-frame and ship-frame elapsed
  time (time dilation).
- **Infinite-propellant toggle** — bypasses the rocket equation for "what if" drives
  (fusion, antimatter, photon). Required for any 1g interstellar run.
- **Laser sail** — uses `a = (1+R)·P / (m·c)` with reflectivity `R`, beamed power `P`,
  and craft mass `m`. No onboard propellant.

Every input field has a hover tooltip explaining what it is and how it affects the
result.

---

## Tech

- One `index.html` — no build step, no `node_modules`.
- Vanilla JavaScript.
- [Chart.js](https://www.chartjs.org/) (CDN) for telemetry plots.
- Dark space-themed UI with a CSS star field.

## Run locally

```pwsh
# Just open it
Start-Process index.html

# Or serve over HTTP
python -m http.server 8000
# then visit http://localhost:8000/
```

## Status

`v0.1` — functional, opinionated, intentionally first-order. Issues and PRs welcome.

## License

MIT.
