"""Rendering: terminal tables, CSV and a shareable HTML standings page."""

from __future__ import annotations

import csv
import html
import io
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal

from . import money
from .engine import Valuation

CURRENCY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CAD": "C$", "AUD": "A$"}

GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def use_color(stream=None) -> bool:
    stream = stream or sys.stdout
    if os.environ.get("NO_COLOR") or os.environ.get("FSX_NO_COLOR"):
        return False
    return hasattr(stream, "isatty") and stream.isatty()


def tint(text: str, value: Decimal, enabled: bool) -> str:
    if not enabled or value == 0:
        return text
    return f"{GREEN if value > 0 else RED}{text}{RESET}"


def sym(currency: str) -> str:
    return CURRENCY_SYMBOLS.get(currency, currency + " ")


class Table:
    """Minimal column-aligned table; ANSI colour does not disturb widths."""

    def __init__(self, headers, aligns=None):
        self.headers = list(headers)
        self.aligns = list(aligns or ["l"] * len(self.headers))
        self.rows: list[list[tuple[str, str]]] = []

    def add(self, *cells):
        row = []
        for cell in cells:
            if isinstance(cell, tuple):
                row.append((str(cell[0]), str(cell[1])))
            else:
                row.append((str(cell), str(cell)))
        self.rows.append(row)

    def render(self) -> str:
        widths = [len(h) for h in self.headers]
        for row in self.rows:
            for i, (plain, _) in enumerate(row):
                widths[i] = max(widths[i], len(plain))
        lines = []
        head = "  ".join(
            h.ljust(widths[i]) if self.aligns[i] == "l" else h.rjust(widths[i])
            for i, h in enumerate(self.headers)
        )
        lines.append(head.rstrip())
        lines.append("  ".join("-" * w for w in widths))
        for row in self.rows:
            cells = []
            for i, (plain, shown) in enumerate(row):
                pad = widths[i] - len(plain)
                cells.append(shown + " " * pad if self.aligns[i] == "l" else " " * pad + shown)
            lines.append("  ".join(cells).rstrip())
        return "\n".join(lines)


def leaderboard_table(rows: list[Valuation], currency: str, color: bool) -> str:
    unit = sym(currency)
    table = Table(
        ["#", "Player", "Equity", "Cash", "Day", "Total P&L", "Return", "Positions"],
        ["r", "l", "r", "r", "r", "r", "r", "r"],
    )
    for rank, value in enumerate(rows, start=1):
        pnl = value.total_pnl
        day = value.day_change
        table.add(
            rank,
            value.player.name,
            money.fmt_money(value.equity, unit),
            money.fmt_money(value.portfolio.cash, unit),
            (money.fmt_signed(day, unit), tint(money.fmt_signed(day, unit), day, color)),
            (money.fmt_signed(pnl, unit), tint(money.fmt_signed(pnl, unit), pnl, color)),
            (money.fmt_pct(value.return_pct), tint(money.fmt_pct(value.return_pct), pnl, color)),
            len(value.positions),
        )
    return table.render()


def portfolio_table(value: Valuation, currency: str, color: bool) -> str:
    unit = sym(currency)
    table = Table(
        ["Symbol", "Shares", "Avg cost", "Price", "Value", "Unrealized", "Return", "Weight"],
        ["l", "r", "r", "r", "r", "r", "r", "r"],
    )
    equity = value.equity
    for pv in value.positions:
        pos = pv.position
        unreal = pv.unrealized
        label = pos.symbol + (" (short)" if pos.is_short else "")
        price_text = "—" if pv.price is None else money.fmt_money(pv.price, unit)
        ret = money.pct(unreal, abs(pos.cost_basis))
        table.add(
            label,
            money.fmt_shares(pos.shares),
            money.fmt_money(pos.avg_price, unit),
            price_text,
            money.fmt_money(pv.market_value, unit),
            (money.fmt_signed(unreal, unit), tint(money.fmt_signed(unreal, unit), unreal, color)),
            (money.fmt_pct(ret), tint(money.fmt_pct(ret), unreal, color)),
            money.fmt_pct(money.pct(abs(pv.market_value), equity)).lstrip("+"),
        )
    return table.render()


def ledger_table(entries, league, color: bool) -> str:
    unit = sym(league.currency)
    names = {p.id: p.name for p in league.players}
    table = Table(["#", "When", "Player", "Action", "Symbol", "Shares", "Price", "Cash", "Note"],
                  ["r", "l", "l", "l", "l", "r", "r", "r", "l"])
    for entry in entries:
        delta = entry.cash_delta()
        table.add(
            entry.seq,
            entry.at[:16].replace("T", " "),
            names.get(entry.player, entry.player),
            entry.kind.title(),
            entry.symbol or "",
            money.fmt_shares(entry.shares) if entry.symbol else "",
            money.fmt_money(entry.price, unit) if entry.symbol else money.fmt_money(entry.amount, unit),
            (money.fmt_signed(delta, unit), tint(money.fmt_signed(delta, unit), delta, color)),
            entry.note,
        )
    return table.render()


def leaderboard_csv(rows: list[Valuation]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["rank", "player", "equity", "cash", "market_value",
                     "day_change", "realized", "unrealized", "total_pnl", "return_pct", "positions"])
    for rank, v in enumerate(rows, start=1):
        writer.writerow([rank, v.player.name, v.equity, v.portfolio.cash, v.market_value,
                         v.day_change, v.portfolio.realized, v.unrealized, v.total_pnl,
                         v.return_pct, len(v.positions)])
    return buffer.getvalue()


def positions_csv(rows: list[Valuation]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["player", "symbol", "shares", "avg_cost", "price", "market_value", "unrealized"])
    for v in rows:
        for pv in v.positions:
            writer.writerow([v.player.name, pv.position.symbol, pv.position.shares,
                             pv.position.avg_price,
                             "" if pv.price is None else pv.price,
                             pv.market_value, pv.unrealized])
    return buffer.getvalue()


def leaderboard_html(rows: list[Valuation], league, note: str = "") -> str:
    unit = sym(league.currency)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = []
    for rank, v in enumerate(rows, start=1):
        pnl_class = "up" if v.total_pnl > 0 else ("down" if v.total_pnl < 0 else "flat")
        day_class = "up" if v.day_change > 0 else ("down" if v.day_change < 0 else "flat")
        holdings = ", ".join(
            f"{html.escape(pv.position.symbol)} {money.fmt_shares(pv.position.shares)}"
            for pv in v.positions
        ) or "—"
        body.append(f"""      <tr>
        <td class="rank">{rank}</td>
        <td class="name">{html.escape(v.player.name)}</td>
        <td class="num">{money.fmt_money(v.equity, unit)}</td>
        <td class="num">{money.fmt_money(v.portfolio.cash, unit)}</td>
        <td class="num {day_class}">{money.fmt_signed(v.day_change, unit)}</td>
        <td class="num {pnl_class}">{money.fmt_signed(v.total_pnl, unit)}</td>
        <td class="num {pnl_class}">{money.fmt_pct(v.return_pct)}</td>
        <td class="holdings">{holdings}</td>
      </tr>""")
    rows_html = "\n".join(body)
    note_html = f'<p class="note">{html.escape(note)}</p>' if note else ""
    return f"""<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(league.name)} — standings</title>
<style>
  :root {{ color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#e3e3e3;
           --up:#0a7d32; --down:#c02626; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --fg:#e9e9e9; --bg:#131313; --muted:#9a9a9a; --line:#2c2c2c;
             --up:#4ade80; --down:#f87171; }}
  }}
  body {{ margin:0; padding:32px 16px; background:var(--bg); color:var(--fg);
          font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }}
  main {{ max-width:900px; margin:0 auto; }}
  h1 {{ font-size:1.6rem; margin:0 0 4px; }}
  .sub, .note {{ color:var(--muted); font-size:.85rem; margin:0 0 20px; }}
  .wrap {{ overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }}
  th, td {{ padding:9px 10px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }}
  th {{ font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }}
  .num {{ text-align:right; }}
  .rank {{ color:var(--muted); width:2rem; }}
  .name {{ font-weight:600; }}
  .holdings {{ color:var(--muted); font-size:.82rem; white-space:normal; }}
  .up {{ color:var(--up); }} .down {{ color:var(--down); }}
  tbody tr:first-child .name::after {{ content:" 🏆"; }}
</style>
<main>
  <h1>{html.escape(league.name)}</h1>
  <p class="sub">Standings as of {generated}</p>
  {note_html}
  <div class="wrap">
  <table>
    <thead><tr>
      <th></th><th>Player</th><th class="num">Equity</th><th class="num">Cash</th>
      <th class="num">Day</th><th class="num">Total P&amp;L</th><th class="num">Return</th><th>Holdings</th>
    </tr></thead>
    <tbody>
{rows_html}
    </tbody>
  </table>
  </div>
</main>
"""
