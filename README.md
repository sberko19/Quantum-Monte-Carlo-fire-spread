# wfd-fire-qmc

**Quantum Monte Carlo fire spread prediction library for WFD-OS.**

Team A deliverable — Necho / Dry Dock 2026.

---

## What this is

A standalone JavaScript library that predicts wildfire spread using a Quantum Monte Carlo ensemble approach. It is a drop-in replacement for the classical cellular-automaton (Brownian) fire model in the WFD-OS shell.

Instead of running one stochastic trajectory per time step, `wfd-fire-qmc.js` runs **256 trajectories in parallel**, each drawing random numbers from a low-discrepancy Halton sequence (the QRNG fallback). The output is a **probability distribution per cell** — not a single deterministic next state.

This is what the decision layer (QAOA resource optimizer) needs: not "the fire will be here", but "there is a 73% chance the fire reaches this cell within 30 minutes, with high uncertainty on the NE flank."

---

## Why QMC beats classical CA here

Classical CA models pick **one stochastic outcome per cell per step** (a single PRNG roll). This collapses the genuine uncertainty of real fire spread into a single trajectory, causing:

- **Mode collapse** on rare events — ember jumps over firebreaks, sudden backing-fire flares — because the rare corners of probability space are never sampled
- **No uncertainty quantification** — the IC can't know how confident the model is
- **No percentile cones** — the decision layer can't plan for worst-case vs expected

A QMC ensemble evaluates the full **distribution of possible futures**. The joint fire state is treated as a superposition across trajectories; each trajectory diverges from the others purely through its stochastic draws. Aggregating 256 trajectories gives a full probability distribution per cell.

---

## What the outputs mean in the real world

### P(Ignition)
The probability that a given cell catches fire within the forecast window (dt minutes). Cells that are already burning show high values; more importantly, **unburned cells** that show high P(ignition) are where the fire is *heading*. This is where to pre-treat with retardant — ahead of the head, not on it. A tanker dropping on a low P(ignition) cell is wasting a load; a tanker dropping on a high P(ignition) cell is buying time before the fire arrives.

### P(Spread)
The probability that a cell is still actively burning (not yet burned out) at the end of the forecast window. High P(spread) on a cell means sustained heat output — relevant for water-drop prioritization and crew safety.

### E[Intensity]
Expected heat output per cell, averaged across all trajectories. Drives resource effectiveness scoring in the QAOA optimizer — a high-intensity cell is worth more suppression effort than a low-intensity one.

### Uncertainty (σ)
Standard deviation of intensity across the 256 trajectories. **This is where your situational awareness is worst.** High uncertainty means the simulated futures strongly disagree about what happens in that area. The cause is always one of:
- Wind doing something unpredictable (terrain channeling, slope interaction)
- Heterogeneous fuel (dry grass patches next to bare rock)
- Fire behavior near a firebreak or suppression line — genuinely binary, either it jumps or it doesn't

**The right operational response to high uncertainty is recon.** Send the drone there first. Once you have eyes on it, the uncertainty collapses and the forecast tightens. This is the direct link between the QMC output and the QAOA resource assignment.

### Percentile cones (5th / 50th / 95th)
The ensemble is sorted by total burning area and three snapshots are pulled:

| Percentile | Meaning | How to use it |
|---|---|---|
| **5th** | Best realistic case — fire stayed contained | Lower bound for resource planning |
| **50th** | Median — most likely outcome | Primary planning scenario |
| **95th** | Worst realistic case — fire spread aggressively | Design your containment line for this |

The spread between 5th and 95th is itself a measure of forecast confidence. A narrow spread means the model is confident. A wide spread means conditions are volatile and you need more recon before committing resources.

### The combined decision loop

```
QMC forecast → QAOA optimizer → resource assignments → suppression → updated fire state → QMC forecast
```

The optimizer sees all layers together:

| P(ignition) | Uncertainty | Recommended action |
|---|---|---|
| High | Low  | Send tanker — high confidence it's needed |
| High | High | Send recon first, then tanker |
| Low  | High | Send recon to rule it out |
| Low  | Low  | Ignore — fire is not going there |

---

## Why Halton sequences over PRNG

Independent PRNG produces **clumped** samples in high-dimensional spaces. For a 35×25 grid with 256 trajectories, each step involves ~875 binary ignition decisions — a 875-dimensional sample per ensemble step. Standard PRNG leaves gaps and clusters in that space, causing missed rare events and high variance in the aggregated forecast.

**Halton low-discrepancy sequences** cover the unit hypercube uniformly by construction. After N samples, every sub-region has been visited proportionally to its volume. Monte Carlo convergence improves from O(1/√N) to O((log N)^d / N). In practice: 256 Halton trajectories give better tail coverage than ~1000 independent PRNG trajectories for this problem size.

---

## QRNG source options

| `randomnessSource` | Description | When to use |
|---|---|---|
| `'pseudoqrng'` | Halton low-discrepancy sequence (default) | Always — best uniformity, honest label |
| `'classical'` | xorshift64 PRNG | Benchmarking / comparison only |
| `'qrng'` | Reserved for hardware QRNG endpoint | Only when a real quantum RNG is wired up — currently falls back to `pseudoqrng` with a console warning |

**Do not set `randomnessSource: 'qrng'` unless you have actually connected a hardware QRNG endpoint.** The library warns and falls back gracefully, but the label matters for scientific honesty.

---

## Performance

`predict()` targets **< 50ms** for a 35×25 grid with 256 trajectories on modern hardware. If the projected runtime exceeds 50ms (detected after the first 32 trajectories), the library automatically reduces to 128 trajectories and logs a console warning. The `diagnostics()` call reports how many trajectories actually ran.

If you consistently see > 50ms, reduce `numTrajectories` to 128 in the constructor.

---

## Installation

Zero dependencies. Drop `wfd-fire-qmc.js` alongside your other WFD libraries:

```html
<script src="wfd-fire-qmc.js"></script>
<!-- WFDFireQMC is now available as a global -->
```

Or as a CommonJS / AMD module:

```js
const WFDFireQMC = require('./wfd-fire-qmc');
```

---

## API

### `new WFDFireQMC.Predictor(opts)`

```js
const qmc = new WFDFireQMC.Predictor({
  gridWidth:        35,           // cells
  gridHeight:       25,           // cells
  cellSizeKm:       0.4,          // km per cell
  numTrajectories:  256,          // ensemble size (128 if hitting 50ms budget)
  randomnessSource: 'pseudoqrng'  // 'pseudoqrng' | 'qrng' | 'classical'
});
```

---

### `qmc.setState(state)`

Initialize with the current world state. Call once before `predict()`, and again whenever the fire grid changes (after a suppression deposit, after a new order is issued).

```js
qmc.setState({
  fireGrid:      Uint8Array,    // W*H, values 0-4 matching WFD-OS cell state enum
  fuelGrid:      Float32Array,  // W*H, 0-1 (fuel load)
  moistureGrid:  Float32Array,  // W*H, 0-1 (lower = drier = spreads faster)
  elevationGrid: Float32Array,  // W*H, meters ASL
  wind: { u: number, v: number } // m/s wind vector
});
```

Cell state enum (matches WFD-OS shell):

| Value | State |
|---|---|
| 0 | Unburned |
| 1 | Burning |
| 2 | Burned |
| 3 | Firebreak |
| 4 | Saved (extinguished by suppression) |

---

### `qmc.predict(dt)` → forecast

Run the ensemble forward by `dt` simulated minutes.

```js
const forecast = qmc.predict(30); // look 30 sim-minutes ahead
```

**Returns:**

```js
{
  probIgnition:      Float32Array,  // P(cell ignites within dt) ∈ [0,1]
  probSpread:        Float32Array,  // P(cell actively burning at end of dt)
  expectedIntensity: Float32Array,  // E[burn intensity] across trajectories
  uncertainty:       Float32Array,  // σ of intensity (std-dev) — where to send recon
  percentile: {
    5:  Float32Array,  // best case fire extent
    50: Float32Array,  // median / expected
    95: Float32Array,  // worst case — design containment for this
  },
  gridWidth:       number,
  gridHeight:      number,
  dt_minutes:      number,
  trajectoriesRun: number,  // may be < numTrajectories if auto-reduced for performance
  computeMs:       number,
}
```

---

### `qmc.diagnostics()` → object

```js
qmc.diagnostics()
// {
//   trajectoriesRun:   256,
//   totalPredictCalls: 4,
//   lastPredictMs:     18.4,
//   qrngEntropy:       7.93,       // bits — close to 8.0 = near-uniform (ideal)
//   entropyStatus:     'GOOD',     // 'GOOD' (> 7.5 bits) | 'WARN' (≤ 7.5 bits)
//   randomnessSource:  'pseudoqrng',
//   gridSize:          '35x25',
//   numTrajectories:   256,
// }
```

**Entropy interpretation:**
- `> 7.5 bits` → GOOD — near-uniform sample distribution, excellent tail coverage
- `≤ 7.5 bits` → WARN — clustering detected, switch to `pseudoqrng`

---

## Standalone demo

Put `wfd-fire-qmc.js` and `qmc-demo.html` in the same folder and open `qmc-demo.html` in a browser. No server needed.

The demo shows a synthetic fire scenario with controls for forecast dt, trajectory count, wind speed/direction, and randomness source. Outputs rendered:

- **5th / 50th / 95th percentile** fire spread cones — color coded blue / orange / red
- **P(ignition)** continuous probability heatmap — dark = safe, red/white = likely to burn
- **Uncertainty (σ)** heatmap — bright purple = where to send recon first
- Live diagnostics: compute time, QRNG entropy, trajectory count

---

## Integration with WFD-OS shell

```js
// In tick() — after advanceFireGrid(), before draw()
const forecast = qmc.predict(30);

// Pass uncertainty hotspots to QAOA optimizer
const hotspots = extractHotspotsFromForecast(forecast);
callOptimizer(hotspots, activeUnits());

// Pass to renderer
drawForecastOverlay(forecast);
```

The library has zero DOM dependencies — it only touches grids and numbers.

---

## Files

| File | Description |
|---|---|
| `wfd-fire-qmc.js` | The library. Zero dependencies. UMD export. |
| `qmc-demo.html`   | Standalone demo. Open in browser alongside the JS file. |
| `README.md`       | This file. |

---

## Version

`1.0.0` — Team A, Necho, Dry Dock 2026.
