"""``fsx`` — command line for running a fantasy stock exchange league."""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path

from . import engine, money, report, store
from .models import BUY, SELL, DEPOSIT, WITHDRAW, League, LeagueError, Rules
from .quotes import PriceBook, QuoteError, close_on, fetch_quote

PROG = "fsx"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _color(args) -> bool:
    return not getattr(args, "no_color", False) and report.use_color()


def _unit(league: League) -> str:
    return report.sym(league.currency)


def _load(args) -> tuple[Path, League]:
    path = store.resolve_path(args.file)
    return path, store.load(path)


def _emit(args, payload: dict, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, default=str))
    elif text:
        print(text)


def _price_book(args, league: League, symbols) -> PriceBook:
    book = PriceBook(league, offline=getattr(args, "offline", False))
    book.load(symbols)
    return book


def _warn_prices(book: PriceBook) -> None:
    for symbol, message in sorted(book.errors.items()):
        if symbol in book.quotes:
            continue
        print(f"warning: {message}", file=sys.stderr)
    stale = book.stale_symbols
    if stale:
        print(f"note: using last known prices for {', '.join(stale)}", file=sys.stderr)


def _valuation_dict(value) -> dict:
    return {
        "player": value.player.name,
        "id": value.player.id,
        "equity": str(value.equity),
        "cash": str(value.portfolio.cash),
        "market_value": str(value.market_value),
        "day_change": str(value.day_change),
        "realized": str(value.portfolio.realized),
        "unrealized": str(value.unrealized),
        "total_pnl": str(value.total_pnl),
        "return_pct": str(value.return_pct),
        "trades": value.portfolio.trade_count,
        "positions": [
            {
                "symbol": pv.position.symbol,
                "shares": str(pv.position.shares),
                "avg_cost": str(pv.position.avg_price),
                "price": None if pv.price is None else str(pv.price),
                "market_value": str(pv.market_value),
                "unrealized": str(pv.unrealized),
            }
            for pv in value.positions
        ],
    }


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_init(args) -> int:
    path = store.resolve_path(args.file)
    if path.exists() and not args.force:
        raise LeagueError(f"{path} already exists (use --force to overwrite)")
    rules = Rules(
        starting_cash=money.cash(args.cash),
        commission_flat=money.cash(args.commission_flat),
        commission_pct=money.dec(args.commission_pct),
        allow_fractional=args.fractional,
        allow_short=args.allow_short,
        allow_negative_cash=False,
        max_position_pct=None if args.max_position is None else money.dec(args.max_position),
        symbols=[s.strip().upper() for s in (args.symbols or "").split(",") if s.strip()],
        opens_at=args.opens,
        closes_at=args.closes,
    )
    league = League(name=args.name, currency=args.currency.upper(), rules=rules)
    store.save(path, league, backup=False)
    unit = _unit(league)
    lines = [
        f"Created “{league.name}” at {path}",
        f"  Starting stake   {money.fmt_money(rules.starting_cash, unit)} per player",
        f"  Commission       {money.fmt_money(rules.commission_flat, unit)} + {rules.commission_pct}% of notional",
        f"  Fractional       {'yes' if rules.allow_fractional else 'no'}",
        f"  Short selling    {'yes' if rules.allow_short else 'no'}",
    ]
    if rules.max_position_pct is not None:
        lines.append(f"  Position cap     {rules.max_position_pct}% of equity")
    if rules.symbols:
        lines.append(f"  Tradable         {', '.join(rules.symbols)}")
    if rules.opens_at or rules.closes_at:
        lines.append(f"  Window           {rules.opens_at or 'any'} → {rules.closes_at or 'any'}")
    lines.append(f"\nNext: {PROG} add-player \"Alice\"")
    _emit(args, {"path": str(path), "league": league.to_dict()}, "\n".join(lines))
    return 0


def cmd_add_player(args) -> int:
    path, league = _load(args)
    player = engine.add_player(league, args.name, cash=args.cash, player_id=args.id)
    store.save(path, league)
    _emit(args, {"player": player.to_dict()},
          f"Added {player.name} (id: {player.id}) with "
          f"{money.fmt_money(player.starting_cash, _unit(league))}")
    return 0


def cmd_remove_player(args) -> int:
    path, league = _load(args)
    player = league.player(args.player)
    if not args.yes:
        count = sum(1 for _ in league.entries_for(player.id))
        answer = input(f"Remove {player.name} and {count} ledger entries? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Cancelled.")
            return 1
    engine.remove_player(league, player.id)
    store.save(path, league)
    _emit(args, {"removed": player.to_dict()}, f"Removed {player.name}")
    return 0


def cmd_players(args) -> int:
    path, league = _load(args)
    if not league.players:
        _emit(args, {"players": []}, f"No players yet. Add one: {PROG} add-player \"Alice\"")
        return 0
    unit = _unit(league)
    table = report.Table(["ID", "Player", "Stake", "Cash", "Trades", "Joined"],
                         ["l", "l", "r", "r", "r", "l"])
    payload = []
    for player in league.players:
        pf = engine.replay(league, player)
        table.add(player.id, player.name, money.fmt_money(player.starting_cash, unit),
                  money.fmt_money(pf.cash, unit), pf.trade_count, player.joined_at[:10])
        payload.append({**player.to_dict(), "cash": str(pf.cash), "trades": pf.trade_count})
    _emit(args, {"players": payload}, table.render())
    return 0


def cmd_quote(args) -> int:
    color = _color(args)
    rows = []
    failures = 0
    for symbol in args.symbols:
        try:
            quote = close_on(symbol, args.on) if args.on else fetch_quote(symbol)
        except QuoteError as exc:
            print(f"error: {exc}", file=sys.stderr)
            failures += 1
            continue
        rows.append(quote)
    if not rows:
        return 1
    table = report.Table(["Symbol", "Price", "Change", "%", "Name", "As of"],
                         ["l", "r", "r", "r", "l", "l"])
    for quote in rows:
        change = quote.day_change
        unit = report.sym(quote.currency)
        change_text = "—" if quote.prev_close is None else money.fmt_signed(change, unit)
        pct_text = "—" if quote.prev_close is None else money.fmt_pct(quote.day_change_pct)
        table.add(quote.symbol, money.fmt_money(quote.price, unit),
                  (change_text, report.tint(change_text, change, color)),
                  (pct_text, report.tint(pct_text, change, color)),
                  quote.name[:32], quote.as_of[:16].replace("T", " "))
    _emit(args, {"quotes": [q.to_dict() for q in rows]}, table.render())
    return 1 if failures else 0


def _resolve_trade_price(args, symbol: str) -> tuple[Decimal, str]:
    """Returns (price, source description)."""
    if args.price is not None:
        return money.price(args.price), "manual price"
    if args.on:
        quote = close_on(symbol, args.on)
        return quote.price, f"close of {quote.as_of[:10]}"
    quote = fetch_quote(symbol)
    return quote.price, f"live {quote.exchange or 'market'} price"


def _trade(args, kind: str) -> int:
    path, league = _load(args)
    player = league.player(args.player)
    symbol = args.symbol.upper()
    price, source = _resolve_trade_price(args, symbol)

    if args.all:
        if kind != SELL:
            raise LeagueError("--all only makes sense when selling")
        held = engine.replay(league, player).position(symbol).shares
        if held <= 0:
            raise LeagueError(f"{player.name} holds no {symbol} to sell")
        shares = held
    elif args.amount is not None:
        budget = money.cash(args.amount)
        raw = budget / price
        shares = money.shares(raw) if league.rules.allow_fractional else money.shares(int(raw))
        if shares <= 0:
            raise LeagueError(
                f"{money.fmt_money(budget, _unit(league))} does not buy a whole share of "
                f"{symbol} at {money.fmt_money(price, _unit(league))}"
            )
    elif args.shares is None:
        raise LeagueError("give a share count, --amount CASH, or --all")
    else:
        shares = money.shares(args.shares)

    when = engine.parse_when(args.date or args.on)
    prices = {}
    if league.rules.max_position_pct is not None:
        held = [p.symbol for p in engine.replay(league, player).open_positions()]
        prices = _price_book(args, league, [s for s in held if s != symbol]).quotes

    entry, pf = engine.trade(league, player.id, kind, symbol, shares, price,
                             at=when, note=args.note or "", prices=prices)
    store.save(path, league)

    unit = _unit(league)
    verb = "Bought" if kind == BUY else "Sold"
    pos = pf.position(symbol)
    lines = [
        f"{verb} {money.fmt_shares(shares)} {symbol} @ {money.fmt_money(price, unit)} "
        f"for {player.name}  ({source})",
        f"  Notional    {money.fmt_money(entry.notional, unit)}"
        + (f"   commission {money.fmt_money(entry.commission, unit)}" if entry.commission else ""),
        f"  Cash        {money.fmt_money(pf.cash, unit)}",
        f"  Position    {money.fmt_shares(pos.shares)} {symbol}"
        + (f" @ avg {money.fmt_money(pos.avg_price, unit)}" if pos.shares else " (flat)"),
        f"  Realized    {money.fmt_signed(pf.realized, unit)}",
    ]
    _emit(args, {"entry": entry.to_dict(), "cash": str(pf.cash),
                 "position": {"symbol": symbol, "shares": str(pos.shares),
                              "avg_cost": str(pos.avg_price)},
                 "realized": str(pf.realized)}, "\n".join(lines))
    return 0


def cmd_buy(args) -> int:
    return _trade(args, BUY)


def cmd_sell(args) -> int:
    return _trade(args, SELL)


def _cash_move(args, kind: str) -> int:
    path, league = _load(args)
    entry, pf = engine.cash_entry(league, args.player, kind, money.cash(args.amount),
                                  note=args.note or "", at=engine.parse_when(args.date))
    store.save(path, league)
    unit = _unit(league)
    word = "Deposited" if kind == DEPOSIT else "Withdrew"
    _emit(args, {"entry": entry.to_dict(), "cash": str(pf.cash)},
          f"{word} {money.fmt_money(entry.amount, unit)} for {league.player(args.player).name}; "
          f"cash now {money.fmt_money(pf.cash, unit)}")
    return 0


def cmd_deposit(args) -> int:
    return _cash_move(args, DEPOSIT)


def cmd_withdraw(args) -> int:
    return _cash_move(args, WITHDRAW)


def cmd_portfolio(args) -> int:
    path, league = _load(args)
    player = league.player(args.player)
    pf = engine.replay(league, player)
    book = _price_book(args, league, [p.symbol for p in pf.open_positions()])
    if not args.offline:
        store.save(path, league)
    value = engine.value_portfolio(pf, book.quotes)
    _warn_prices(book)

    unit = _unit(league)
    color = _color(args)
    header = [
        f"{player.name}  —  {league.name}",
        f"  Equity      {money.fmt_money(value.equity, unit)}"
        f"   ({report.tint(money.fmt_signed(value.total_pnl, unit), value.total_pnl, color)}"
        f", {report.tint(money.fmt_pct(value.return_pct), value.total_pnl, color)} on "
        f"{money.fmt_money(pf.invested_base, unit)})",
        f"  Cash        {money.fmt_money(pf.cash, unit)}",
        f"  Holdings    {money.fmt_money(value.market_value, unit)} across {len(value.positions)} position(s)",
        f"  Day change  {report.tint(money.fmt_signed(value.day_change, unit), value.day_change, color)}",
        f"  Realized    {report.tint(money.fmt_signed(pf.realized, unit), pf.realized, color)}"
        f"   Unrealized {report.tint(money.fmt_signed(value.unrealized, unit), value.unrealized, color)}"
        f"   Fees {money.fmt_money(pf.commissions, unit)}",
    ]
    text = "\n".join(header)
    if value.positions:
        text += "\n\n" + report.portfolio_table(value, league.currency, color)
    else:
        text += "\n\n  (no open positions)"
    _emit(args, _valuation_dict(value), text)
    return 0


def cmd_standings(args) -> int:
    path, league = _load(args)
    if not league.players:
        _emit(args, {"standings": []}, "No players yet.")
        return 0
    book = _price_book(args, league, league.symbols_held())
    if not args.offline:
        store.save(path, league)
    rows = engine.leaderboard(league, book.quotes)
    _warn_prices(book)
    color = _color(args)
    unit = _unit(league)
    pot = money.cash(sum((v.equity for v in rows), money.ZERO))
    head = f"{league.name}  —  {len(rows)} players, {money.fmt_money(pot, unit)} on the board"
    if league.rules.closes_at:
        head += f"   (closes {league.rules.closes_at})"
    text = head + "\n\n" + report.leaderboard_table(rows, league.currency, color)
    _emit(args, {"league": league.name,
                 "standings": [_valuation_dict(v) for v in rows]}, text)
    return 0


def cmd_history(args) -> int:
    path, league = _load(args)
    entries = sorted(league.entries, key=lambda e: e.seq)
    if args.player:
        entries = [e for e in entries if e.player == league.player(args.player).id]
    if args.symbol:
        entries = [e for e in entries if (e.symbol or "") == args.symbol.upper()]
    if not entries:
        _emit(args, {"entries": []}, "No matching ledger entries.")
        return 0
    shown = entries if args.all else entries[-args.limit:]
    text = report.ledger_table(shown, league, _color(args))
    if len(shown) < len(entries):
        text += f"\n\n({len(shown)} of {len(entries)} entries — use --all for everything)"
    _emit(args, {"entries": [e.to_dict() for e in shown]}, text)
    return 0


def cmd_undo(args) -> int:
    path, league = _load(args)
    candidates = [e for e in league.entries
                  if not args.player or e.player == league.player(args.player).id]
    if not candidates:
        raise LeagueError("nothing to undo")
    last = max(candidates, key=lambda e: e.seq)
    names = {p.id: p.name for p in league.players}
    describe = (f"#{last.seq} {last.kind} {money.fmt_shares(last.shares)} {last.symbol} "
                f"@ {money.fmt_money(last.price, _unit(league))}" if last.symbol
                else f"#{last.seq} {last.kind} {money.fmt_money(last.amount, _unit(league))}")
    if not args.yes:
        answer = input(f"Undo {describe} for {names.get(last.player, last.player)}? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Cancelled.")
            return 1
    engine.undo_last(league, args.player)
    store.save(path, league)
    _emit(args, {"undone": last.to_dict()}, f"Undid {describe}")
    return 0


def cmd_snapshot(args) -> int:
    path, league = _load(args)
    book = _price_book(args, league, league.symbols_held())
    snap = engine.take_snapshot(league, book.quotes, label=args.label or "")
    store.save(path, league)
    _warn_prices(book)
    unit = _unit(league)
    names = {p.id: p.name for p in league.players}
    lines = [f"Snapshot #{len(league.snapshots)} {('“' + snap.label + '” ') if snap.label else ''}"
             f"at {snap.at[:16].replace('T', ' ')}"]
    for pid, equity in sorted(snap.equity.items(), key=lambda kv: kv[1], reverse=True):
        lines.append(f"  {names.get(pid, pid):<20} {money.fmt_money(equity, unit)}")
    _emit(args, {"snapshot": snap.to_dict()}, "\n".join(lines))
    return 0


def cmd_progress(args) -> int:
    path, league = _load(args)
    if not league.snapshots:
        _emit(args, {"snapshots": []},
              f"No snapshots yet. Record one with: {PROG} snapshot --label \"Week 1\"")
        return 0
    unit = _unit(league)
    names = {p.id: p.name for p in league.players}
    ids = [p.id for p in league.players]
    table = report.Table(["When", "Label"] + [names[i] for i in ids],
                         ["l", "l"] + ["r"] * len(ids))
    for snap in league.snapshots:
        table.add(snap.at[:16].replace("T", " "), snap.label,
                  *[money.fmt_money(snap.equity.get(i, 0), unit) for i in ids])
    _emit(args, {"snapshots": [s.to_dict() for s in league.snapshots]}, table.render())
    return 0


def cmd_export(args) -> int:
    path, league = _load(args)
    book = _price_book(args, league, league.symbols_held())
    if not args.offline:
        store.save(path, league)
    rows = engine.leaderboard(league, book.quotes)
    _warn_prices(book)
    note = ""
    if book.stale_symbols:
        note = "Prices for " + ", ".join(book.stale_symbols) + " are the last known values."
    if args.format == "html":
        content = report.leaderboard_html(rows, league, note=note)
    elif args.format == "csv":
        content = report.positions_csv(rows) if args.positions else report.leaderboard_csv(rows)
    else:
        content = json.dumps({"league": league.name,
                              "standings": [_valuation_dict(v) for v in rows]},
                             indent=2, default=str)
    if args.out:
        out = Path(args.out).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        print(f"Wrote {out}")
    else:
        sys.stdout.write(content)
    return 0


def cmd_rules(args) -> int:
    path, league = _load(args)
    rules = league.rules
    changed = []
    pairs = [
        ("cash", "starting_cash", money.cash),
        ("commission_flat", "commission_flat", money.cash),
        ("commission_pct", "commission_pct", money.dec),
        ("max_position", "max_position_pct", lambda v: None if str(v).lower() in ("none", "off") else money.dec(v)),
        ("opens", "opens_at", str),
        ("closes", "closes_at", str),
    ]
    for arg_name, field, cast in pairs:
        value = getattr(args, arg_name)
        if value is not None:
            setattr(rules, field, cast(value))
            changed.append(field)
    for arg_name, field in (("fractional", "allow_fractional"),
                            ("shorting", "allow_short"),
                            ("margin", "allow_negative_cash")):
        value = getattr(args, arg_name)
        if value is not None:
            setattr(rules, field, value == "on")
            changed.append(field)
    if args.symbols is not None:
        rules.symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        changed.append("symbols")
    if changed:
        store.save(path, league)

    unit = _unit(league)
    lines = [
        f"{league.name} ({league.currency})  created {league.created_at[:10]}",
        f"  starting cash    {money.fmt_money(rules.starting_cash, unit)}",
        f"  commission       {money.fmt_money(rules.commission_flat, unit)} flat + {rules.commission_pct}%",
        f"  fractional       {'on' if rules.allow_fractional else 'off'}",
        f"  short selling    {'on' if rules.allow_short else 'off'}",
        f"  margin (cash<0)  {'on' if rules.allow_negative_cash else 'off'}",
        f"  position cap     {str(rules.max_position_pct) + '%' if rules.max_position_pct is not None else 'none'}",
        f"  tradable symbols {', '.join(rules.symbols) if rules.symbols else 'any'}",
        f"  trading window   {rules.opens_at or 'any'} → {rules.closes_at or 'any'}",
    ]
    if changed:
        lines.append("\nUpdated: " + ", ".join(changed)
                     + "\n(rule changes apply to future trades; the ledger is untouched)")
    _emit(args, {"rules": rules.to_dict(), "changed": changed}, "\n".join(lines))
    return 0


# ---------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------

def _add_global_flags(parser: argparse.ArgumentParser, suppress: bool = False) -> None:
    default = argparse.SUPPRESS if suppress else None
    flag_default = argparse.SUPPRESS if suppress else False
    parser.add_argument("--file", "-f", default=default,
                        help=f"league file (default: ./{store.DEFAULT_FILENAME} or $FSX_LEAGUE)")
    parser.add_argument("--offline", action="store_true", default=flag_default,
                        help="never hit the network; use stored prices")
    parser.add_argument("--json", action="store_true", default=flag_default,
                        help="machine-readable output")
    parser.add_argument("--no-color", action="store_true", default=flag_default,
                        help="disable coloured output")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description="Run a fantasy stock exchange league priced off the real market.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""examples:
  {PROG} init "Office League" --cash 100000 --commission-flat 5
  {PROG} add-player "Alice"
  {PROG} buy alice AAPL 25            # at the live market price
  {PROG} sell alice AAPL --all
  {PROG} buy bob VOO --amount 5000    # spend a cash amount instead
  {PROG} standings
  {PROG} snapshot --label "Week 1"
  {PROG} export --format html --out standings.html
""",
    )
    _add_global_flags(parser)
    # The same flags are accepted after the subcommand, because `fsx standings
    # --offline` is how people actually type it.  SUPPRESS keeps a flag given
    # before the subcommand from being reset by the subparser's default.
    common = argparse.ArgumentParser(add_help=False)
    _add_global_flags(common, suppress=True)

    sub = parser.add_subparsers(dest="command", required=True, metavar="command")

    def add(name, func, help_text, aliases=()):
        p = sub.add_parser(name, help=help_text, aliases=aliases, description=help_text,
                           parents=[common])
        p.set_defaults(func=func)
        return p

    p = add("init", cmd_init, "create a new league file")
    p.add_argument("name")
    p.add_argument("--cash", default="100000", help="starting stake per player (default: 100000)")
    p.add_argument("--currency", default="USD")
    p.add_argument("--commission-flat", default="0", help="flat fee per trade")
    p.add_argument("--commission-pct", default="0", help="percent of notional per trade")
    p.add_argument("--fractional", action="store_true", help="allow fractional shares")
    p.add_argument("--allow-short", action="store_true", help="allow short selling")
    p.add_argument("--max-position", help="cap any one position at this %% of equity")
    p.add_argument("--symbols", help="comma-separated whitelist of tradable symbols")
    p.add_argument("--opens", help="first trading date, YYYY-MM-DD")
    p.add_argument("--closes", help="last trading date, YYYY-MM-DD")
    p.add_argument("--force", action="store_true", help="overwrite an existing file")

    p = add("add-player", cmd_add_player, "add a player to the league", aliases=["join"])
    p.add_argument("name")
    p.add_argument("--cash", help="override the league starting stake")
    p.add_argument("--id", help="explicit short id (default: slug of the name)")

    p = add("remove-player", cmd_remove_player, "remove a player and their ledger entries")
    p.add_argument("player")
    p.add_argument("--yes", "-y", action="store_true", help="skip the confirmation")

    add("players", cmd_players, "list players and their cash")

    p = add("quote", cmd_quote, "look up real market prices")
    p.add_argument("symbols", nargs="+")
    p.add_argument("--on", help="closing price on a date, YYYY-MM-DD")

    for name, func, help_text in (("buy", cmd_buy, "buy shares for a player"),
                                  ("sell", cmd_sell, "sell shares for a player")):
        p = add(name, func, help_text)
        p.add_argument("player")
        p.add_argument("symbol")
        p.add_argument("shares", nargs="?", help="share count (omit when using --amount/--all)")
        p.add_argument("--amount", help="trade this much cash instead of a share count")
        p.add_argument("--all", action="store_true", help="sell the entire position")
        p.add_argument("--price", help="override the market price")
        p.add_argument("--on", help="use the closing price of this date, and date the trade then")
        p.add_argument("--date", help="record the trade at this date/time")
        p.add_argument("--note", help="free-text note on the ledger entry")

    for name, func, help_text in (("deposit", cmd_deposit, "add cash to a player's account"),
                                  ("withdraw", cmd_withdraw, "remove cash from a player's account")):
        p = add(name, func, help_text)
        p.add_argument("player")
        p.add_argument("amount")
        p.add_argument("--date")
        p.add_argument("--note")

    p = add("portfolio", cmd_portfolio, "show one player's holdings", aliases=["pf"])
    p.add_argument("player")

    add("standings", cmd_standings, "live leaderboard", aliases=["leaderboard", "board"])

    p = add("history", cmd_history, "show the trade ledger", aliases=["ledger"])
    p.add_argument("--player")
    p.add_argument("--symbol")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--all", action="store_true")

    p = add("undo", cmd_undo, "remove the most recent ledger entry")
    p.add_argument("--player", help="undo that player's last entry instead")
    p.add_argument("--yes", "-y", action="store_true")

    p = add("snapshot", cmd_snapshot, "record everyone's equity right now")
    p.add_argument("--label", help="e.g. \"Week 1\"")

    add("progress", cmd_progress, "equity per player across all snapshots")

    p = add("export", cmd_export, "export standings as html, csv or json")
    p.add_argument("--format", choices=["html", "csv", "json"], default="html")
    p.add_argument("--out", "-o", help="write to a file instead of stdout")
    p.add_argument("--positions", action="store_true", help="csv of positions rather than standings")

    p = add("rules", cmd_rules, "show or change league rules")
    p.add_argument("--cash", help="starting stake for players added later")
    p.add_argument("--commission-flat")
    p.add_argument("--commission-pct")
    p.add_argument("--fractional", choices=["on", "off"])
    p.add_argument("--shorting", choices=["on", "off"])
    p.add_argument("--margin", choices=["on", "off"], help="allow negative cash balances")
    p.add_argument("--max-position", help="percent cap, or 'off'")
    p.add_argument("--symbols", help="comma-separated whitelist, or '' for any")
    p.add_argument("--opens")
    p.add_argument("--closes")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (LeagueError, QuoteError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except money.AmountError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
