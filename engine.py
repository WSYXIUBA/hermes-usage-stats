"""Usage accounting for the usage-stats plugin — the rules live HERE.

``plugin_api.py`` (the mounted router) loads this file per request and picks
up edits without a ``hermes serve`` restart, so tuning the split never costs
a backend recycle. Only a change to the ROUTES themselves needs one.

Source of truth is ``session_model_usage`` in state.db: Hermes records every
API call's tokens under the model active at that call (#51607), so a
conversation that switches models mid-flight is attributed correctly and
each row carries the real call window ``[first_seen, last_seen]``.

Two kinds of rows exist, and they need different treatment:

* **Single-day row** (`first_seen`/`last_seen` inside one local day, the vast
  majority): attributed to that day as-is — exact.
* **Midnight-crossing row**: the row aggregates every call on one
  ``(model, provider, base_url, mode)`` route, and the DB keeps only the
  window they span — not when each call happened. Splitting it by elapsed
  time assumes a constant rate, which is badly wrong for a session that sat
  idle overnight and then ran hot (a 24 h window whose work happened in two
  short bursts). So the split is weighted by the session's real activity:
  every assistant message inside the window counts as one API call, and its
  weight is the size of the context that call had to re-send — the
  cumulative message count plus the session's system-prompt + tool-schema
  size in message-equivalents. Per-call tokens are dominated by that
  context, so this tracks spend orders of magnitude better than time does.
  Rows with no recorded messages (purged history) fall back to time.

Read-only: state.db is opened with the SQLite URI flag ``mode=ro``.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

# Main-loop rows only; aux calls (compression / background_review / vision /
# title generation) bill under their own task and are not conversation usage.
_MAIN_TASK = ""

_USAGE_SQL = """
SELECT session_id, model, first_seen, COALESCE(last_seen, first_seen) AS last_seen,
       input_tokens, output_tokens, COALESCE(cache_read_tokens, 0) AS cache_read
  FROM session_model_usage
 WHERE task = '' AND model != 'unknown'
   AND COALESCE(last_seen, first_seen) > :s
   AND input_tokens + output_tokens + COALESCE(cache_read_tokens, 0) > 0
"""

_TITLES_SQL = """
SELECT s.title, s.started_at
  FROM sessions s
 WHERE s.started_at < :e AND COALESCE(s.last_activity_at, s.started_at) > :s
   AND s.title IS NOT NULL AND s.title != ''
 ORDER BY s.started_at DESC LIMIT 40
"""

_TOTALS_SQL = """
SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
       COALESCE(SUM(api_call_count), 0) AS api_calls
  FROM session_model_usage
 WHERE task = '' AND first_seen > :s
"""

# Assistant-message times with the cumulative message count at each one: the
# conversation's size when that call ran. Window function over the whole
# session (all roles) so the count is context, not just assistant turns.
_ACTIVITY_SQL = """
SELECT session_id, timestamp, ctx FROM (
    SELECT session_id, timestamp, role,
           COUNT(*) OVER (PARTITION BY session_id ORDER BY timestamp, id
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ctx
      FROM messages
     WHERE session_id IN ({placeholders})
) WHERE role = 'assistant'
"""

# System prompt + tool schema, in message-equivalents: the context a call
# re-sends before the conversation itself. `tool_names` resolves through the
# same system_prompts table (see hermes_state_sessions.get_session).
_PREAMBLE_SQL = """
SELECT s.id,
       COALESCE(length(sp.prompt), 0) + COALESCE(length(tp.prompt), 0) AS preamble,
       (SELECT AVG(length(m.content)) FROM messages m WHERE m.session_id = s.id) AS avg_msg
  FROM sessions s
  LEFT JOIN system_prompts sp ON sp.hash = s.system_prompt_hash
  LEFT JOIN system_prompts tp ON tp.hash = s.tool_names
 WHERE s.id IN ({placeholders})
"""

# Preamble in message-equivalents is bounded: an unbounded estimate (a session
# whose average message is tiny) would flatten the activity signal into noise.
_MAX_PREAMBLE_UNITS = 500.0
_MAX_SPAN_DAYS = 400


def _db_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "state.db"


def _read(query: str, params=()) -> list[dict]:
    """Run one read-only query. Returns [] when the store is absent/unreadable."""
    path = _db_path()
    if not path.exists():
        return []
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(query, params)]
    except sqlite3.DatabaseError:
        # A schema older than this query (no session_model_usage / no window
        # function support) reads as "no data", never as a 500.
        return []
    finally:
        conn.close()


def day_key(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _placeholders(n: int) -> str:
    return ",".join("?" * n)


def _activity(session_ids) -> dict:
    """{session_id: [(timestamp, context_size), ...]} for assistant messages."""
    ids = sorted(session_ids)
    if not ids:
        return {}
    out: dict[str, list] = {}
    for r in _read(_ACTIVITY_SQL.format(placeholders=_placeholders(len(ids))), ids):
        out.setdefault(r["session_id"], []).append((r["timestamp"], r["ctx"]))
    return out


def _preamble_units(session_ids) -> dict:
    """{session_id: system-prompt + tool-schema size in message-equivalents}."""
    ids = sorted(session_ids)
    if not ids:
        return {}
    out: dict[str, float] = {}
    for r in _read(_PREAMBLE_SQL.format(placeholders=_placeholders(len(ids))), ids):
        avg = r["avg_msg"] or 0
        units = (r["preamble"] or 0) / avg if avg > 0 else 0.0
        out[r["id"]] = max(0.0, min(units, _MAX_PREAMBLE_UNITS))
    return out


def _row_shares(fs: float, ls: float, points, preamble: float) -> list[tuple[str, float]]:
    """[(local day, share)] for one usage row — shares sum to 1.

    Weighted by assistant-message activity inside the window; a row with no
    recorded messages (or no messages inside its window) falls back to
    proportional time.
    """
    if ls - fs < 1:
        # Sub-second window: one call, one day.
        return [(day_key(fs), 1.0)]

    weights: dict[str, float] = {}
    for ts, ctx in points or ():
        if fs <= ts <= ls:
            day = day_key(ts)
            weights[day] = weights.get(day, 0.0) + preamble + ctx
    total = sum(weights.values())
    if total > 0:
        return [(day, w / total) for day, w in sorted(weights.items())]

    span = ls - fs
    shares = []
    cur = fs
    for _ in range(_MAX_SPAN_DAYS):
        d = datetime.fromtimestamp(cur)
        next_mid = datetime(d.year, d.month, d.day).timestamp() + 86400
        hi = min(next_mid, ls)
        if hi > cur:
            shares.append((day_key(cur), (hi - cur) / span))
        cur = hi
        if cur >= ls:
            break
    return shares


def daily(days: int = 400) -> dict:
    """{days: {local_day: {model: tokens}}} for the last ``days`` local days."""
    days = max(1, min(int(days), 400))
    today0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    out: dict[str, dict[str, float]] = {}
    for i in range(days):
        out[(today0 - timedelta(days=i)).strftime("%Y-%m-%d")] = {}
    earliest = (today0 - timedelta(days=days - 1)).timestamp()

    rows = _read(_USAGE_SQL, {"s": earliest})

    # Activity/preamble are only needed for rows crossing midnight — the rest
    # land on one day regardless, so skip the extra reads for them.
    spanning = {
        r["session_id"]
        for r in rows
        if day_key(r["first_seen"]) != day_key(max(r["last_seen"], r["first_seen"]))
    }
    activity = _activity(spanning)
    preamble = _preamble_units(spanning)

    for r in rows:
        total = r["input_tokens"] + r["output_tokens"] + r["cache_read"]
        if total <= 0:
            continue
        fs, ls = r["first_seen"], max(r["last_seen"], r["first_seen"])
        shares = (
            [(day_key(fs), 1.0)]
            if fs >= ls
            else _row_shares(fs, ls, activity.get(r["session_id"]), preamble.get(r["session_id"], 0.0))
        )
        for day, share in shares:
            cell = out.get(day)
            if cell is None:
                continue
            cell[r["model"]] = cell.get(r["model"], 0.0) + total * share
    return {"days": out, "earliest": earliest}


def totals(days: int = 3650) -> dict:
    """Windowed totals across all main-loop model rows."""
    days = max(1, min(int(days), 3650))
    s = (datetime.now() - timedelta(days=days)).timestamp()
    rows = _read(_TOTALS_SQL, {"s": s})
    return rows[0] if rows else {}


def titles(days: int = 7) -> dict:
    """Recent session titles with start times (per-day labels in the UI)."""
    days = max(1, min(int(days), 90))
    now = datetime.now().timestamp()
    s = now - days * 86400
    return {"titles": _read(_TITLES_SQL, {"s": s, "e": now})}
