"""Decimal handling and the formatting the reports rely on."""

import unittest
from decimal import Decimal

from fsx import money


class ParseTests(unittest.TestCase):
    def test_strings_with_decoration(self):
        self.assertEqual(money.dec("$1,234.50"), Decimal("1234.50"))
        self.assertEqual(money.dec("2.5%"), Decimal("2.5"))
        self.assertEqual(money.dec(" 42 "), Decimal("42"))

    def test_floats_do_not_pick_up_binary_noise(self):
        self.assertEqual(money.dec(0.1), Decimal("0.1"))
        self.assertEqual(money.cash(19.99), Decimal("19.99"))

    def test_bad_input(self):
        for value in ("lots", "", None, "12abc"):
            with self.assertRaises(money.AmountError):
                money.dec(value)

    def test_cash_rounds_half_up(self):
        self.assertEqual(money.cash("2.345"), Decimal("2.35"))
        self.assertEqual(money.cash("-2.345"), Decimal("-2.35"))

    def test_pct_of_zero_is_zero(self):
        self.assertEqual(money.pct(5, 0), Decimal("0"))


class FormatTests(unittest.TestCase):
    def test_money(self):
        self.assertEqual(money.fmt_money("1234.5"), "$1,234.50")
        self.assertEqual(money.fmt_money("-1234.5"), "-$1,234.50")
        self.assertEqual(money.fmt_money("10", "€"), "€10.00")

    def test_signed_zero_has_no_sign(self):
        self.assertEqual(money.fmt_signed("0"), "$0.00")
        self.assertEqual(money.fmt_signed("1.5"), "+$1.50")
        self.assertEqual(money.fmt_signed("-1.5"), "-$1.50")

    def test_a_loss_too_small_to_show_is_not_printed_as_a_gain(self):
        self.assertEqual(money.fmt_pct(money.pct("-0.07", "100000")), "0.00%")
        self.assertEqual(money.fmt_pct("-0.6"), "-0.60%")
        self.assertEqual(money.fmt_pct("12.345"), "+12.35%")

    def test_shares_drop_trailing_zeros(self):
        self.assertEqual(money.fmt_shares("100.00000000"), "100")
        self.assertEqual(money.fmt_shares("1.5"), "1.5")
        self.assertEqual(money.fmt_shares("0.00000001"), "0.00000001")


if __name__ == "__main__":
    unittest.main()
