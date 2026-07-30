from __future__ import annotations

import csv
import json
from pathlib import Path

import scripts.dashboard_server as dashboard_server


def write_csv(
    path: Path,
    headers: list[str],
    rows: list[list[str]],
) -> None:
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(headers)
        writer.writerows(rows)


def configure_storage(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.setattr(dashboard_server, "PAYLOAD_ROOT", tmp_path)
    monkeypatch.setattr(
        dashboard_server,
        "TRANSACTION_OVERRIDES",
        tmp_path / "transaction_overrides.local.json",
    )
    monkeypatch.setattr(
        dashboard_server,
        "REVIEW_DECISIONS",
        tmp_path / "review_decisions.local.json",
    )
    write_csv(
        tmp_path / "Categories.csv",
        ["category", "subcategory", "transaction_type"],
        [
            ["Transferencias entre cuentas", "Cuenta propia", "Transferencia"],
            ["Ocio", "Viajes", "Gasto"],
        ],
    )


def test_dashboard_saves_individual_category(
    tmp_path: Path,
    monkeypatch: object,
) -> None:
    configure_storage(tmp_path, monkeypatch)
    write_csv(
        tmp_path / "Transactions.csv",
        [
            "transaction_id",
            "transaction_type",
            "category",
            "subcategory",
            "is_internal_transfer",
            "review_status",
            "review_reason",
        ],
        [["tx-1", "Gasto", "Ocio", "Viajes", "false", "Sugerida", "rule"]],
    )

    dashboard_server.save_transaction_category(
        {
            "transaction_id": "tx-1",
            "category": "Transferencias entre cuentas",
            "subcategory": "Cuenta propia",
        }
    )

    transaction = dashboard_server.read_rows("Transactions.csv")[0]
    assert transaction["transaction_type"] == "Transferencia"
    assert transaction["is_internal_transfer"] == "true"
    assert transaction["review_status"] == "Revisada"
    saved = json.loads(
        (tmp_path / "transaction_overrides.local.json").read_text(
            encoding="utf-8"
        )
    )
    assert saved["overrides"][0]["transaction_id"] == "tx-1"


def test_dashboard_saves_group_decision(
    tmp_path: Path,
    monkeypatch: object,
) -> None:
    configure_storage(tmp_path, monkeypatch)
    write_csv(
        tmp_path / "Transactions.csv",
        [
            "transaction_id",
            "direction",
            "normalized_description",
            "transaction_type",
            "category",
            "subcategory",
            "is_internal_transfer",
            "review_status",
            "review_reason",
        ],
        [
            [
                "tx-2",
                "Salida",
                "PAGO GRANDE",
                "Gasto",
                "Compras y pagos",
                "Concepto por identificar",
                "false",
                "Sugerida",
                "suggestion:fallback_salida",
            ]
        ],
    )
    write_csv(
        tmp_path / "Review_Queue.csv",
        [
            "group_id",
            "match_type",
            "match_value",
            "match_expression",
            "direction",
            "decision",
            "final_category",
            "final_subcategory",
        ],
        [
            [
                "group-1",
                "Movimiento de alto impacto",
                "high_impact_outflow",
                "PAGO GRANDE",
                "Salida",
                "Sin revisar",
                "",
                "",
            ]
        ],
    )

    result = dashboard_server.save_review_decision(
        {
            "group_id": "group-1",
            "category": "Ocio",
            "subcategory": "Viajes",
        }
    )

    assert result["updated_transaction_ids"] == ["tx-2"]
    transaction = dashboard_server.read_rows("Transactions.csv")[0]
    assert transaction["category"] == "Ocio"
    assert transaction["subcategory"] == "Viajes"
    review = dashboard_server.read_rows("Review_Queue.csv")[0]
    assert review["decision"] == "Cambiar categoría"
