"""League mechanics: replay the ledger, validate trades, value portfolios.

Positions use signed average-cost accounting.  A trade that crosses zero
(selling 8 when you hold 5) is split into two legs — close 5, then open a
3-share short — so realised P&L is never contaminated by the new position.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal

from . import money
from .models import (
    BUY, SELL, DEPOSIT, WITHDRAW, TRADE_KINDS,
    Entry, League, LeagueError, Player, Snapshot, slugify, utcnow,
)


@dataclass
class Position:
    symbol: str
    shares: Decimal = money.ZERO
    cost_basis: Decimal = money.ZERO   # signed; negative for shorts

    @property
    def avg_price(self) -> Decimal:
        if self.shares == 0:
            return money.ZERO
        return money.price(self.cost_basis / self.shares)

    @property
    def is_short(self) -> bool:
        return self.shares < 0


@dataclass
class Portfolio:
    player: Player
    cash: Decimal = money.ZERO
    positions: dict[str, Position] = field(default_factory=dict)
    realized: Decimal = money.ZERO
    commissions: Decimal = money.ZERO
    deposits: Decimal = money.ZERO      # net external cash after the starting stake
    trade_count: int = 0

    @property
    def invested_base(self) -> Decimal:
        """What the player has been handed in total — the return denominator."""
        return money.cash(self.player.starting_cash + self.deposits)

    def open_positions(self) -> list[Position]:
        return [p for p in self.positions.values() if p.shares != 0]

    def position(self, symbol: str) -> Position:
        return self.positions.get(symbol.upper(), Position(symbol.upper()))


def replay(league: League, player: Player, upto_seq: int | None = None) -> Portfolio:
    """Rebuild a portfolio from the ledger. The only source of truth."""
    pf = Portfolio(player=player, cash=player.starting_cash)
    for entry in sorted(league.entries, key=lambda e: e.seq):
        if entry.player != player.id:
            continue
        if upto_seq is not None and entry.seq > upto_seq:
            break
        _apply(pf, entry)
    return pf


def _apply(pf: Portfolio, entry: Entry) -> None:
    pf.cash = money.cash(pf.cash + entry.cash_delta())
    if entry.kind == DEPOSIT:
        pf.deposits = money.cash(pf.deposits + entry.amount)
        return
    if entry.kind == WITHDRAW:
        pf.deposits = money.cash(pf.deposits - entry.amount)
        return

    pf.trade_count += 1
    pf.commissions = money.cash(pf.commissions + entry.commission)
    symbol = entry.symbol.upper()
    pos = pf.positions.setdefault(symbol, Position(symbol))
    signed = entry.shares if entry.kind == BUY else -entry.shares
    _move(pf, pos, signed, entry.price)
    # Commission is a cost of doing business; book it against realised P&L so
    # realised + unrealised + cash always reconciles with equity.
    pf.realized = money.cash(pf.realized - entry.commission)


def _move(pf: Portfolio, pos: Position, signed_shares: Decimal, price: Decimal) -> None:
    """Apply a signed share change, splitting at zero if the trade crosses it."""
    if signed_shares == 0:
        return
    closing = pos.shares != 0 and (pos.shares > 0) != (signed_shares > 0)
    if closing:
        closed = min(abs(signed_shares), abs(pos.shares))
        direction = Decimal(1) if pos.shares > 0 else Decimal(-1)
        avg = pos.avg_price
        pf.realized = money.cash(pf.realized + closed * (price - avg) * direction)
        pos.shares = money.shares(pos.shares - direction * closed)
        pos.cost_basis = money.cash(pos.cost_basis - direction * closed * avg)
        if pos.shares == 0:
            pos.cost_basis = money.ZERO
        remainder = abs(signed_shares) - closed
        if remainder > 0:
            _move(pf, pos, remainder * (Decimal(1) if signed_shares > 0 else Decimal(-1)), price)
        return
    pos.shares = money.shares(pos.shares + signed_shares)
    pos.cost_basis = money.cash(pos.cost_basis + signed_shares * price)


# ---------------------------------------------------------------------------
# Valuation
# ---------------------------------------------------------------------------

@dataclass
class PositionValue:
    position: Position
    price: Decimal | None
    prev_close: Decimal | None = None

    @property
    def market_value(self) -> Decimal:
        if self.price is None:
            return money.cash(self.position.cost_basis)
        return money.cash(self.position.shares * self.price)

    @property
    def unrealized(self) -> Decimal:
        return money.cash(self.market_value - self.position.cost_basis)

    @property
    def day_change(self) -> Decimal:
        if self.price is None or self.prev_close is None:
            return money.ZERO
        return money.cash(self.position.shares * (self.price - self.prev_close))

    @property
    def priced(self) -> bool:
        return self.price is not None


@dataclass
class Valuation:
    portfolio: Portfolio
    positions: list[PositionValue]

    @property
    def player(self) -> Player:
        return self.portfolio.player

    @property
    def market_value(self) -> Decimal:
        return money.cash(sum((p.market_value for p in self.positions), money.ZERO))

    @property
    def equity(self) -> Decimal:
        return money.cash(self.portfolio.cash + self.market_value)

    @property
    def unrealized(self) -> Decimal:
        return money.cash(sum((p.unrealized for p in self.positions), money.ZERO))

    @property
    def day_change(self) -> Decimal:
        return money.cash(sum((p.day_change for p in self.positions), money.ZERO))

    @property
    def total_pnl(self) -> Decimal:
        return money.cash(self.equity - self.portfolio.invested_base)

    @property
    def return_pct(self) -> Decimal:
        return money.pct(self.total_pnl, self.portfolio.invested_base)

    @property
    def fully_priced(self) -> bool:
        return all(p.priced for p in self.positions)


def value_portfolio(pf: Portfolio, prices: dict) -> Valuation:
    """``prices`` maps SYMBOL -> object/dict with ``price`` and ``prev_close``."""
    values = []
    for pos in sorted(pf.open_positions(), key=lambda p: p.symbol):
        quote = prices.get(pos.symbol)
        price = prev = None
        if quote is not None:
            price = money.price(_get(quote, "price"))
            raw_prev = _get(quote, "prev_close")
            prev = None if raw_prev in (None, "") else money.price(raw_prev)
        values.append(PositionValue(position=pos, price=price, prev_close=prev))
    return Valuation(portfolio=pf, positions=values)


def _get(quote, field):
    if isinstance(quote, dict):
        return quote.get(field)
    return getattr(quote, field, None)


def leaderboard(league: League, prices: dict) -> list[Valuation]:
    rows = [value_portfolio(replay(league, p), prices) for p in league.players]
    return sorted(rows, key=lambda v: (v.equity, v.player.name), reverse=True)


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------

def add_player(league: League, name: str, cash: Decimal | None = None, player_id: str | None = None) -> Player:
    name = name.strip()
    if not name:
        raise LeagueError("player name cannot be empty")
    pid = slugify(player_id or name)
    if league.has_player(pid):
        raise LeagueError(f"player {pid!r} already exists")
    player = Player(
        id=pid,
        name=name,
        starting_cash=money.cash(cash if cash is not None else league.rules.starting_cash),
    )
    league.players.append(player)
    return player


def remove_player(league: League, ref: str) -> Player:
    player = league.player(ref)
    league.players = [p for p in league.players if p.id != player.id]
    league.entries = [e for e in league.entries if e.player != player.id]
    for snap in league.snapshots:
        snap.equity.pop(player.id, None)
    return player


def _check_window(league: League, when: str) -> None:
    rules = league.rules
    day = when[:10]
    if rules.opens_at and day < rules.opens_at:
        raise LeagueError(f"league trading opens {rules.opens_at}; trade dated {day}")
    if rules.closes_at and day > rules.closes_at:
        raise LeagueError(f"league trading closed {rules.closes_at}; trade dated {day}")


def trade(
    league: League,
    player_ref: str,
    kind: str,
    symbol: str,
    shares: Decimal,
    price: Decimal,
    at: str | None = None,
    note: str = "",
    commission: Decimal | None = None,
    prices: dict | None = None,
) -> tuple[Entry, Portfolio]:
    """Validate and append a trade. Returns the entry and the resulting portfolio."""
    if kind not in TRADE_KINDS:
        raise LeagueError(f"kind must be BUY or SELL, not {kind!r}")
    player = league.player(player_ref)
    rules = league.rules
    symbol = symbol.upper().strip()
    shares = money.shares(shares)
    price = money.price(price)
    at = at or utcnow()

    if shares <= 0:
        raise LeagueError("share quantity must be positive")
    if price <= 0:
        raise LeagueError("price must be positive")
    if not rules.allow_fractional and shares != shares.to_integral_value():
        raise LeagueError(
            f"fractional shares are off for this league (tried {money.fmt_shares(shares)} {symbol})"
        )
    if rules.symbols and symbol not in rules.symbols:
        allowed = ", ".join(rules.symbols)
        raise LeagueError(f"{symbol} is not on this league's list ({allowed})")
    _check_window(league, at)

    entry = Entry(
        seq=league.next_seq(),
        kind=kind,
        player=player.id,
        at=at,
        symbol=symbol,
        shares=shares,
        price=price,
        commission=money.cash(commission) if commission is not None else rules.commission_on(shares * price),
        note=note,
    )

    before = replay(league, player)
    after = replay_with(league, player, entry)

    if after.cash < 0 and not rules.allow_negative_cash:
        short_by = money.fmt_money(-after.cash, _symbol(league))
        raise LeagueError(
            f"{player.name} is {short_by} short: cash {money.fmt_money(before.cash, _symbol(league))}, "
            f"trade costs {money.fmt_money(-entry.cash_delta(), _symbol(league))}"
        )
    pos_after = after.position(symbol)
    if pos_after.shares < 0 and not rules.allow_short:
        held = before.position(symbol).shares
        raise LeagueError(
            f"short selling is off for this league: {player.name} holds "
            f"{money.fmt_shares(held)} {symbol}, tried to sell {money.fmt_shares(shares)}"
        )
    if rules.max_position_pct is not None and pos_after.shares != 0:
        _check_concentration(league, after, symbol, price, prices or {})

    league.entries.append(entry)
    return entry, after


def replay_with(league: League, player: Player, entry: Entry) -> Portfolio:
    """Portfolio as it would stand if ``entry`` were appended — no mutation."""
    pf = replay(league, player)
    _apply(pf, entry)
    return pf


def _check_concentration(league: League, pf: Portfolio, symbol: str, price: Decimal, prices: dict) -> None:
    marks = {sym: {"price": money.price(_get(q, "price"))} for sym, q in prices.items()
             if _get(q, "price") is not None}
    marks[symbol] = {"price": price}
    valuation = value_portfolio(pf, marks)
    equity = valuation.equity
    if equity <= 0:
        return
    held = abs(money.cash(pf.position(symbol).shares * price))
    share_of_book = money.pct(held, equity)
    cap = league.rules.max_position_pct
    if share_of_book > cap:
        raise LeagueError(
            f"position cap exceeded: {symbol} would be {share_of_book}% of "
            f"{pf.player.name}'s book (cap {cap}%)"
        )


def cash_entry(league: League, player_ref: str, kind: str, amount: Decimal,
               note: str = "", at: str | None = None) -> tuple[Entry, Portfolio]:
    player = league.player(player_ref)
    amount = money.cash(amount)
    if amount <= 0:
        raise LeagueError("amount must be positive")
    entry = Entry(seq=league.next_seq(), kind=kind, player=player.id,
                  at=at or utcnow(), amount=amount, note=note)
    after = replay_with(league, player, entry)
    if after.cash < 0 and not league.rules.allow_negative_cash:
        raise LeagueError(
            f"{player.name} only has {money.fmt_money(replay(league, player).cash, _symbol(league))}"
        )
    league.entries.append(entry)
    return entry, after


def undo_last(league: League, player_ref: str | None = None) -> Entry:
    candidates = league.entries
    if player_ref:
        pid = league.player(player_ref).id
        candidates = [e for e in league.entries if e.player == pid]
    if not candidates:
        raise LeagueError("nothing to undo")
    last = max(candidates, key=lambda e: e.seq)
    league.entries = [e for e in league.entries if e.seq != last.seq]
    return last


def take_snapshot(league: League, prices: dict, label: str = "") -> Snapshot:
    rows = leaderboard(league, prices)
    snap = Snapshot(at=utcnow(), label=label,
                    equity={v.player.id: v.equity for v in rows})
    league.snapshots.append(snap)
    return snap


def _symbol(league: League) -> str:
    return {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}.get(league.currency, "")


def parse_when(value: str | None) -> str:
    """Accept ``2026-09-01``, a full ISO timestamp, or ``now``."""
    if not value or value.lower() == "now":
        return utcnow()
    text = value.strip()
    try:
        if len(text) == 10:
            date.fromisoformat(text)
            return f"{text}T00:00:00+00:00"
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp.replace(microsecond=0).isoformat()
    except ValueError as exc:
        raise LeagueError(f"could not read date {value!r} (use YYYY-MM-DD)") from exc
