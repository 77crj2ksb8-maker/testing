"""End-to-end runs of the CLI against a temp league file — no network touched."""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

from fsx import money, store
from fsx.cli import main


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "league.json"

    def run_cli(self, *argv, expect=0):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(["--file", str(self.path), "--no-color", *argv])
        self.assertEqual(code, expect, f"argv={argv}\nstdout={out.getvalue()}\nstderr={err.getvalue()}")
        return out.getvalue()

    def run_json(self, *argv, expect=0):
        return json.loads(self.run_cli("--json", *argv, expect=expect))

    def league(self):
        return store.load(self.path)

    def start(self, *extra):
        self.run_cli("init", "Test League", "--cash", "10000", *extra)
        self.run_cli("add-player", "Alice")
        self.run_cli("add-player", "Bob")


class WorkflowTests(CliTestCase):
    def test_full_season(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "20", "--price", "100")
        self.run_cli("buy", "bob", "MSFT", "10", "--price", "200")
        self.run_cli("sell", "alice", "AAPL", "5", "--price", "150")

        alice = self.run_json("portfolio", "alice", "--offline")
        self.assertEqual(alice["cash"], "8750.00")           # 10000 - 2000 + 750
        self.assertEqual(alice["realized"], "250.00")
        self.assertEqual(alice["positions"][0]["shares"], "15.00000000")

        board = self.run_json("standings", "--offline")
        self.assertEqual([r["id"] for r in board["standings"]], ["alice", "bob"])

    def test_buy_with_a_cash_amount_rounds_down_to_whole_shares(self):
        self.start()
        out = self.run_json("buy", "alice", "AAPL", "--amount", "1000", "--price", "300")
        self.assertEqual(out["entry"]["shares"], "3.00000000")
        self.assertEqual(out["cash"], "9100.00")

    def test_buy_with_a_cash_amount_fractional(self):
        self.start("--fractional")
        out = self.run_json("buy", "alice", "AAPL", "--amount", "1000", "--price", "300")
        self.assertEqual(money.shares(out["entry"]["shares"]), money.shares("3.33333333"))

    def test_sell_all_closes_the_position(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "7", "--price", "100")
        out = self.run_json("sell", "alice", "AAPL", "--all", "--price", "110")
        self.assertEqual(out["entry"]["shares"], "7.00000000")
        self.assertEqual(out["position"]["shares"], "0E-8")
        self.assertEqual(out["realized"], "70.00")

    def test_undo_reverses_the_last_trade(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "5", "--price", "100")
        self.run_cli("buy", "alice", "AAPL", "5", "--price", "200")
        self.run_cli("undo", "--yes")
        pf = self.run_json("portfolio", "alice", "--offline")
        self.assertEqual(pf["cash"], "9500.00")
        self.assertEqual(pf["positions"][0]["shares"], "5.00000000")

    def test_deposit_and_withdraw(self):
        self.start()
        self.run_cli("deposit", "alice", "500")
        self.run_cli("withdraw", "alice", "200")
        pf = self.run_json("portfolio", "alice", "--offline")
        self.assertEqual(pf["cash"], "10300.00")
        self.assertEqual(pf["total_pnl"], "0.00")            # transfers are not performance

    def test_history_filters(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "1", "--price", "100")
        self.run_cli("buy", "bob", "MSFT", "1", "--price", "100")
        entries = self.run_json("history", "--player", "bob")["entries"]
        self.assertEqual([e["symbol"] for e in entries], ["MSFT"])
        entries = self.run_json("history", "--symbol", "aapl")["entries"]
        self.assertEqual([e["player"] for e in entries], ["alice"])

    def test_snapshot_and_progress(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "10", "--price", "100")
        self.run_cli("snapshot", "--label", "Week 1", "--offline")
        progress = self.run_cli("progress")
        self.assertIn("Week 1", progress)
        snaps = self.league().snapshots
        self.assertEqual(len(snaps), 1)
        self.assertEqual(snaps[0].equity["bob"], money.cash("10000"))

    def test_export_html_and_csv(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "10", "--price", "100")
        html = self.run_cli("export", "--format", "html", "--offline")
        self.assertIn("<title>Test League", html)
        self.assertIn("Alice", html)
        csv_out = self.run_cli("export", "--format", "csv", "--offline")
        self.assertIn("rank,player,equity", csv_out)
        positions = self.run_cli("export", "--format", "csv", "--positions", "--offline")
        self.assertIn("AAPL", positions)
        out_file = Path(self.tmp.name) / "board.html"
        self.run_cli("export", "--format", "html", "--out", str(out_file), "--offline")
        self.assertTrue(out_file.exists())

    def test_rules_show_and_update(self):
        self.start()
        shown = self.run_cli("rules")
        self.assertIn("short selling    off", shown)
        self.run_cli("rules", "--shorting", "on", "--max-position", "25")
        rules = self.league().rules
        self.assertTrue(rules.allow_short)
        self.assertEqual(rules.max_position_pct, money.dec("25"))
        self.run_cli("rules", "--max-position", "off")
        self.assertIsNone(self.league().rules.max_position_pct)

    def test_backdated_trade_keeps_its_date(self):
        self.start()
        out = self.run_json("buy", "alice", "AAPL", "1", "--price", "100", "--date", "2026-01-15")
        self.assertTrue(out["entry"]["at"].startswith("2026-01-15"))


class FailureTests(CliTestCase):
    def test_missing_league_file_is_a_clean_error(self):
        out = io.StringIO()
        with redirect_stderr(out):
            code = main(["--file", str(self.path), "players"])
        self.assertEqual(code, 1)
        self.assertIn("fsx init", out.getvalue())

    def test_init_refuses_to_clobber(self):
        self.run_cli("init", "One")
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = main(["--file", str(self.path), "init", "Two"])
        self.assertEqual(code, 1)
        self.assertIn("already exists", err.getvalue())
        self.assertEqual(self.league().name, "One")

    def test_overspending_is_refused_and_nothing_is_written(self):
        self.start()
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = main(["--file", str(self.path), "buy", "alice", "AAPL", "500", "--price", "100"])
        self.assertEqual(code, 1)
        self.assertIn("short", err.getvalue())
        self.assertEqual(self.league().entries, [])

    def test_unknown_player(self):
        self.start()
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = main(["--file", str(self.path), "buy", "zoe", "AAPL", "1", "--price", "100"])
        self.assertEqual(code, 1)
        self.assertIn("no such player", err.getvalue())

    def test_trade_without_a_quantity(self):
        self.start()
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = main(["--file", str(self.path), "buy", "alice", "AAPL", "--price", "100"])
        self.assertEqual(code, 1)
        self.assertIn("--amount", err.getvalue())

    def test_bad_number_is_reported(self):
        self.start()
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = main(["--file", str(self.path), "buy", "alice", "AAPL", "lots", "--price", "100"])
        self.assertEqual(code, 2)
        self.assertIn("not a number", err.getvalue())


class StoreTests(CliTestCase):
    def test_round_trip_preserves_every_amount(self):
        self.start("--fractional")
        self.run_cli("buy", "alice", "AAPL", "1.23456789", "--price", "199.9999", "--note", "hi")
        league = self.league()
        entry = league.entries[0]
        self.assertEqual(entry.shares, money.shares("1.23456789"))
        self.assertEqual(entry.price, money.price("199.9999"))
        self.assertEqual(entry.note, "hi")
        reloaded = store.load(self.path)
        self.assertEqual(reloaded.to_dict(), league.to_dict())

    def test_a_backup_is_kept(self):
        self.start()
        self.run_cli("buy", "alice", "AAPL", "1", "--price", "100")
        self.assertTrue(self.path.with_suffix(".json.bak").exists())

    def test_newer_schema_is_refused(self):
        self.start()
        data = json.loads(self.path.read_text())
        data["schema"] = 99
        self.path.write_text(json.dumps(data))
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = main(["--file", str(self.path), "players"])
        self.assertEqual(code, 1)
        self.assertIn("newer fsx", err.getvalue())


if __name__ == "__main__":
    unittest.main()
