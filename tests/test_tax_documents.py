from decimal import Decimal
from unittest import TestCase

from finance_etl.pdfs import UnsupportedPDFError
from finance_etl.tax_documents import parse_tax_text


class TaxDocumentTests(TestCase):
    def test_form_210_fields_are_kept_outside_transactions(self) -> None:
        document, fields = parse_tax_text(
            [
                "\n".join(
                    [
                        "DIAN Declaración de renta y complementario",
                        "Formulario 210 Año gravable 2025",
                        "Número de formulario 1234567890123",
                        "29 Patrimonio bruto 150.000.000",
                        "30 Total deudas 40.000.000",
                        "107 Saldo a favor 1.250.000",
                    ]
                )
            ],
            source_file_hash="a" * 64,
            source_file_name="renta.pdf",
        )
        self.assertEqual(document.form_number, "210")
        self.assertEqual(document.tax_year, 2025)
        self.assertEqual(len(fields), 3)
        self.assertEqual(fields[0].amount_cop, Decimal("150000000"))
        self.assertEqual(fields[0].concept, "Patrimonio bruto")

    def test_unknown_tax_label_requires_review(self) -> None:
        _, fields = parse_tax_text(
            [
                "\n".join(
                    [
                        "Formulario 210 Declaración de renta",
                        "99 Concepto nuevo 8.500.000",
                    ]
                )
            ],
            source_file_hash="b" * 64,
            source_file_name="renta.pdf",
        )
        self.assertEqual(fields[0].concept, "Revisión Manual")
        self.assertEqual(fields[0].review_status, "Pendiente")

    def test_non_tax_document_is_rejected(self) -> None:
        with self.assertRaises(UnsupportedPDFError):
            parse_tax_text(
                ["Documento cualquiera"],
                source_file_hash="c" * 64,
                source_file_name="otro.pdf",
            )
