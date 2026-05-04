# Necho — Setup & Run

## Files

| File | Description |
|---|---|
| `wildfire-ops.html` | Main demo shell — serves at `/ui` |
| `wfd-fire-qmc.js` | QMC fire spread library — must be in same folder as the HTML |
| `qmc-demo.html` | Standalone QMC demo — open directly in browser |
| `quantum_api.py` | FastAPI backend (resource optimizer) |
| `requirements.txt` | Python dependencies |
| `README.md` | Full API and QMC documentation |

## Running the backend

```bash
pip install -r requirements.txt
uvicorn quantum_api:app --reload
```

Then open: `http://localhost:8000/ui`

## Switching solvers

In `quantum_api.py`, line 16:

```python
USE_QUANTUM = False  # False = classical (demo), True = QAOA (submission)
```

## Standalone QMC demo

Open `qmc-demo.html` directly in a browser — no server needed.
Just make sure `wfd-fire-qmc.js` is in the same folder.

## Top bar overlays (in wildfire-ops.html)

| Button | What it shows |
|---|---|
| P(IGN) | QMC probability of ignition — where fire is heading |
| σ UNC | QMC uncertainty — where to send recon |
| P95 | Percentile cone — cycles 95th / 50th / 5th / off |
| AV HAZ | Aviation terrain hazard — slope, density altitude, valley channeling |
