"""Quote parsing against a canned Yahoo payload, plus the offline fallback."""

import unittest
from unittest import mock

from fsx import money, quotes
from fsx.models import League


def yahoo_payload(price=508.41, change_pct=2.579, closes=(493.95, 491.65, 495.63, 508.41)):
    return {
        "chart": {
            "error": None,
            "result": [{
                "meta": {
                    "symbol": "MSFT", "currency": "USD", "regularMarketPrice": price,
                    "regularMarketChangePercent": change_pct, "regularMarketTime": 1789409662,
                    "longName": "Microsoft Corporation", "fullExchangeName": "NasdaqGS",
                    "chartPreviousClose": 499.7,
                },
                "timestamp": [1788874200, 1788960600, 1789047000, 1789392600],
                "indicators": {"quote": [{"close": list(closes)}]},
            }],
        }
    }


class ParseTests(unittest.TestCase):
    def test_quote_fields(self):
        with mock.patch.object(quotes, "_fetch", return_value=yahoo_payload()):
            quote = quotes.fetch_quote("msft")
        self.assertEqual(quote.symbol, "MSFT")
        self.assertEqual(quote.price, money.price("508.41"))
        self.assertEqual(quote.name, "Microsoft Corporation")
        self.assertEqual(quote.currency, "USD")
        # prev close is derived from the reported day change: 508.41 / 1.02579
        self.assertEqual(quote.prev_close, money.price("495.63"))
        self.assertEqual(quote.day_change_pct, money.dec("2.58"))

    def test_prev_close_falls_back_to_the_prior_session(self):
        payload = yahoo_payload()
        del payload["chart"]["result"][0]["meta"]["regularMarketChangePercent"]
        with mock.patch.object(quotes, "_fetch", return_value=payload):
            quote = quotes.fetch_quote("MSFT")
        self.assertEqual(quote.prev_close, money.price("495.63"))

    def test_missing_price_is_an_error(self):
        payload = yahoo_payload()
        payload["chart"]["result"][0]["meta"] = {"symbol": "MSFT"}
        with mock.patch.object(quotes, "_fetch", return_value=payload):
            with self.assertRaises(quotes.QuoteError):
                quotes.fetch_quote("MSFT")

    def test_api_error_is_reported(self):
        payload = {"chart": {"error": {"description": "No data found, symbol may be delisted"},
                             "result": None}}
        with mock.patch.object(quotes, "_fetch", return_value=payload):
            with self.assertRaisesRegex(quotes.QuoteError, "delisted"):
                quotes.fetch_quote("NOPE")

    def test_close_on_picks_the_last_session_at_or_before_the_date(self):
        payload = {"chart": {"error": None, "result": [{
            "meta": {"symbol": "AAPL", "currency": "USD"},
            # closes for 2026-09-09, 2026-09-10 and 2026-09-14 (20:00 UTC each)
            "timestamp": [1788984000, 1789070400, 1789416000],
            "indicators": {"quote": [{"close": [200.0, 210.0, 230.0]}]},
        }]}}
        with mock.patch.object(quotes, "_fetch", return_value=payload):
            quote = quotes.close_on("AAPL", "2026-09-11")
        self.assertEqual(quote.price, money.price("210"))

    def test_fetch_many_survives_one_bad_symbol(self):
        def fake(symbol, timeout=15):
            if symbol == "BAD":
                raise quotes.QuoteError("BAD: no such symbol")
            return quotes.Quote(symbol=symbol, price=money.price("10"))
        with mock.patch.object(quotes, "fetch_quote", side_effect=fake):
            got, errors = quotes.fetch_many(["GOOD", "BAD"])
        self.assertIn("GOOD", got)
        self.assertIn("BAD", errors)


class PriceBookTests(unittest.TestCase):
    def test_offline_uses_stored_prices_and_flags_them_stale(self):
        league = League(name="L")
        league.last_prices["AAPL"] = quotes.Quote(symbol="AAPL", price=money.price("123.45")).to_dict()
        book = quotes.PriceBook(league, offline=True)
        got = book.load(["AAPL", "MSFT"])
        self.assertEqual(got["AAPL"].price, money.price("123.45"))
        self.assertTrue(got["AAPL"].stale)
        self.assertNotIn("MSFT", got)
        self.assertEqual(book.stale_symbols, ["AAPL"])

    def test_fresh_quotes_are_written_back_to_the_league(self):
        league = League(name="L")
        fresh = {"AAPL": quotes.Quote(symbol="AAPL", price=money.price("200"))}
        with mock.patch.object(quotes, "fetch_many", return_value=(fresh, {})):
            book = quotes.PriceBook(league)
            book.load(["AAPL"])
        self.assertEqual(league.last_prices["AAPL"]["price"], "200.0000")
        self.assertEqual(book.stale_symbols, [])

    def test_network_failure_falls_back_to_the_last_known_price(self):
        league = League(name="L")
        league.last_prices["AAPL"] = quotes.Quote(symbol="AAPL", price=money.price("99")).to_dict()
        with mock.patch.object(quotes, "fetch_many", return_value=({}, {"AAPL": "AAPL: unreachable"})):
            book = quotes.PriceBook(league)
            got = book.load(["AAPL"])
        self.assertEqual(got["AAPL"].price, money.price("99"))
        self.assertTrue(got["AAPL"].stale)


if __name__ == "__main__":
    unittest.main()
