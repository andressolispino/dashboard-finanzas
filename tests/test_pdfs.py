from finance_etl.normalize import normalize_text
from finance_etl.pdfs import _looks_like_bancolombia_statement


def test_bancolombia_statement_without_text_logo_is_recognized() -> None:
    text = normalize_text(
        """
        ESTADO DE CUENTA
        DESDE: 2025/09/30 HASTA: 2025/12/31
        CUENTA DE AHORROS
        NÚMERO 26171774801
        TOTAL ABONOS $ 3,845,012.20
        TOTAL CARGOS $ 3,952,588.00
        """
    )

    assert _looks_like_bancolombia_statement(text)


def test_transaction_detail_is_not_mistaken_for_statement() -> None:
    text = normalize_text(
        """
        Sucursal Virtual Personas
        Detalle de transacciones
        Cuenta de Ahorros 261-717748-01
        Fecha Tipo de transacción Descripción Valor
        """
    )

    assert not _looks_like_bancolombia_statement(text)
