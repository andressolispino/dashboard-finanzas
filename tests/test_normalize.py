from datetime import date
from decimal import Decimal
from unittest import TestCase

from finance_etl.normalize import (
    normalize_text,
    parse_money,
    stable_transaction_id,
)


class MoneyParsingTests(TestCase):
    def test_colombian_decimal_style(self) -> None:
        self.assertEqual(
            parse_money("-1.234.567,89", "comma"),
            Decimal("-1234567.89"),
        )

    def test_dot_decimal_style(self) -> None:
        self.assertEqual(
            parse_money("$-1,234,567.89", "dot"),
            Decimal("-1234567.89"),
        )
        self.assertEqual(parse_money(".08", "dot"), Decimal("0.08"))

    def test_normalization_removes_accents_and_extra_spaces(self) -> None:
        self.assertEqual(
            normalize_text("  Revisión   manual  "),
            "REVISION MANUAL",
        )

    def test_transaction_id_is_stable(self) -> None:
        kwargs = {
            "account_identity": "account-a",
            "transaction_date": date(2026, 1, 2),
            "amount": Decimal("-100.00"),
            "balance_after": Decimal("900.00"),
            "description": "Compra local",
            "external_reference": "ABC",
            "fallback_locator": "ignored",
        }
        self.assertEqual(
            stable_transaction_id(**kwargs),
            stable_transaction_id(**kwargs),
        )
        changed = dict(kwargs, balance_after=Decimal("800.00"))
        self.assertNotEqual(
            stable_transaction_id(**kwargs),
            stable_transaction_id(**changed),
        )
