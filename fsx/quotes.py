"""Real market prices.

Yahoo Finance's chart endpoint is the default source: no key, no signup, and
it covers equities, ETFs, indices, FX and crypto with the same symbols people
already recognise.  Everything here degrades gracefully — if the network is
gone, the league's last known prices are used and the reports say so.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from decimal import Decimal

from . import money

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
USER_AGENT = "Mozilla/5.0 (compatible; fsx/1.0; fantasy stock exchange)"
DEFAULT_TIMEOUT = 15


class QuoteError(Exception):
    """A symbol could not be priced."""


@dataclass
class Quote:
    symbol: str
    price: Decimal
    prev_close: Decimal | None = None
    currency: str = "USD"
    name: str = ""
    exchange: str = ""
    as_of: str = ""
    stale: bool = False

    @property
    def day_change(self) -> Decimal:
        if self.prev_close is None:
            return money.ZERO
        return money.price(self.price - self.prev_close)

    @property
    def day_change_pct(self) -> Decimal:
        if not self.prev_close:
            return money.ZERO
        return money.pct(self.price - self.prev_close, self.prev_close)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["price"] = str(self.price)
        data["prev_close"] = None if self.prev_close is None else str(self.prev_close)
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Quote":
        prev = data.get("prev_close")
        return cls(
            symbol=data["symbol"],
            price=money.price(data["price"]),
            prev_close=None if prev in (None, "") else money.price(prev),
            currency=data.get("currency", "USD"),
            name=data.get("name", ""),
            exchange=data.get("exchange", ""),
            as_of=data.get("as_of", ""),
            stale=bool(data.get("stale", False)),
        )


def _fetch(url: str, timeout: int = DEFAULT_TIMEOUT) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _chart(symbol: str, params: dict, timeout: int = DEFAULT_TIMEOUT) -> dict:
    url = YAHOO_CHART.format(symbol=urllib.parse.quote(symbol.upper())) + "?" + urllib.parse.urlencode(params)
    try:
        payload = _fetch(url, timeout=timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise QuoteError(f"{symbol.upper()}: no such symbol on Yahoo Finance") from exc
        raise QuoteError(f"{symbol.upper()}: quote service returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise QuoteError(f"{symbol.upper()}: cannot reach quote service ({exc})") from exc
    except json.JSONDecodeError as exc:
        raise QuoteError(f"{symbol.upper()}: quote service sent a malformed reply") from exc

    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise QuoteError(f"{symbol.upper()}: {chart['error'].get('description', 'unknown error')}")
    results = chart.get("result") or []
    if not results:
        raise QuoteError(f"{symbol.upper()}: no data returned")
    return results[0]


def fetch_quote(symbol: str, timeout: int = DEFAULT_TIMEOUT) -> Quote:
    """Latest price for one symbol."""
    result = _chart(symbol, {"range": "5d", "interval": "1d"}, timeout=timeout)
    meta = result.get("meta") or {}
    raw_price = meta.get("regularMarketPrice")
    if raw_price is None:
        raw_price = meta.get("previousClose") or meta.get("chartPreviousClose")
    if raw_price is None:
        raise QuoteError(f"{symbol.upper()}: no price in the response")
    price = money.price(raw_price)

    # Yahoo reports the day change as a percentage rounded to three decimals, so
    # deriving the previous close from it is off by a fraction of a cent.  Use it
    # to identify which session was the previous close, then snap to that exact
    # close from the daily series when one lines up.
    prev = None
    change_pct = meta.get("regularMarketChangePercent")
    if change_pct not in (None, ""):
        divisor = Decimal(1) + money.dec(change_pct) / 100
        if divisor != 0:
            prev = money.price(price / divisor)
    closes = [c for c in (result.get("indicators", {}).get("quote", [{}])[0].get("close") or [])
              if c is not None]
    if prev is not None and closes:
        candidates = [money.price(c) for c in closes]
        nearest = min(candidates, key=lambda c: abs(c - prev))
        if prev == 0 or abs(nearest - prev) / prev < Decimal("0.0005"):
            prev = nearest
    if prev is None:
        if len(closes) >= 2:
            prev = money.price(closes[-2])
        elif meta.get("chartPreviousClose") is not None:
            prev = money.price(meta["chartPreviousClose"])

    stamp = meta.get("regularMarketTime")
    as_of = (datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat()
             if isinstance(stamp, (int, float)) else datetime.now(timezone.utc).isoformat())

    return Quote(
        symbol=meta.get("symbol", symbol.upper()).upper(),
        price=price,
        prev_close=prev,
        currency=meta.get("currency", "USD"),
        name=meta.get("longName") or meta.get("shortName") or "",
        exchange=meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        as_of=as_of,
    )


def close_on(symbol: str, day: str, timeout: int = DEFAULT_TIMEOUT) -> Quote:
    """Closing price on ``day`` (YYYY-MM-DD), or the last close before it.

    Backdating a trade to a weekend or holiday therefore still works: you get
    the most recent session at or before that date.
    """
    target = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    start = int(target.timestamp()) - 14 * 86400
    end = int(target.timestamp()) + 2 * 86400
    result = _chart(symbol, {"period1": start, "period2": end, "interval": "1d"}, timeout=timeout)
    stamps = result.get("timestamp") or []
    closes = (result.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    cutoff = int(target.timestamp()) + 86399
    chosen = None
    for stamp, close in zip(stamps, closes):
        if close is None or stamp > cutoff:
            continue
        chosen = (stamp, close)
    if chosen is None:
        raise QuoteError(f"{symbol.upper()}: no session on or before {day}")
    meta = result.get("meta") or {}
    return Quote(
        symbol=meta.get("symbol", symbol.upper()).upper(),
        price=money.price(chosen[1]),
        prev_close=None,
        currency=meta.get("currency", "USD"),
        name=meta.get("longName") or meta.get("shortName") or "",
        exchange=meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        as_of=datetime.fromtimestamp(chosen[0], tz=timezone.utc).isoformat(),
    )


def fetch_many(symbols, timeout: int = DEFAULT_TIMEOUT) -> tuple[dict[str, Quote], dict[str, str]]:
    """Fetch in parallel. Returns ``(quotes, errors)`` — partial results are fine."""
    symbols = [s.upper() for s in dict.fromkeys(symbols)]
    quotes: dict[str, Quote] = {}
    errors: dict[str, str] = {}
    if not symbols:
        return quotes, errors
    workers = min(8, len(symbols))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_quote, s, timeout): s for s in symbols}
        for future, symbol in futures.items():
            try:
                quotes[symbol] = future.result()
            except QuoteError as exc:
                errors[symbol] = str(exc)
            except Exception as exc:  # noqa: BLE001 - never let one symbol kill the run
                errors[symbol] = f"{symbol}: {exc}"
    return quotes, errors


class PriceBook:
    """Quotes for the league, backed by the file's last known prices.

    ``offline`` skips the network entirely; otherwise anything that fails to
    fetch falls back to the stored price and is flagged ``stale``.
    """

    def __init__(self, league, offline: bool = False, timeout: int = DEFAULT_TIMEOUT):
        self.league = league
        self.offline = offline
        self.timeout = timeout
        self.errors: dict[str, str] = {}
        self.quotes: dict[str, Quote] = {}

    def load(self, symbols) -> dict[str, Quote]:
        symbols = [s.upper() for s in dict.fromkeys(symbols)]
        if not symbols:
            return {}
        fresh: dict[str, Quote] = {}
        if not self.offline:
            fresh, self.errors = fetch_many(symbols, timeout=self.timeout)
            for symbol, quote in fresh.items():
                self.league.last_prices[symbol] = quote.to_dict()
        for symbol in symbols:
            if symbol in fresh:
                self.quotes[symbol] = fresh[symbol]
                continue
            stored = self.league.last_prices.get(symbol)
            if stored:
                quote = Quote.from_dict(stored)
                quote.stale = True
                self.quotes[symbol] = quote
        return self.quotes

    @property
    def stale_symbols(self) -> list[str]:
        return sorted(s for s, q in self.quotes.items() if q.stale)

    @property
    def missing(self) -> list[str]:
        return sorted(s for s in self.errors if s not in self.quotes)
