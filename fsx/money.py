"""Decimal helpers.

Every monetary amount in the league file is a ``Decimal`` serialised as a
string.  Floats are never used for cash, shares or prices: a fantasy league is
a ledger, and a ledger that drifts by a cent is a ledger nobody trusts.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CASH = Decimal("0.01")
SHARES = Decimal("0.00000001")
PRICE = Decimal("0.0001")

ZERO = Decimal("0")


class AmountError(ValueError):
    """Raised when a user-supplied number cannot be read as a Decimal."""


def dec(value) -> Decimal:
    """Coerce ``value`` to Decimal without going through binary floats."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        value = repr(value)
    if isinstance(value, str):
        value = value.strip().replace(",", "").replace("$", "")
        if value.endswith("%"):
            value = value[:-1]
    try:
        return Decimal(value)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise AmountError(f"not a number: {value!r}") from exc


def _q(value, exp: Decimal) -> Decimal:
    return dec(value).quantize(exp, rounding=ROUND_HALF_UP)


def cash(value) -> Decimal:
    return _q(value, CASH)


def shares(value) -> Decimal:
    return _q(value, SHARES)


def price(value) -> Decimal:
    return _q(value, PRICE)


def pct(part, whole) -> Decimal:
    """``part / whole`` as a percentage; zero denominator yields zero."""
    whole = dec(whole)
    if whole == 0:
        return ZERO
    return (dec(part) / whole * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def fmt_money(value, symbol: str = "$") -> str:
    value = cash(value)
    sign = "-" if value < 0 else ""
    return f"{sign}{symbol}{abs(value):,.2f}"


def fmt_signed(value, symbol: str = "$") -> str:
    """Signed amount; exactly zero carries no sign."""
    value = cash(value)
    if value == 0:
        return f"{symbol}0.00"
    sign = "-" if value < 0 else "+"
    return f"{sign}{symbol}{abs(value):,.2f}"


def fmt_shares(value) -> str:
    return format(shares(value).normalize(), "f")


def fmt_pct(value) -> str:
    """Signed percentage; a value that rounds to zero carries no sign, so a
    tiny loss never renders as ``+0.00%``."""
    value = dec(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if value == 0:
        return "0.00%"
    sign = "-" if value < 0 else "+"
    return f"{sign}{abs(value)}%"
