"""Ledger mechanics: cost basis, P&L, and every rule the league can enforce."""

import unittest
from decimal import Decimal

from fsx import engine, money
from fsx.models import BUY, SELL, DEPOSIT, League, LeagueError, Rules


def new_league(**rule_overrides) -> League:
    rules = Rules(starting_cash=money.cash("10000"), **rule_overrides)
    league = League(name="Test League", rules=rules)
    engine.add_player(league, "Alice")
    engine.add_player(league, "Bob")
    return league


def buy(league, player, symbol, shares, price, **kw):
    return engine.trade(league, player, BUY, symbol, money.shares(shares), money.price(price), **kw)


def sell(league, player, symbol, shares, price, **kw):
    return engine.trade(league, player, SELL, symbol, money.shares(shares), money.price(price), **kw)


class CostBasisTests(unittest.TestCase):
    def test_buy_moves_cash_and_sets_basis(self):
        league = new_league()
        _, pf = buy(league, "alice", "AAPL", 10, "100")
        self.assertEqual(pf.cash, money.cash("9000"))
        pos = pf.position("AAPL")
        self.assertEqual(pos.shares, money.shares("10"))
        self.assertEqual(pos.avg_price, money.price("100"))

    def test_average_cost_across_two_buys(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        _, pf = buy(league, "alice", "AAPL", 10, "120")
        self.assertEqual(pf.position("AAPL").avg_price, money.price("110"))

    def test_partial_sale_realizes_only_the_sold_shares(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        _, pf = sell(league, "alice", "AAPL", 4, "150")
        self.assertEqual(pf.realized, money.cash("200"))          # 4 x $50
        self.assertEqual(pf.position("AAPL").shares, money.shares("6"))
        self.assertEqual(pf.position("AAPL").avg_price, money.price("100"))

    def test_closing_a_position_clears_the_basis(self):
        league = new_league()
        buy(league, "alice", "AAPL", 5, "100")
        _, pf = sell(league, "alice", "AAPL", 5, "90")
        self.assertEqual(pf.position("AAPL").shares, money.ZERO)
        self.assertEqual(pf.position("AAPL").cost_basis, money.ZERO)
        self.assertEqual(pf.realized, money.cash("-50"))

    def test_sell_through_zero_splits_into_close_then_short(self):
        league = new_league(allow_short=True)
        buy(league, "alice", "AAPL", 5, "100")
        _, pf = sell(league, "alice", "AAPL", 8, "120")
        self.assertEqual(pf.realized, money.cash("100"))          # only the 5 long shares
        pos = pf.position("AAPL")
        self.assertEqual(pos.shares, money.shares("-3"))
        self.assertEqual(pos.avg_price, money.price("120"))       # short opened at the sale price

    def test_covering_a_short_realizes_the_gain(self):
        league = new_league(allow_short=True)
        sell(league, "alice", "AAPL", 10, "100")
        _, pf = buy(league, "alice", "AAPL", 10, "80")
        self.assertEqual(pf.realized, money.cash("200"))
        self.assertEqual(pf.position("AAPL").shares, money.ZERO)

    def test_commission_is_charged_to_cash_and_realized(self):
        league = new_league(commission_flat=money.cash("5"))
        _, pf = buy(league, "alice", "AAPL", 10, "100")
        self.assertEqual(pf.cash, money.cash("8995"))
        self.assertEqual(pf.commissions, money.cash("5"))
        self.assertEqual(pf.realized, money.cash("-5"))

    def test_percentage_commission(self):
        league = new_league(commission_pct=Decimal("0.5"))
        entry, pf = buy(league, "alice", "AAPL", 10, "100")
        self.assertEqual(entry.commission, money.cash("5"))       # 0.5% of $1000


class ReconciliationTests(unittest.TestCase):
    """equity - what the player was given == realized + unrealized. Always."""

    def test_identity_holds_after_a_messy_sequence(self):
        league = new_league(allow_short=True, allow_fractional=True,
                            commission_flat=money.cash("1"), commission_pct=Decimal("0.1"))
        buy(league, "alice", "AAPL", "10.5", "100")
        buy(league, "alice", "MSFT", 3, "410.25")
        sell(league, "alice", "AAPL", "4.25", "133.33")
        sell(league, "alice", "TSLA", 2, "250")        # opens a short
        buy(league, "alice", "AAPL", 1, "90")
        engine.cash_entry(league, "alice", DEPOSIT, money.cash("500"))
        pf = engine.replay(league, league.player("alice"))

        prices = {"AAPL": {"price": "141.00"}, "MSFT": {"price": "399.10"}, "TSLA": {"price": "230.00"}}
        value = engine.value_portfolio(pf, prices)
        self.assertEqual(value.total_pnl, money.cash(pf.realized + value.unrealized))


class RuleTests(unittest.TestCase):
    def test_cannot_spend_cash_the_player_does_not_have(self):
        league = new_league()
        with self.assertRaisesRegex(LeagueError, "short"):
            buy(league, "alice", "AAPL", 200, "100")
        self.assertEqual(league.entries, [])            # nothing was written

    def test_shorting_is_refused_by_default(self):
        league = new_league()
        buy(league, "alice", "AAPL", 5, "100")
        with self.assertRaisesRegex(LeagueError, "short selling is off"):
            sell(league, "alice", "AAPL", 6, "100")

    def test_fractional_shares_refused_by_default(self):
        league = new_league()
        with self.assertRaisesRegex(LeagueError, "[Ff]ractional"):
            buy(league, "alice", "AAPL", "1.5", "100")

    def test_fractional_shares_allowed_when_enabled(self):
        league = new_league(allow_fractional=True)
        _, pf = buy(league, "alice", "AAPL", "1.5", "100")
        self.assertEqual(pf.position("AAPL").shares, money.shares("1.5"))

    def test_symbol_whitelist(self):
        league = new_league(symbols=["AAPL", "MSFT"])
        buy(league, "alice", "AAPL", 1, "100")
        with self.assertRaisesRegex(LeagueError, "not on this league's list"):
            buy(league, "alice", "GME", 1, "20")

    def test_trading_window(self):
        league = new_league(opens_at="2026-01-01", closes_at="2026-03-31")
        buy(league, "alice", "AAPL", 1, "100", at="2026-02-01T00:00:00+00:00")
        with self.assertRaisesRegex(LeagueError, "opens"):
            buy(league, "alice", "AAPL", 1, "100", at="2025-12-31T00:00:00+00:00")
        with self.assertRaisesRegex(LeagueError, "closed"):
            buy(league, "alice", "AAPL", 1, "100", at="2026-04-01T00:00:00+00:00")

    def test_position_cap(self):
        league = new_league(max_position_pct=Decimal("30"))
        buy(league, "alice", "AAPL", 25, "100")                 # $2,500 of $10,000
        with self.assertRaisesRegex(LeagueError, "position cap"):
            buy(league, "alice", "AAPL", 10, "100")             # would be 35%

    def test_position_cap_uses_live_marks_for_other_holdings(self):
        league = new_league(max_position_pct=Decimal("50"))
        buy(league, "alice", "MSFT", 10, "100")
        # MSFT has doubled, so equity is larger and a bigger AAPL position fits.
        _, pf = buy(league, "alice", "AAPL", 45, "100", prices={"MSFT": {"price": "200"}})
        self.assertEqual(pf.position("AAPL").shares, money.shares("45"))

    def test_rejected_trades_never_touch_the_ledger(self):
        league = new_league()
        buy(league, "alice", "AAPL", 1, "100")
        with self.assertRaises(LeagueError):
            buy(league, "alice", "AAPL", 10000, "100")
        self.assertEqual(len(league.entries), 1)

    def test_bad_quantities(self):
        league = new_league()
        with self.assertRaises(LeagueError):
            buy(league, "alice", "AAPL", 0, "100")
        with self.assertRaises(LeagueError):
            buy(league, "alice", "AAPL", 1, "0")


class LedgerTests(unittest.TestCase):
    def test_undo_restores_the_previous_state_exactly(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        before = engine.replay(league, league.player("alice"))
        sell(league, "alice", "AAPL", 5, "130")
        engine.undo_last(league)
        after = engine.replay(league, league.player("alice"))
        self.assertEqual(before.cash, after.cash)
        self.assertEqual(before.realized, after.realized)
        self.assertEqual(before.position("AAPL").shares, after.position("AAPL").shares)

    def test_undo_targets_one_player(self):
        league = new_league()
        buy(league, "alice", "AAPL", 1, "100")
        buy(league, "bob", "MSFT", 1, "100")
        engine.undo_last(league, "alice")
        self.assertEqual([e.player for e in league.entries], ["bob"])

    def test_deposit_and_withdraw_change_the_return_denominator(self):
        league = new_league()
        engine.cash_entry(league, "alice", DEPOSIT, money.cash("5000"))
        pf = engine.replay(league, league.player("alice"))
        self.assertEqual(pf.cash, money.cash("15000"))
        self.assertEqual(pf.invested_base, money.cash("15000"))
        value = engine.value_portfolio(pf, {})
        self.assertEqual(value.total_pnl, money.ZERO)           # depositing is not a gain

    def test_players_are_isolated(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        bob = engine.replay(league, league.player("bob"))
        self.assertEqual(bob.cash, money.cash("10000"))
        self.assertEqual(bob.open_positions(), [])

    def test_player_lookup_by_id_name_and_prefix(self):
        league = new_league()
        self.assertEqual(league.player("alice").id, "alice")
        self.assertEqual(league.player("Alice").id, "alice")
        self.assertEqual(league.player("ali").id, "alice")
        with self.assertRaises(LeagueError):
            league.player("nobody")

    def test_duplicate_player_ids_refused(self):
        league = new_league()
        with self.assertRaisesRegex(LeagueError, "already exists"):
            engine.add_player(league, "Alice")

    def test_remove_player_takes_their_entries(self):
        league = new_league()
        buy(league, "alice", "AAPL", 1, "100")
        buy(league, "bob", "MSFT", 1, "100")
        engine.remove_player(league, "alice")
        self.assertEqual([p.id for p in league.players], ["bob"])
        self.assertEqual([e.player for e in league.entries], ["bob"])


class ValuationTests(unittest.TestCase):
    def test_leaderboard_is_ranked_by_equity(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        buy(league, "bob", "AAPL", 20, "100")
        rows = engine.leaderboard(league, {"AAPL": {"price": "150", "prev_close": "140"}})
        self.assertEqual([r.player.id for r in rows], ["bob", "alice"])
        self.assertEqual(rows[0].equity, money.cash("11000"))    # 8000 cash + 20 x 150
        self.assertEqual(rows[0].day_change, money.cash("200"))  # 20 x (150 - 140)
        self.assertEqual(rows[0].return_pct, money.dec("10.00"))

    def test_unpriced_position_falls_back_to_cost(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        value = engine.value_portfolio(engine.replay(league, league.player("alice")), {})
        self.assertFalse(value.fully_priced)
        self.assertEqual(value.equity, money.cash("10000"))
        self.assertEqual(value.unrealized, money.ZERO)

    def test_short_position_gains_when_price_falls(self):
        league = new_league(allow_short=True)
        sell(league, "alice", "AAPL", 10, "100")
        pf = engine.replay(league, league.player("alice"))
        value = engine.value_portfolio(pf, {"AAPL": {"price": "80"}})
        self.assertEqual(value.unrealized, money.cash("200"))
        self.assertEqual(value.equity, money.cash("10200"))

    def test_snapshot_records_every_player(self):
        league = new_league()
        buy(league, "alice", "AAPL", 10, "100")
        snap = engine.take_snapshot(league, {"AAPL": {"price": "110"}}, label="Week 1")
        self.assertEqual(snap.equity["alice"], money.cash("10100"))
        self.assertEqual(snap.equity["bob"], money.cash("10000"))


class DateTests(unittest.TestCase):
    def test_parse_when(self):
        self.assertTrue(engine.parse_when("2026-09-01").startswith("2026-09-01T00:00:00"))
        self.assertTrue(engine.parse_when("2026-09-01T15:30:00Z").startswith("2026-09-01T15:30:00"))
        self.assertTrue(engine.parse_when(None))
        with self.assertRaises(LeagueError):
            engine.parse_when("last tuesday")


if __name__ == "__main__":
    unittest.main()
