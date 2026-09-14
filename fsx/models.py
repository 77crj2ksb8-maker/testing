"""Data model for a league file.

The file is event-sourced: ``League.entries`` is the ledger, and every
portfolio (cash, positions, realised P&L) is *derived* from it by replay.
Nothing about a portfolio is stored twice, so the file cannot disagree with
itself and ``fsx undo`` is exact.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable

from . import money

SCHEMA_VERSION = 1

BUY = "BUY"
SELL = "SELL"
DEPOSIT = "DEPOSIT"
WITHDRAW = "WITHDRAW"
TRADE_KINDS = (BUY, SELL)
CASH_KINDS = (DEPOSIT, WITHDRAW)
ALL_KINDS = TRADE_KINDS + CASH_KINDS


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "player"


class LeagueError(Exception):
    """Any rule violation or bad reference, reported straight to the user."""


@dataclass
class Rules:
    starting_cash: Decimal = money.cash("100000")
    commission_flat: Decimal = money.cash("0")
    commission_pct: Decimal = Decimal("0")       # percent of notional
    allow_fractional: bool = False
    allow_short: bool = False
    allow_negative_cash: bool = False
    max_position_pct: Decimal | None = None      # concentration cap, percent of equity
    symbols: list[str] = field(default_factory=list)   # empty = anything goes
    opens_at: str | None = None                  # ISO date; trades before are refused
    closes_at: str | None = None                 # ISO date; trades after are refused

    def to_dict(self) -> dict:
        return {
            "starting_cash": str(self.starting_cash),
            "commission_flat": str(self.commission_flat),
            "commission_pct": str(self.commission_pct),
            "allow_fractional": self.allow_fractional,
            "allow_short": self.allow_short,
            "allow_negative_cash": self.allow_negative_cash,
            "max_position_pct": None if self.max_position_pct is None else str(self.max_position_pct),
            "symbols": list(self.symbols),
            "opens_at": self.opens_at,
            "closes_at": self.closes_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Rules":
        data = data or {}
        cap = data.get("max_position_pct")
        return cls(
            starting_cash=money.cash(data.get("starting_cash", "100000")),
            commission_flat=money.cash(data.get("commission_flat", "0")),
            commission_pct=money.dec(data.get("commission_pct", "0")),
            allow_fractional=bool(data.get("allow_fractional", False)),
            allow_short=bool(data.get("allow_short", False)),
            allow_negative_cash=bool(data.get("allow_negative_cash", False)),
            max_position_pct=None if cap in (None, "") else money.dec(cap),
            symbols=[s.upper() for s in data.get("symbols", [])],
            opens_at=data.get("opens_at"),
            closes_at=data.get("closes_at"),
        )

    def commission_on(self, notional: Decimal) -> Decimal:
        return money.cash(self.commission_flat + abs(notional) * self.commission_pct / 100)


@dataclass
class Player:
    id: str
    name: str
    starting_cash: Decimal
    joined_at: str = field(default_factory=utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "starting_cash": str(self.starting_cash),
            "joined_at": self.joined_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Player":
        return cls(
            id=data["id"],
            name=data["name"],
            starting_cash=money.cash(data["starting_cash"]),
            joined_at=data.get("joined_at", utcnow()),
        )


@dataclass
class Entry:
    """One immutable line of the ledger."""

    seq: int
    kind: str
    player: str
    at: str                      # ISO timestamp of the event (may be backdated)
    recorded_at: str = field(default_factory=utcnow)
    symbol: str | None = None
    shares: Decimal = money.ZERO
    price: Decimal = money.ZERO
    commission: Decimal = money.ZERO
    amount: Decimal = money.ZERO     # cash entries only
    note: str = ""

    @property
    def notional(self) -> Decimal:
        return money.cash(self.shares * self.price)

    def cash_delta(self) -> Decimal:
        if self.kind == BUY:
            return money.cash(-self.notional - self.commission)
        if self.kind == SELL:
            return money.cash(self.notional - self.commission)
        if self.kind == DEPOSIT:
            return money.cash(self.amount)
        if self.kind == WITHDRAW:
            return money.cash(-self.amount)
        raise LeagueError(f"unknown ledger kind {self.kind!r}")

    def to_dict(self) -> dict:
        data = {
            "seq": self.seq,
            "kind": self.kind,
            "player": self.player,
            "at": self.at,
            "recorded_at": self.recorded_at,
            "note": self.note,
        }
        if self.kind in TRADE_KINDS:
            data.update(
                symbol=self.symbol,
                shares=str(self.shares),
                price=str(self.price),
                commission=str(self.commission),
            )
        else:
            data["amount"] = str(self.amount)
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Entry":
        return cls(
            seq=int(data["seq"]),
            kind=data["kind"],
            player=data["player"],
            at=data["at"],
            recorded_at=data.get("recorded_at", data["at"]),
            symbol=(data.get("symbol") or None),
            shares=money.shares(data.get("shares", "0")),
            price=money.price(data.get("price", "0")),
            commission=money.cash(data.get("commission", "0")),
            amount=money.cash(data.get("amount", "0")),
            note=data.get("note", ""),
        )


@dataclass
class Snapshot:
    at: str
    label: str
    equity: dict[str, Decimal]

    def to_dict(self) -> dict:
        return {"at": self.at, "label": self.label,
                "equity": {k: str(v) for k, v in self.equity.items()}}

    @classmethod
    def from_dict(cls, data: dict) -> "Snapshot":
        return cls(at=data["at"], label=data.get("label", ""),
                   equity={k: money.cash(v) for k, v in data.get("equity", {}).items()})


@dataclass
class League:
    name: str
    currency: str = "USD"
    created_at: str = field(default_factory=utcnow)
    rules: Rules = field(default_factory=Rules)
    players: list[Player] = field(default_factory=list)
    entries: list[Entry] = field(default_factory=list)
    snapshots: list[Snapshot] = field(default_factory=list)
    last_prices: dict[str, dict] = field(default_factory=dict)

    # -- lookup helpers -------------------------------------------------
    def player(self, ref: str) -> Player:
        ref_l = ref.strip().lower()
        for p in self.players:
            if p.id == ref_l:
                return p
        matches = [p for p in self.players if p.name.lower() == ref_l]
        if not matches:
            matches = [p for p in self.players if ref_l in p.name.lower() or ref_l in p.id]
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise LeagueError(f"no such player: {ref!r}")
        names = ", ".join(sorted(p.id for p in matches))
        raise LeagueError(f"{ref!r} matches several players: {names}")

    def has_player(self, player_id: str) -> bool:
        return any(p.id == player_id for p in self.players)

    def next_seq(self) -> int:
        return max((e.seq for e in self.entries), default=0) + 1

    def entries_for(self, player_id: str) -> Iterable[Entry]:
        return (e for e in self.entries if e.player == player_id)

    def symbols_held(self) -> list[str]:
        return sorted({e.symbol for e in self.entries if e.symbol})

    # -- serialisation --------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA_VERSION,
            "name": self.name,
            "currency": self.currency,
            "created_at": self.created_at,
            "rules": self.rules.to_dict(),
            "players": [p.to_dict() for p in self.players],
            "entries": [e.to_dict() for e in self.entries],
            "snapshots": [s.to_dict() for s in self.snapshots],
            "last_prices": self.last_prices,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "League":
        schema = int(data.get("schema", SCHEMA_VERSION))
        if schema > SCHEMA_VERSION:
            raise LeagueError(
                f"league file was written by a newer fsx (schema {schema}); upgrade fsx to read it"
            )
        return cls(
            name=data["name"],
            currency=data.get("currency", "USD"),
            created_at=data.get("created_at", utcnow()),
            rules=Rules.from_dict(data.get("rules", {})),
            players=[Player.from_dict(p) for p in data.get("players", [])],
            entries=[Entry.from_dict(e) for e in data.get("entries", [])],
            snapshots=[Snapshot.from_dict(s) for s in data.get("snapshots", [])],
            last_prices=data.get("last_prices", {}),
        )
