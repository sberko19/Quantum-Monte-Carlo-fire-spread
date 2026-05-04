# wfd-fire-qmc

**Quantum Monte Carlo fire spread prediction library for WFD-OS.**

Team A deliverable — Necho / Dry Dock 2026.

---

## What this is

A standalone JavaScript library that predicts wildfire spread using a Quantum Monte Carlo ensemble approach. It is a drop-in replacement for the classical cellular-automaton (Brownian) fire model in the WFD-OS shell.

Instead of running one stochastic trajectory per time step, `wfd-fire-qmc.js` runs **256 trajectories in parallel**, each drawing random numbers from a low-discrepancy sequence (the QRNG fallback). The output is a **probability distribution per cell** — not a single deterministic next state.

---

## Why QMC beats classical CA here

Classical CA models pick **one stochastic outcome per cell per step** (a single PRNG roll). This collapses the genuine uncertainty of real fire spread into a single trajectory, causing:

- **Mode collapse** on rare events (ember jumps over firebreaks, sudden backing-fire flares)
- **No uncertainty quantification** — the IC can't know how confident the model is
- **No percentile cones** — the decision layer can't plan for worst-case vs expected

A QMC ensemble evaluates the full **distribution of possible futures**. The joint fire state is treated as a superposition across trajectories; each trajectory diverges from the others purely through its stochastic draws. Aggregating 256 trajectories gives:

- `P(ignition)` per cell — the probability of that cell catching fire within dt minutes
- `P(spread)` — probability the cell is still actively burning
- `E[intensity]` — expected heat output (drives resource prioritization)
- `σ (uncertainty)` — standard deviation across trajectories (where the model is unsure)
- **5th / 50th / 95th percentile** full-grid snapshots (best-case / expected / worst-case cones)

This is exactly what the QAOA resource optimizer needs: not "the fire will be here", but "73% chance the fire reaches this sector within 30 minutes, high uncertainty on the NE flank."

---

## Why Halton sequences over PRNG

Independent PRNG produces **clumped** samples in high-dimensional spaces. For a 35×25 grid with 256 trajectories, each step involves ~875 binary decisions — that's an 875-dimensional sample per ensemble step. Standard PRNG leaves gaps and clusters in that space, causing:

- **Missed rare events** (firebreak jumps, ember casting) because the rare corners of probability space are never sampled
- **High variance** in the aggregated forecast, requiring more trajectories to converge

**Halton low-discrepancy sequences** (the `pseudoqrng` source) cover the unit hypercube uniformly by construction. After N samples, every sub-region has been visited proportionally to its volume. Monte Carlo convergence improves from O(1/√N) to O((log N)^d / N).

The practical result: 256 Halton trajectories give better tail coverage than ~1000 independent PRNG trajectories for this problem size.

---

## QRNG source options

| `randomnessSource` | Description | When to use |
|---|---|---|
| `'pseudoqrng'` | Halton low-discrepancy sequence (default) | Always — best uniformity, honest label |
| `'classical'` | xorshift64 PRNG | Benchmarking / comparison only |
| `'qrng'` | Reserved for hardware QRNG endpoint | Only when a real quantum RNG is wired up — currently falls back to `pseudoqrng` with a warning |

**Do not set `randomnessSource: 'qrng'` in production unless you have actually connected a hardware QRNG endpoint.** The library will warn and fall back gracefully, but the label matters for scientific honesty.

---

## Installation

Zero dependencies. Drop `wfd-fire-qmc.js` alongside your other WFD libraries and include it:

```html
<script src="wfd-fire-qmc.js"></script>
<!-- WFDFireQMC is now available as a global -->
```

Or use it as a CommonJS / AMD module:

```js
const WFDFireQMC = require('./wfd-fire-qmc');
```

---

## API

### `new WFDFireQMC.Predictor(opts)`

```js
const qmc = new WFDFireQMC.Predictor({
  gridWidth:        35,          // cells
  gridHeight:       25,          // cells
  cellSizeKm:       0.4,         // km per cell
  numTrajectories:  256,         // ensemble size (128 min recommended)
  randomnessSource: 'pseudoqrng' // 'pseudoqrng' | 'qrng' | 'classical'
});
```

---

### `qmc.setState(state)`

Initialize with the current world state. Call this once before `predict()`, and again whenever the underlying fire grid changes (e.g. after a suppression deposit or after the player issues an order).

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

Run the ensemble forward by `dt` simulated minutes. Returns a forecast object.

```js
const forecast = qmc.predict(30); // 30 simulated minutes
```

**Returns:**

```js
{
  probIgnition:      Float32Array,  // W*H — P(cell ignites within dt) ∈ [0,1]
  probSpread:        Float32Array,  // W*H — P(cell actively burning at end of dt)
  expectedIntensity: Float32Array,  // W*H — E[burn intensity] across trajectories
  uncertainty:       Float32Array,  // W*H — σ of intensity (std-dev)
  percentile: {
    5:  Float32Array,  // W*H — 5th percentile trajectory (best case)
    50: Float32Array,  // W*H — median trajectory (expected)
    95: Float32Array,  // W*H — 95th percentile trajectory (worst case)
  },
  gridWidth:       number,
  gridHeight:      number,
  dt_minutes:      number,
  trajectoriesRun: number,  // may be < numTrajectories if auto-reduced for performance
  computeMs:       number,
}
```

**Performance:** `predict()` completes in **< 50ms** for a 35×25 grid with 256 trajectories on modern hardware. If the projected runtime exceeds 50ms (detected after 32 trajectories), the library automatically reduces to 128 trajectories and logs a warning.

---

### `qmc.diagnostics()` → object

Returns diagnostic information for display in the UI cortex panel.

```js
qmc.diagnostics()
// {
//   trajectoriesRun:   256,
//   totalPredictCalls: 4,
//   lastPredictMs:     18.4,
//   qrngEntropy:       7.93,       // bits — close to 8.0 = near-uniform (ideal)
//   entropyStatus:     'GOOD',     // 'GOOD' | 'WARN'
//   randomnessSource:  'pseudoqrng',
//   gridSize:          '35×25',
//   numTrajectories:   256,
// }
```

**Entropy interpretation:**
- `> 7.5 bits` → GOOD — near-uniform sample distribution, excellent tail coverage
- `≤ 7.5 bits` → WARN — clustering detected, consider switching to `pseudoqrng`

---

## Standalone demo

Open `qmc-demo.html` directly in a browser (no server needed — just needs `wfd-fire-qmc.js` in the same directory). Shows:

- **5th / 50th / 95th percentile** fire spread cones side-by-side
- **P(ignition)** continuous probability heatmap
- **Uncertainty (σ)** heatmap
- Live diagnostics: compute time, QRNG entropy, trajectory count
- Controls: forecast dt, trajectory count, wind speed/direction, randomness source

---

## Integration with WFD-OS shell

The integrator (Sammy) will call `predict()` from the existing `tick()` loop and pass the result to the rendering and QAOA optimizer layers. The library has zero DOM dependencies — it only touches grids and numbers.

```js
// In tick() — after advanceFireGrid(), before draw()
const forecast = qmc.predict(30); // look 30 sim-minutes ahead

// Pass to QAOA optimizer
const hotspots = extractHotspotsFromForecast(forecast);
callOptimizer(hotspots, activeUnits());

// Pass to renderer
drawForecastOverlay(forecast);
```

---

## Files

| File | Description |
|---|---|
| `wfd-fire-qmc.js` | The library. Zero dependencies. UMD export. |
| `qmc-demo.html`   | Standalone demo. Open in browser. |
| `README.md`       | This file. |

---

## Version

`1.0.0` — Team A, Necho, Dry Dock 2026.
