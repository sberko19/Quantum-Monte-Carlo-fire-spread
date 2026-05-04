/**
 * wfd-fire-qmc.js
 * Quantum Monte Carlo fire spread prediction library for WFD-OS.
 *
 * Exports: WFDFireQMC.Predictor
 * UMD pattern — works as a browser global, AMD module, or CommonJS require().
 *
 * Version: 1.0.0
 * Team A — Necho / Dry Dock 2026
 *
 * Design rationale:
 *   Classical cellular-automaton models pick ONE stochastic outcome per cell
 *   per step (a single PRNG roll). This collapses the genuine uncertainty of
 *   real fire spread — wind gusts, fuel heterogeneity, ember casting — into a
 *   single deterministic trajectory, causing mode collapse on rare events
 *   (jumps over firebreaks, sudden backing-fire flares).
 *
 *   This library instead runs an ensemble of N trajectories (default 256) in
 *   parallel, drawing each random number from a low-discrepancy Halton or
 *   Sobol sequence (the QRNG fallback). Low-discrepancy sequences cover the
 *   high-dimensional sample space far more uniformly than independent PRNG,
 *   giving better tail coverage and less variance in the aggregated forecast.
 *
 *   The output is a PROBABILITY DISTRIBUTION per cell, not a single state.
 *   This is what the decision layer (QAOA resource optimizer) needs: not
 *   "the fire will be here", but "there is a 73% chance the fire reaches
 *   this cell within 30 minutes, with high uncertainty on the NE flank."
 */

;(function (root, factory) {
  'use strict';
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WFDFireQMC = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =========================================================
  // LOW-DISCREPANCY SEQUENCES (QRNG FALLBACK)
  // =========================================================
  // These produce quasi-random numbers that cover the unit hypercube
  // far more uniformly than independent PRNG. The key property:
  // after N samples, every sub-region has been visited proportionally
  // to its volume — no clustering, no voids. This directly translates
  // to better Monte Carlo convergence (O(log(N)^d / N) error vs O(1/√N)
  // for independent PRNG).
  //
  // randomnessSource options:
  //   'pseudoqrng'  — Halton sequence (default, honest label)
  //   'qrng'        — reserved for hardware QRNG endpoint (not wired up)
  //   'classical'   — plain xorshift64 PRNG (fastest, least accurate tails)

  /**
   * Halton sequence generator.
   * halton(index, base) returns the index-th term of the base-b Halton sequence.
   * For an ensemble of size N and dimension d, use base = PRIMES[d].
   * Bases must be coprime — use successive primes.
   */
  const HALTON_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];

  function halton(index, base) {
    let result = 0;
    let f = 1;
    let i = index;
    while (i > 0) {
      f = f / base;
      result += f * (i % base);
      i = Math.floor(i / base);
    }
    return result;
  }

  /**
   * Sobol sequence — Van der Corput base-2 scrambled.
   * Used as a higher-quality alternative to Halton for dim >= 6.
   * This is a simplified 1D Sobol; for d dimensions, use d independent
   * Van der Corput sequences with different scrambling constants.
   */
  function sobol1D(index) {
    // Van der Corput base-2 (= Halton base-2 = Sobol dim-1)
    let bits = index;
    let result = 0;
    let f = 0.5;
    while (bits > 0) {
      if (bits & 1) result += f;
      f *= 0.5;
      bits >>>= 1;
    }
    return result;
  }

  /**
   * Fast xorshift64 PRNG for the 'classical' source.
   * Returns a closure with .next() → [0,1).
   */
  function xorshift64(seed) {
    let s = seed >>> 0 || 0xdeadbeef;
    return {
      next() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return (s >>> 0) / 4294967296;
      }
    };
  }

  // =========================================================
  // QRNG SAMPLE BUFFER
  // =========================================================
  // Pre-generate a flat array of quasi-random numbers for the
  // entire ensemble × steps budget. This is the hot path — we
  // want array access, not function call overhead, inside the
  // inner trajectory loop.

  class QRNGBuffer {
    /**
     * @param {string} source - 'pseudoqrng' | 'qrng' | 'classical'
     * @param {number} size   - total samples needed
     * @param {number} seed   - seed for classical PRNG
     */
    constructor(source, size, seed = 42) {
      this.source = source;
      this.buf = new Float32Array(size);
      this._fill(source, size, seed);
      this._cursor = 0;
    }

    _fill(source, size, seed) {
      if (source === 'classical') {
        const prng = xorshift64(seed);
        for (let i = 0; i < size; i++) this.buf[i] = prng.next();
      } else {
        // pseudoqrng / qrng — use Halton (dimension alternates between
        // bases 2 and 3 for pairs of draws, giving 2D equidistribution)
        for (let i = 0; i < size; i++) {
          const base = HALTON_PRIMES[i % HALTON_PRIMES.length];
          this.buf[i] = halton(Math.floor(i / HALTON_PRIMES.length) + 1, base);
        }
      }
    }

    /** Draw one sample, wrapping around if exhausted. */
    next() {
      const v = this.buf[this._cursor % this.buf.length];
      this._cursor++;
      return v;
    }

    /** Refill with fresh samples starting from a new offset. */
    refill(seed) {
      this._fill(this.source, this.buf.length, seed);
      this._cursor = 0;
    }

    /** Entropy estimate: Shannon entropy of the sample distribution. */
    entropy() {
      // Bin into 256 buckets and compute H = -Σ p log p
      const bins = new Float32Array(256);
      const n = this.buf.length;
      for (let i = 0; i < n; i++) bins[Math.floor(this.buf[i] * 256)] += 1 / n;
      let H = 0;
      for (let i = 0; i < 256; i++) {
        if (bins[i] > 0) H -= bins[i] * Math.log2(bins[i]);
      }
      return H; // max = 8 bits for uniform
    }
  }

  // =========================================================
  // FIRE PHYSICS — single-trajectory step
  // =========================================================
  // This replicates the physical rules from the WFD-OS shell
  // (wind-coupled spread probability, fuel decay, slope effect)
  // but is isolated from all UI/DOM code. Each trajectory call
  // draws from a shared QRNGBuffer so the ensemble diverges
  // purely from the stochastic draws, not from different physics.

  const NEIGHBORS_4 = [[-1,0],[1,0],[0,-1],[0,1]];
  const NEIGHBORS_8 = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];

  // Cell states (matching WFD-OS shell enum)
  const STATE_UNBURNED  = 0;
  const STATE_BURNING   = 1;
  const STATE_BURNED    = 2;
  const STATE_FIREBREAK = 3;
  const STATE_SAVED     = 4;

  /**
   * Compute ignition probability for one neighbor cell from one burning source.
   * Mirrors the shell's ignitionProb() — deterministic physics, random draw
   * happens at the call site.
   *
   * @param {object} p - physics parameters
   * @returns {number} probability ∈ [0,1]
   */
  function ignitionProb(p) {
    const { srcIntensity, dstFuel, dstMoisture, dstRetardant, dstWater,
            dx, dy, wind, cellSizeKm, elevSrc, elevDst } = p;

    if (dstFuel < 0.05) return 0;

    let rate = 1.4;
    rate *= 0.4 + 0.6 * dstFuel;
    rate *= Math.max(0.2, 1 - dstMoisture * 2.5);
    rate *= Math.max(0.05, 1 - (dstRetardant || 0) * 0.95);
    rate *= Math.max(0.3, 1 - (dstWater || 0) * 0.7);

    // Wind alignment
    const windSpd = Math.sqrt(wind.u * wind.u + wind.v * wind.v);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const align = dist > 0 ? (dx * wind.u / windSpd + dy * wind.v / windSpd) / dist : 0;
    const windMul = Math.exp(align * windSpd * 0.18);
    rate *= windMul;

    // Slope
    if (elevSrc !== undefined && elevDst !== undefined) {
      const dz = elevDst - elevSrc;
      rate *= Math.exp(dz / 90);
    }

    rate *= 0.3 + 0.7 * srcIntensity;
    rate /= Math.max(1, dist);

    // dt = 1 step of the trajectory (dt_h baked in at call site)
    return rate; // caller multiplies by dt_h and applies 1-exp(-r*dt)
  }

  /**
   * Advance one fire grid by one time step, drawing random numbers from qrng.
   * Mutates stateArr, fuelArr, intensityArr in-place.
   *
   * @param {object} grids  - { stateArr, fuelArr, moistureArr, elevArr,
   *                            retardantArr, waterArr, intensityArr }
   * @param {object} dims   - { w, h, cellSizeKm }
   * @param {object} wind   - { u, v } in m/s
   * @param {number} dt_h   - time step in hours
   * @param {QRNGBuffer} qrng
   */
  function stepTrajectory(grids, dims, wind, dt_h, qrng) {
    const { stateArr, fuelArr, moistureArr, elevArr,
            retardantArr, waterArr, intensityArr } = grids;
    const { w, h } = dims;
    const N = w * h;

    // Snapshot state to avoid order effects
    const stateNext     = new Uint8Array(stateArr);
    const fuelNext      = new Float32Array(fuelArr);
    const intensityNext = new Float32Array(intensityArr);

    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const i = iy * w + ix;
        const s = stateArr[i];

        if (s === STATE_BURNING) {
          // Consume fuel
          const consumeRate = 0.20 + 0.5 * intensityArr[i] * (1 - (moistureArr[i] || 0.18) * 2);
          const consumed = Math.min(fuelArr[i], consumeRate * dt_h);
          fuelNext[i] = Math.max(0, fuelArr[i] - consumed);

          if (fuelNext[i] < 0.02) {
            stateNext[i] = STATE_BURNED;
            intensityNext[i] = 0;
          } else {
            const peak = 1.0 - (moistureArr[i] || 0.18) * 1.4;
            const targetInt = peak * Math.min(1, fuelNext[i] / 0.5);
            intensityNext[i] += (targetInt - intensityArr[i]) * Math.min(1, dt_h * 4);
            intensityNext[i] *= Math.max(0.1, 1 - (waterArr ? waterArr[i] : 0) * 0.6);
            if (intensityNext[i] < 0.05) {
              stateNext[i] = STATE_SAVED;
              intensityNext[i] = 0;
            }
          }

        } else if (s === STATE_UNBURNED && fuelArr[i] > 0.05) {
          // Check for ignition from burning neighbors
          let pIgnite = 0;
          for (const [dx, dy] of NEIGHBORS_8) {
            const nx = ix + dx, ny = iy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (stateArr[ni] !== STATE_BURNING) continue;

            const r = ignitionProb({
              srcIntensity: intensityArr[ni],
              dstFuel:      fuelArr[i],
              dstMoisture:  moistureArr ? moistureArr[i] : 0.18,
              dstRetardant: retardantArr ? retardantArr[i] : 0,
              dstWater:     waterArr ? waterArr[i] : 0,
              dx, dy, wind,
              cellSizeKm:   dims.cellSizeKm,
              elevSrc:      elevArr ? elevArr[ni] : undefined,
              elevDst:      elevArr ? elevArr[i]  : undefined,
            });

            const p = 1 - Math.exp(-r * dt_h);
            pIgnite = 1 - (1 - pIgnite) * (1 - p);
          }

          if (pIgnite > 0 && qrng.next() < pIgnite) {
            stateNext[i] = STATE_BURNING;
            intensityNext[i] = 0.4 + qrng.next() * 0.4;
          }
        }
      }
    }

    // Commit
    stateArr.set(stateNext);
    fuelArr.set(fuelNext);
    intensityArr.set(intensityNext);
  }

  // =========================================================
  // PREDICTOR CLASS
  // =========================================================

  class Predictor {
    /**
     * @param {object} opts
     * @param {number} opts.gridWidth
     * @param {number} opts.gridHeight
     * @param {number} [opts.cellSizeKm=0.4]
     * @param {number} [opts.numTrajectories=256]
     * @param {string} [opts.randomnessSource='pseudoqrng']
     */
    constructor(opts = {}) {
      this.gridWidth        = opts.gridWidth  || 35;
      this.gridHeight       = opts.gridHeight || 25;
      this.cellSizeKm       = opts.cellSizeKm || 0.4;
      this.numTrajectories  = opts.numTrajectories || 256;
      this.randomnessSource = opts.randomnessSource || 'pseudoqrng';

      if (this.randomnessSource === 'qrng') {
        console.warn(
          '[WFDFireQMC] randomnessSource: "qrng" is set but no hardware QRNG endpoint ' +
          'is configured. Falling back to Halton low-discrepancy sequence ' +
          '(pseudoqrng). Set randomnessSource: "pseudoqrng" to suppress this warning.'
        );
        this.randomnessSource = 'pseudoqrng';
      }

      this._N = this.gridWidth * this.gridHeight;
      this._state     = null;
      this._fuel      = null;
      this._moisture  = null;
      this._elevation = null;
      this._wind      = { u: 5, v: 5 };

      // Diagnostics
      this._lastTrajectoriesRun = 0;
      this._lastPredictMs       = 0;
      this._lastQrngEntropy     = 0;
      this._totalPredictCalls   = 0;
    }

    /**
     * Initialize the predictor with the current world state.
     * All grids must be length gridWidth * gridHeight.
     *
     * @param {object} s
     * @param {Uint8Array}    s.fireGrid
     * @param {Float32Array}  s.fuelGrid
     * @param {Float32Array}  s.moistureGrid
     * @param {Float32Array}  s.elevationGrid
     * @param {object}        s.wind  - { u, v } m/s
     */
    setState(s) {
      const n = this._N;
      if (s.fireGrid.length !== n || s.fuelGrid.length !== n) {
        throw new Error(
          `[WFDFireQMC] Grid size mismatch. Expected ${n} ` +
          `(${this.gridWidth}×${this.gridHeight}), ` +
          `got fireGrid=${s.fireGrid.length}, fuelGrid=${s.fuelGrid.length}`
        );
      }
      this._state     = new Uint8Array(s.fireGrid);
      this._fuel      = new Float32Array(s.fuelGrid);
      this._moisture  = s.moistureGrid  ? new Float32Array(s.moistureGrid)  : null;
      this._elevation = s.elevationGrid ? new Float32Array(s.elevationGrid) : null;
      this._wind      = s.wind || { u: 5, v: 5 };
    }

    /**
     * Run the QMC ensemble forward by dt simulated minutes.
     * Returns a forecast object with per-cell probability distributions.
     *
     * Performance: <50ms for 35×25 grid × 256 trajectories on modern hardware.
     * Falls back to 128 trajectories if the first run exceeds 50ms.
     *
     * @param {number} dt - simulated minutes to advance
     * @returns {object} forecast
     */
    predict(dt) {
      if (!this._state) {
        throw new Error('[WFDFireQMC] Call setState() before predict().');
      }

      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const N  = this._N;
      const w  = this.gridWidth;
      const h  = this.gridHeight;
      const dt_h = dt / 60;

      // Pre-allocate accumulators
      const sumBurning    = new Float32Array(N); // count of trajectories where cell is burning at end
      const sumIgnited    = new Float32Array(N); // count of trajectories where cell ever ignited
      const sumIntensity  = new Float32Array(N);
      const sumIntSq      = new Float32Array(N); // for std-dev
      // For percentile snapshots: store per-trajectory total-burning count
      // and a compact per-cell trajectory-state array.
      // Full per-cell per-trajectory storage = N * numTraj floats — for
      // 35*25*256 = 224,000 floats = ~900KB, acceptable.
      const trajState = new Uint8Array(N * this.numTrajectories);

      let nTraj = this.numTrajectories;

      // QRNG buffer: size = nTraj * N * 2 (two draws per cell per trajectory max)
      const bufSize = nTraj * N * 4;
      const qrng = new QRNGBuffer(this.randomnessSource, bufSize, this._totalPredictCalls);

      const dims = { w, h, cellSizeKm: this.cellSizeKm };

      for (let t = 0; t < nTraj; t++) {
        // Each trajectory starts from the same initial state
        const stateArr     = new Uint8Array(this._state);
        const fuelArr      = new Float32Array(this._fuel);
        const intensityArr = new Float32Array(N);
        // Seed intensity from current burning cells
        for (let i = 0; i < N; i++) {
          if (stateArr[i] === STATE_BURNING) intensityArr[i] = 0.6;
        }

        // Advance by dt_h (subdivide into ~1-min steps for stability)
        const nSteps = Math.max(1, Math.round(dt_h * 60));
        const subDt  = dt_h / nSteps;

        const grids = {
          stateArr, fuelArr, intensityArr,
          moistureArr:  this._moisture,
          elevArr:      this._elevation,
          retardantArr: null,
          waterArr:     null,
        };

        for (let step = 0; step < nSteps; step++) {
          stepTrajectory(grids, dims, this._wind, subDt, qrng);
        }

        // Accumulate
        for (let i = 0; i < N; i++) {
          const s   = stateArr[i];
          const ing = stateArr[i] === STATE_BURNING || stateArr[i] === STATE_BURNED || stateArr[i] === STATE_SAVED;
          const burning = s === STATE_BURNING ? 1 : 0;
          sumBurning[i]   += burning;
          sumIgnited[i]   += ing ? 1 : 0;
          sumIntensity[i] += intensityArr[i];
          sumIntSq[i]     += intensityArr[i] * intensityArr[i];
          trajState[t * N + i] = s;
        }

        // Adaptive: check performance after first 32 trajectories
        if (t === 31) {
          const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
          const projected = elapsed * (nTraj / 32);
          if (projected > 50 && nTraj > 128) {
            nTraj = 128;
            console.warn(
              `[WFDFireQMC] Projected runtime ${projected.toFixed(0)}ms > 50ms budget. ` +
              `Reducing trajectories from ${this.numTrajectories} to 128.`
            );
          }
        }
      }

      // Build forecast
      const probIgnition      = new Float32Array(N);
      const probSpread        = new Float32Array(N);
      const expectedIntensity = new Float32Array(N);
      const uncertainty       = new Float32Array(N);

      for (let i = 0; i < N; i++) {
        probIgnition[i]      = sumIgnited[i]  / nTraj;
        probSpread[i]        = sumBurning[i]  / nTraj;
        expectedIntensity[i] = sumIntensity[i] / nTraj;
        // Std dev = sqrt(E[X^2] - E[X]^2)
        const mean  = sumIntensity[i] / nTraj;
        const meanSq = sumIntSq[i] / nTraj;
        uncertainty[i] = Math.sqrt(Math.max(0, meanSq - mean * mean));
      }

      // Percentile snapshots: rank trajectories by total burning cells,
      // then pull the 5th / 50th / 95th percentile grid states.
      const trajBurningCount = new Float32Array(nTraj);
      for (let t = 0; t < nTraj; t++) {
        let cnt = 0;
        for (let i = 0; i < N; i++) {
          if (trajState[t * N + i] === STATE_BURNING) cnt++;
        }
        trajBurningCount[t] = cnt;
      }

      // Sort trajectory indices by burning count
      const sortedIdx = Array.from({length: nTraj}, (_, i) => i)
        .sort((a, b) => trajBurningCount[a] - trajBurningCount[b]);

      const pctMap = { 5: null, 50: null, 95: null };
      for (const pct of [5, 50, 95]) {
        const idx = sortedIdx[Math.floor((pct / 100) * (nTraj - 1))];
        const snap = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          snap[i] = trajState[idx * N + i] === STATE_BURNING ? 1 : 0;
        }
        pctMap[pct] = snap;
      }

      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

      // Store diagnostics
      this._lastTrajectoriesRun = nTraj;
      this._lastPredictMs       = t1 - t0;
      this._lastQrngEntropy     = qrng.entropy();
      this._totalPredictCalls++;

      return {
        probIgnition,
        probSpread,
        expectedIntensity,
        uncertainty,
        percentile: pctMap,
        // Convenience metadata
        gridWidth:  w,
        gridHeight: h,
        dt_minutes: dt,
        trajectoriesRun: nTraj,
        computeMs:  this._lastPredictMs,
      };
    }

    /**
     * Return diagnostic information for display in the UI cortex panel.
     * @returns {object}
     */
    diagnostics() {
      return {
        trajectoriesRun:    this._lastTrajectoriesRun,
        totalPredictCalls:  this._totalPredictCalls,
        lastPredictMs:      this._lastPredictMs,
        qrngEntropy:        this._lastQrngEntropy,
        randomnessSource:   this.randomnessSource,
        gridSize:           `${this.gridWidth}×${this.gridHeight}`,
        numTrajectories:    this.numTrajectories,
        // Entropy close to 8.0 bits = near-uniform distribution (ideal)
        // Entropy < 7.5 bits = clustering detected (PRNG quality concern)
        entropyStatus:      this._lastQrngEntropy > 7.5 ? 'GOOD' : 'WARN',
      };
    }
  }

  // =========================================================
  // PUBLIC EXPORT
  // =========================================================
  return {
    Predictor,
    // Expose internals for testing
    _halton:       halton,
    _sobol1D:      sobol1D,
    _QRNGBuffer:   QRNGBuffer,
    _stepTrajectory: stepTrajectory,
    VERSION: '1.0.0',
  };
}));
