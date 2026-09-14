"""Loading and saving the league file (plain JSON, safe to commit or share)."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from .models import League, LeagueError

DEFAULT_FILENAME = "fsx-league.json"
ENV_VAR = "FSX_LEAGUE"


def resolve_path(explicit: str | None = None) -> Path:
    """``--file`` wins, then ``$FSX_LEAGUE``, then ``./fsx-league.json``.

    With no explicit path we also walk up from the working directory, so the
    commands work from anywhere inside a league's folder.
    """
    if explicit:
        return Path(explicit).expanduser()
    env = os.environ.get(ENV_VAR)
    if env:
        return Path(env).expanduser()
    here = Path.cwd()
    for folder in [here, *here.parents]:
        candidate = folder / DEFAULT_FILENAME
        if candidate.exists():
            return candidate
    return here / DEFAULT_FILENAME


def load(path: Path) -> League:
    if not path.exists():
        raise LeagueError(
            f"no league file at {path}\nRun `fsx init \"My League\"` to start one."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise LeagueError(f"{path} is not valid JSON: {exc}") from exc
    return League.from_dict(data)


def save(path: Path, league: League, backup: bool = True) -> None:
    """Write atomically, keeping one ``.bak`` so a bad run is recoverable."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(league.to_dict(), indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
