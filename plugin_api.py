"""usage-stats plugin backend routes (mounted at /api/plugins/usage-stats/).

Deliberately thin: this file only declares routes, and every amount of
accounting logic lives in ``engine.py`` next to it. The router loads the
engine on each request and re-reads it when its mtime changes, so tuning the
day-split heuristic takes effect on the next page refresh — no `hermes serve`
restart. Adding or changing a ROUTE still needs the backend restarted
(routes are mounted once, at serve startup).

Handlers are sync on purpose: FastAPI runs a sync endpoint in its threadpool,
so the state.db reads never stall the dashboard event loop. The plugin UI
reaches these through `window.hermesDesktop.api(...)`.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

_ENGINE = None
_ENGINE_MTIME = None


def engine():
    """The accounting engine, reloaded whenever ``engine.py`` changes on disk."""
    global _ENGINE, _ENGINE_MTIME

    path = Path(__file__).with_name("engine.py")
    mtime = path.stat().st_mtime
    if _ENGINE is None or mtime != _ENGINE_MTIME:
        spec = importlib.util.spec_from_file_location("usage_stats_engine", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _ENGINE, _ENGINE_MTIME = module, mtime
    return _ENGINE


@router.get("/daily")
def daily(days: int = 400) -> dict:
    """Per-model per-day usage: ``{days: {local_day: {model: tokens}}}``."""
    return engine().daily(days)


@router.get("/totals")
def totals(days: int = 3650) -> dict:
    """Windowed totals (input / output / cache_read / api_calls)."""
    return engine().totals(days)


@router.get("/titles")
def titles(days: int = 7) -> dict:
    """Recent session titles for the per-day labels."""
    return engine().titles(days)
