# fsx — fantasy stock exchange

A command-line tool for running a fantasy stock market league. Players get a
starting stake of pretend money and trade real tickers at **real market
prices**; `fsx` keeps the books, enforces the house rules and prints the
standings.

No API key, no account, no dependencies beyond the Python standard library.
Prices come from Yahoo Finance's public chart endpoint, so anything with a
Yahoo symbol works: stocks, ETFs, indices (`^GSPC`), FX (`EURUSD=X`) and
crypto (`BTC-USD`).

```
$ fsx standings
Office League  —  3 players, $300,606.43 on the board

#  Player       Equity        Cash       Day  Total P&L  Return  Positions
-  ------  -----------  ----------  --------  ---------  ------  ---------
1  Priya   $100,611.50  $85,376.60  +$366.00   +$611.50  +0.61%          1
2  Bob      $99,999.93  $70,089.60  -$868.56     -$0.07   0.00%          1
3  Alice    $99,995.00  $66,565.50  +$202.50     -$5.00  -0.01%          1
```

## Install

```bash
pip install -e .          # then use `fsx`
python -m fsx --help      # or run it straight from the source tree
```

Python 3.10 or newer. Nothing else.

## Run a league in five commands

```bash
fsx init "Office League" --cash 100000 --commission-flat 5
fsx add-player "Alice"
fsx buy alice AAPL 100            # fills at the live market price
fsx standings
fsx export --format html --out standings.html
```

The league lives in one JSON file (`./fsx-league.json` by default) — commit it,
drop it in Dropbox, or mail it around. Point anywhere else with `--file` or the
`FSX_LEAGUE` environment variable. Commands look for the file in the current
directory and its parents, so they work from anywhere inside a league folder.

## Trading

```bash
fsx buy alice AAPL 25                     # live price
fsx buy bob VOO --amount 5000             # spend a cash amount instead of counting shares
fsx sell alice AAPL --all                 # close the whole position
fsx sell alice AAPL 10 --price 212.40     # override the price (a fill you agreed offline)
fsx buy priya MSFT 50 --on 2026-08-14     # fill at that day's close, dated then
fsx buy bob NVDA 10 --note "week 3 pick"
fsx undo                                  # remove the last entry, exactly
```

`--on` takes the closing price of a real session; land on a weekend or a
holiday and you get the last session before it, so backfilling a league that
started weeks ago works.

Cash that isn't a trade:

```bash
fsx deposit alice 5000 --note "midseason top-up"
fsx withdraw bob 1000
```

Deposits move the return denominator, so topping a player up never shows as
performance.

## House rules

Set them at `init` or change them any time with `fsx rules`:

| Rule | Flag | Default |
|---|---|---|
| Starting stake | `--cash 100000` | $100,000 |
| Commission | `--commission-flat 5` `--commission-pct 0.1` | none |
| Fractional shares | `--fractional` | off |
| Short selling | `--allow-short` | off |
| Margin (negative cash) | `fsx rules --margin on` | off |
| Position cap | `--max-position 25` | none |
| Tradable symbols | `--symbols AAPL,MSFT,VOO` | anything |
| Trading window | `--opens 2026-01-01 --closes 2026-03-31` | always open |

Breaking one is refused with the numbers that explain why, and nothing is
written to the ledger:

```
$ fsx buy alice AAPL 500
error: Alice is $100,584.50 short: cash $66,565.50, trade costs $167,150.00

$ fsx buy bob NVDA --amount 50000
error: position cap exceeded: NVDA would be 79.76% of Bob's book (cap 40%)
```

Rule changes apply to future trades only; history is never rewritten.

## Standings, reports and history

```bash
fsx standings                 # live leaderboard
fsx portfolio alice           # one player's book, position by position
fsx history --player bob      # the ledger
fsx quote NVDA BTC-USD ^GSPC  # just look up prices
```

`fsx snapshot --label "Week 1"` freezes everyone's equity into the file, and
`fsx progress` lays the snapshots out side by side — that's your week-by-week
scoreboard.

`fsx export` writes the standings as a self-contained HTML page (light and dark,
readable on a phone — good for pinning in a group chat), as CSV for a
spreadsheet, or as JSON. Every command also takes `--json` for scripting.

## How the numbers work

- **Every amount is a `Decimal`.** Cash, shares and prices are parsed and
  stored as exact decimal strings. A season of trading doesn't drift a cent.
- **The ledger is the only source of truth.** Positions, cash and P&L are
  replayed from the trade log on every command, never stored alongside it. The
  file can't contradict itself, and `fsx undo` is an exact reversal rather than
  a guess at an inverse trade.
- **Signed average-cost accounting.** A sale realises P&L only on the shares
  sold. A trade that crosses zero (selling 8 when you hold 5) is split into two
  legs — close 5, then open a 3-share short — so a new position never inherits
  the old one's basis.
- **Commission is booked against realised P&L**, which keeps the identity
  `equity − stake = realised + unrealised` true at all times. A test asserts it
  after a deliberately messy sequence of trades.
- **Returns are measured against what a player was handed** (starting stake
  plus net deposits), not against cash spent.

### When the market can't be reached

Prices fetched are cached in the league file as last known values. If the
network is down, a symbol is delisted, or you pass `--offline`, valuations fall
back to those values and every affected report says so on stderr:

```
note: using last known prices for AAPL, MSFT
```

A position that has never been priced is carried at cost rather than silently
counted as zero.

## Tests

```bash
python -m unittest discover -s tests -t .
```

69 tests covering the ledger mechanics, every house rule, quote parsing against
a canned API payload (no network), the offline fallback, and end-to-end CLI
runs. `--price` makes the whole tool usable — and testable — without a network.

## Command reference

| Command | What it does |
|---|---|
| `init NAME` | create a league file |
| `add-player NAME` | add a player (`--cash` to override the stake) |
| `remove-player REF` | drop a player and their entries |
| `players` | list players and cash |
| `buy` / `sell` | trade shares (`--amount`, `--all`, `--price`, `--on`, `--date`, `--note`) |
| `deposit` / `withdraw` | move cash in or out |
| `portfolio REF` | one player's holdings and P&L |
| `standings` | the leaderboard |
| `history` | the ledger (`--player`, `--symbol`, `--limit`, `--all`) |
| `undo` | remove the most recent entry |
| `quote SYM...` | look up prices (`--on DATE`) |
| `snapshot` / `progress` | record and compare equity over time |
| `export` | html, csv or json standings |
| `rules` | show or change house rules |

Players can be named by id, full name, or any unambiguous fragment — `alice`,
`Alice`, or `ali`.

## License

MIT
