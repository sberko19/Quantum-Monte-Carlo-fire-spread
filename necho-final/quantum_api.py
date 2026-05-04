from typing import List, Dict, Optional, Tuple
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# =========================================================
# SOLVER TOGGLE
# =========================================================
# Set USE_QUANTUM = True  → runs real QAOA on the Qiskit simulator
#                           (slow: 1-3 min per request, for submission)
# Set USE_QUANTUM = False → runs classical scipy solver
#                           (fast: <1ms per request, for live demo)
#
# The API interface is IDENTICAL either way — same endpoint, same
# JSON in, same JSON out. Only the solver changes.
# =========================================================
USE_QUANTUM = False  # flip to True for submission


# ---- Quantum imports (only loaded when USE_QUANTUM = True) ----
if USE_QUANTUM:
    from qiskit_optimization import QuadraticProgram
    from qiskit_optimization.algorithms import MinimumEigenOptimizer
    from qiskit_aer.primitives import Sampler
    from qiskit_algorithms import QAOA
    from qiskit_algorithms.optimizers import COBYLA

MAX_VARIABLES = 20


# =========================================================
# QUANTUM SOLVER (QAOA)
# =========================================================
class QuantumMissionPlanner:
    def __init__(self, reps: int = 1):
        self.reps = reps

    def _make_optimizer(self):
        qaoa = QAOA(sampler=Sampler(), optimizer=COBYLA(), reps=self.reps)
        return MinimumEigenOptimizer(qaoa)

    def build_problem(self, mission_value, mission_duration, aircraft_max_time, mission_conflicts=None):
        num_aircraft = len(mission_value)
        num_missions = len(mission_value[0])
        problem = QuadraticProgram()
        for i in range(num_aircraft):
            for j in range(num_missions):
                problem.binary_var(f"x_{i}_{j}")
        linear = {}
        for i in range(num_aircraft):
            for j in range(num_missions):
                linear[f"x_{i}_{j}"] = -mission_value[i][j]
        problem.minimize(linear=linear)
        for i in range(num_aircraft):
            coeffs = {f"x_{i}_{j}": int(mission_duration[j] * 100) for j in range(num_missions)}
            problem.linear_constraint(coeffs, "<=", int(aircraft_max_time[i] * 100))
        for j in range(num_missions):
            coeffs = {f"x_{i}_{j}": 1 for i in range(num_aircraft)}
            problem.linear_constraint(coeffs, "<=", 1)
        if mission_conflicts:
            for (j1, j2) in mission_conflicts:
                coeffs = {}
                for i in range(num_aircraft):
                    coeffs[f"x_{i}_{j1}"] = 1
                    coeffs[f"x_{i}_{j2}"] = 1
                problem.linear_constraint(coeffs, "<=", 1)
        return problem

    def solve(self, mission_value, mission_duration, aircraft_max_time, mission_conflicts=None):
        problem = self.build_problem(mission_value, mission_duration, aircraft_max_time, mission_conflicts)
        return self._make_optimizer().solve(problem)


# =========================================================
# CLASSICAL SOLVER (exact brute-force, instant for n<=20)
# =========================================================
from itertools import product

class ClassicalResult:
    """Mimics the shape of a Qiskit OptimizationResult."""
    def __init__(self, x, fval, variable_names):
        self.x = x
        self.fval = fval
        self.variable_names = variable_names


def classical_solve(mission_value, mission_duration, aircraft_max_time, mission_conflicts=None):
    """
    Exact brute-force solver. Runs in milliseconds for <= 20 variables.
    Same objective and constraints as the QAOA formulation.
    """
    num_aircraft = len(mission_value)
    num_missions = len(mission_value[0])
    n = num_aircraft * num_missions
    variable_names = [f"x_{i}_{j}" for i in range(num_aircraft) for j in range(num_missions)]

    best_x = [0.0] * n
    best_val = 0.0
    found = False

    for bits in product([0, 1], repeat=n):
        x = [[bits[i * num_missions + j] for j in range(num_missions)] for i in range(num_aircraft)]
        feasible = True

        # Aircraft time constraints
        for i in range(num_aircraft):
            if sum(x[i][j] * mission_duration[j] for j in range(num_missions)) > aircraft_max_time[i]:
                feasible = False
                break
        if not feasible:
            continue

        # Each mission at most once
        for j in range(num_missions):
            if sum(x[i][j] for i in range(num_aircraft)) > 1:
                feasible = False
                break
        if not feasible:
            continue

        # Conflict pairs
        if mission_conflicts:
            for (j1, j2) in mission_conflicts:
                if (sum(x[i][j1] for i in range(num_aircraft)) >= 1 and
                        sum(x[i][j2] for i in range(num_aircraft)) >= 1):
                    feasible = False
                    break
        if not feasible:
            continue

        total = sum(x[i][j] * mission_value[i][j] for i in range(num_aircraft) for j in range(num_missions))
        obj = -total
        if not found or obj < best_val:
            best_val = obj
            best_x = [float(bits[i * num_missions + j]) for i in range(num_aircraft) for j in range(num_missions)]
            found = True

    return ClassicalResult(x=best_x, fval=best_val, variable_names=variable_names)


# =========================================================
# FastAPI Models
# =========================================================

class Mission(BaseModel):
    id: int
    incident_id: int
    base_value: float
    priority_weight: float
    duration: float
    conflict_with: List[int] = []

class Aircraft(BaseModel):
    id: int
    max_time: float
    effectiveness: Dict[int, float]

class IncidentPriority(BaseModel):
    incident_id: int
    priority_weight: float

class OptimizeRequest(BaseModel):
    missions: List[Mission]
    aircraft: List[Aircraft]
    incidents: List[IncidentPriority]
    reps: int = 1


# =========================================================
# FastAPI App
# =========================================================

app = FastAPI(title="Necho Quantum Wildfire Mission Planner")


@app.get("/")
def root():
    solver = "QAOA (quantum)" if USE_QUANTUM else "Classical (demo mode)"
    return {"message": f"Necho API running in GitHub Codespaces · solver: {solver}"}


@app.post("/optimize")
def optimize(req: OptimizeRequest):
    missions = req.missions
    aircraft = req.aircraft

    if not missions:
        raise HTTPException(status_code=422, detail="At least one mission is required.")
    if not aircraft:
        raise HTTPException(status_code=422, detail="At least one aircraft is required.")

    num_aircraft = len(aircraft)
    num_missions = len(missions)
    num_variables = num_aircraft * num_missions

    if num_variables > MAX_VARIABLES:
        raise HTTPException(
            status_code=422,
            detail=f"Problem has {num_variables} binary variables, which exceeds the limit of {MAX_VARIABLES}.",
        )

    incident_priority = {i.incident_id: i.priority_weight for i in req.incidents}
    mission_index = {m.id: idx for idx, m in enumerate(missions)}
    mission_duration = [m.duration for m in missions]
    aircraft_max_time = [a.max_time for a in aircraft]

    mission_value = [[0.0 for _ in range(num_missions)] for _ in range(num_aircraft)]
    for ai, a in enumerate(aircraft):
        for mj, m in enumerate(missions):
            mission_value[ai][mj] = (
                m.base_value
                * m.priority_weight
                * incident_priority.get(m.incident_id, 1.0)
                * a.effectiveness.get(m.id, 1.0)
            )

    seen_conflicts: set = set()
    mission_conflicts = []
    for m in missions:
        j1 = mission_index[m.id]
        for cid in m.conflict_with:
            if cid in mission_index:
                j2 = mission_index[cid]
                pair = (min(j1, j2), max(j1, j2))
                if pair not in seen_conflicts:
                    seen_conflicts.add(pair)
                    mission_conflicts.append(pair)

    try:
        if USE_QUANTUM:
            planner = QuantumMissionPlanner(reps=req.reps)
            result = planner.solve(mission_value, mission_duration, aircraft_max_time, mission_conflicts)
        else:
            result = classical_solve(mission_value, mission_duration, aircraft_max_time, mission_conflicts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Solver error: {str(e)}")

    variable_names = result.variable_names
    assignments = []
    for idx, val in enumerate(result.x):
        if val > 0.5:
            name = variable_names[idx]
            _, i_str, j_str = name.split("_")
            ai, mj = int(i_str), int(j_str)
            assignments.append({
                "aircraft_id": aircraft[ai].id,
                "mission_id": missions[mj].id,
                "value": round(mission_value[ai][mj], 4),
            })

    return {
        "assignments": assignments,
        "objective_value": round(float(result.fval), 6),
        "num_variables": num_variables,
        "solver": "qaoa" if USE_QUANTUM else "classical",
        "qaoa_reps": req.reps if USE_QUANTUM else None,
    }
