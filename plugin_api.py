"""usage-stats backend: per-model daily token usage read from state.db.

Serves the desktop plugin's daily/model charts from ``session_model_usage``,
which records every API call's tokens under the model active at call time —
the per-model attribution the ``sessions`` summary row cannot provide once a
conversation switches models mid-flight (#51607).

Read-only: opens state.db with SQLite URI ``mode=ro``, never writes.
"""

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter

from hermes_constants import get_hermes_home

router = APIRouter()

_TITLES_SQL = """
SELECT s.title, s.started_at
  FROM sessions s
 WHERE s.started_at < :e AND COALESCE(s.last_activity_at, s.started_at) > :s
   AND s.title IS NOT NULL AND s.title != ''
 ORDER BY s.started_at DESC LIMIT 40
"""

_RAW_USAGE_SQL = """
SELECT model, first_seen, COALESCE(last_seen, first_seen) AS last_seen,
       input_tokens, output_tokens, COALESCE(cache_read_tokens, 0) AS cache_read
  FROM session_model_usage
 WHERE task = '' AND model != 'unknown'
   AND COALESCE(last_seen, first_seen) > :s
   AND input_tokens + output_tokens + COALESCE(cache_read_tokens, 0) > 0
"""


def _db_path() -> Path:
    return get_hermes_home() / "state.db"


def _read(query: str, params: dict) -> list[dict]:
    path = _db_path()
    if not path.exists():
        return []
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(query, params)]
    finally:
        conn.close()


@router.get("/daily")
async def daily(days: int = 400):
    """Per-model daily usage: {day: {model: tokens}} for the last ``days`` days.

    A model row spans [first_seen, last_seen] in real call time; each row's
    tokens are split across local calendar days by overlap share, so a
    midnight-crossing stretch lands on the day its calls actually happened.
    """
    days = max(1, min(days, 400))
    today0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    out: dict[str, dict[str, float]] = {}
    for i in range(days):
        day = (today0 - timedelta(days=i)).strftime("%Y-%m-%d")
        out[day] = {}
    earliest = (today0 - timedelta(days=days - 1)).timestamp()

    for r in _read(_RAW_USAGE_SQL, {"s": earliest}):
        total = r["input_tokens"] + r["output_tokens"] + r["cache_read"]
        fs, ls = r["first_seen"], max(r["last_seen"], r["first_seen"])
        if ls - fs < 1:
            # Sub-second call window: the day of the call gets the whole row.
            # (A strict overlap loop would drop it: cur < ls never runs once.)
            day = datetime.fromtimestamp(fs).strftime("%Y-%m-%d")
            if day in out:
                out[day][r["model"]] = out[day].get(r["model"], 0) + total
            continue
        span = ls - fs
        cur = fs
        for _ in range(400):  # rows never span > 400 local days
            d = datetime.fromtimestamp(cur)
            day = d.strftime("%Y-%m-%d")
            if day not in out:
                break
            next_mid = datetime(d.year, d.month, d.day).timestamp() + 86400
            hi = min(next_mid, ls)
            share = (hi - cur) / span
            if share > 0:
                out[day][r["model"]] = out[day].get(r["model"], 0) + total * share
            cur = hi
            if cur >= ls:
                break
    return {"days": out, "earliest": earliest}


@router.get("/totals")
async def totals(days: int = 365):
    """All-time (windowed) totals by metric, all main-loop model rows."""
    days = max(1, min(days, 3650))
    s = (datetime.now() - timedelta(days=days)).timestamp()
    rows = _read(
        """
        SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
               COALESCE(SUM(api_call_count), 0) AS api_calls
          FROM session_model_usage
         WHERE task = '' AND first_seen > :s
        """,
        {"s": s},
    )
    return rows[0] if rows else {}


@router.get("/titles")
async def titles(days: int = 7):
    """Recent session titles with their start timestamps (UI: per-day labels)."""
    days = max(1, min(days, 90))
    s = (datetime.now() - timedelta(days=days)).timestamp()
    e = datetime.now().timestamp()
    return {"titles": _read(_TITLES_SQL, {"s": s, "e": e})}
