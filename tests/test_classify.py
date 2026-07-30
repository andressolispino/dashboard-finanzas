from datetime import date
from decimal import Decimal
from unittest import TestCase

from finance_etl.classify import (
    classify_record,
    map_account,
    pair_internal_transfers,
)
from finance_etl.models import ExtractedTransaction, TransactionRecord
from finance_etl.review_queue import build_high_impact_groups


def extracted(
    *,
    amount: str,
    description: str,
    account_id: str = "account-a",
    last4: str = "1234",
    day: int = 1,
    note: str = "",
) -> ExtractedTransaction:
    return ExtractedTransaction(
        transaction_date=date(2026, 1, day),
        source_institution="Banco de prueba",
        source_account_last4=last4,
        raw_description=description,
        amount_original=Decimal(amount),
        original_currency="COP",
        balance_after_original=Decimal("1000"),
        source_file_hash="a" * 64,
        source_file_name="sample.pdf",
        source_page=1,
        source_row=day,
        extraction_note=note,
        account_id=account_id,
    )


class ClassificationTests(TestCase):
    def test_unknown_transaction_gets_a_broad_suggestion(self) -> None:
        record = TransactionRecord(
            extracted=extracted(
                amount="-100",
                description="Descripción desconocida",
            ),
            etl_run_id="run",
        )
        classify_record(record, [])
        self.assertEqual(record.category, "Compras y pagos")
        self.assertEqual(record.subcategory, "Concepto por identificar")
        self.assertEqual(record.review_status, "Sugerida")
        self.assertIn("suggestion:fallback", record.review_reason)

    def test_medium_confidence_rule_is_suggested_not_pending(self) -> None:
        record = TransactionRecord(
            extracted=extracted(
                amount="-100",
                description="Transferencia a una persona",
            ),
            etl_run_id="run",
        )
        rules = [
            {
                "rule_id": "third_party",
                "enabled": True,
                "description_regex": "TRANSFERENCIA",
                "direction": "Salida",
                "set": {
                    "transaction_type": "Gasto",
                    "category": "Transferencias a terceros",
                    "subcategory": "Personas y billeteras",
                    "confidence": 0.82,
                },
            }
        ]
        classify_record(record, rules)
        self.assertEqual(record.review_status, "Sugerida")
        self.assertEqual(record.category, "Transferencias a terceros")

    def test_high_confidence_rule_is_autoapproved(self) -> None:
        record = TransactionRecord(
            extracted=extracted(
                amount="-250000",
                description="Transferencia a cuenta propia",
            ),
            etl_run_id="run",
        )
        rules = [
            {
                "rule_id": "own_transfer",
                "enabled": True,
                "description_regex": "CUENTA PROPIA",
                "direction": "Salida",
                "amount_equals": -250000,
                "set": {
                    "transaction_type": "Transferencia",
                    "category": "Transferencias entre cuentas",
                    "subcategory": "Cuenta propia",
                    "counterparty_account_id": "account-b",
                    "is_internal_transfer": True,
                    "confidence": 0.99,
                },
            }
        ]
        classify_record(record, rules)
        self.assertEqual(record.review_status, "Autoaprobada")
        self.assertTrue(record.is_internal_transfer)

    def test_only_principal_account_can_create_income(self) -> None:
        principal = TransactionRecord(
            extracted=extracted(
                amount="2500000",
                description="Pago de salario",
                account_id="principal_cop",
            ),
            etl_run_id="run",
        )
        classify_record(principal, [])
        self.assertEqual(principal.transaction_type, "Ingreso")
        self.assertFalse(principal.is_internal_transfer)

    def test_family_account_credit_is_household_funding(self) -> None:
        secondary = TransactionRecord(
            extracted=extracted(
                amount="250000",
                description="Abono en Bancolombia",
                account_id="bancolombia_cop",
            ),
            etl_run_id="run",
        )
        classify_record(secondary, [])
        self.assertEqual(secondary.transaction_type, "Transferencia")
        self.assertEqual(
            secondary.category,
            "Aportes al hogar",
        )
        self.assertEqual(secondary.subcategory, "Financiación recibida")
        self.assertFalse(secondary.is_internal_transfer)
        self.assertEqual(
            secondary.review_reason,
            "policy:family_account_credit",
        )

    def test_extraction_note_forces_manual_review(self) -> None:
        record = TransactionRecord(
            extracted=extracted(
                amount="-10",
                description="Comisión",
                note="fecha_inferida",
            ),
            etl_run_id="run",
        )
        rules = [
            {
                "rule_id": "fee",
                "enabled": True,
                "description_regex": "COMISION",
                "direction": "Salida",
                "set": {
                    "transaction_type": "Gasto",
                    "category": "Impuestos y comisiones",
                    "subcategory": "Comisiones bancarias",
                    "confidence": 0.99,
                },
            }
        ]
        classify_record(record, rules)
        self.assertEqual(record.review_status, "Pendiente")
        self.assertEqual(record.category, "Revisión Manual")

    def test_account_mapping_requires_institution_and_last4(self) -> None:
        transaction = extracted(
            amount="1",
            description="Ingreso",
            account_id="",
        )
        accounts = [
            {
                "account_id": "account-a",
                "active": True,
                "match": {
                    "institutions": ["Banco de prueba"],
                    "account_number_last4": "1234",
                },
            }
        ]
        self.assertEqual(
            map_account(transaction, accounts),
            ("account-a", "institution_and_last4"),
        )

    def test_internal_transfer_pairing(self) -> None:
        left = TransactionRecord(
            extracted=extracted(
                amount="-100",
                description="Salida propia",
                account_id="account-a",
                day=1,
            ),
            etl_run_id="run",
        )
        right = TransactionRecord(
            extracted=extracted(
                amount="100",
                description="Entrada propia",
                account_id="account-b",
                day=2,
            ),
            etl_run_id="run",
        )
        for record, counterparty in (
            (left, "account-b"),
            (right, "account-a"),
        ):
            record.initialize_identity()
            record.transaction_type = "Transferencia"
            record.is_internal_transfer = True
            record.counterparty_account_id = counterparty

        self.assertEqual(pair_internal_transfers([left, right]), 1)
        self.assertTrue(left.transfer_pair_id)
        self.assertEqual(left.transfer_pair_id, right.transfer_pair_id)

    def test_high_impact_queue_has_no_default_limit_and_groups_repeated_rows(
        self,
    ) -> None:
        records: list[TransactionRecord] = []
        descriptions = [
            "Pago grande repetido",
            "Pago grande repetido",
            "Pago grande 2",
            "Pago grande 3",
            "Pago grande 4",
            "Pago grande 5",
            "Pago grande 6",
            "Pago grande 7",
        ]
        for index, description in enumerate(descriptions, start=1):
            record = TransactionRecord(
                extracted=extracted(
                    amount=str(-(11_000_000 - index * 500_000)),
                    description=description,
                    day=index,
                ),
                etl_run_id="run",
            )
            classify_record(record, [])
            records.append(record)

        groups = build_high_impact_groups(records)

        self.assertEqual(len(groups), 7)
        repeated = next(
            group
            for group in groups
            if group["match_expression"] == "PAGO GRANDE REPETIDO"
        )
        self.assertEqual(repeated["occurrences"], 2)
        self.assertEqual(
            repeated["match_type"],
            "Movimiento de alto impacto",
        )

    def test_high_impact_queue_starts_at_two_hundred_thousand(self) -> None:
        records: list[TransactionRecord] = []
        for amount in ("-199999", "-200000", "-450000"):
            record = TransactionRecord(
                extracted=extracted(
                    amount=amount,
                    description=f"Pago ambiguo {amount}",
                ),
                etl_run_id="run",
            )
            classify_record(record, [])
            records.append(record)

        groups = build_high_impact_groups(records)

        self.assertEqual(len(groups), 2)
        self.assertEqual(
            {group["match_expression"] for group in groups},
            {"PAGO AMBIGUO -200000", "PAGO AMBIGUO -450000"},
        )

    def test_high_impact_queue_excludes_internal_transfer(self) -> None:
        record = TransactionRecord(
            extracted=extracted(
                amount="-9000000",
                description="Transferencia propia",
            ),
            etl_run_id="run",
        )
        record.initialize_identity()
        record.transaction_type = "Transferencia"
        record.category = "Transferencias entre cuentas"
        record.subcategory = "Cuenta propia"
        record.is_internal_transfer = True
        record.review_status = "Sugerida"

        self.assertEqual(build_high_impact_groups([record]), [])
