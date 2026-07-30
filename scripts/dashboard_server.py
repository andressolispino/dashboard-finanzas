from __future__ import annotations

import csv
import json
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PROJECT_ROOT / "web" / "dist"
PAYLOAD_ROOT = PROJECT_ROOT / "tmp" / "sheet_payloads"

SOURCES = {
    "transactions": "Transactions.csv",
    "categories": "Categories.csv",
    "budgets": "Budgets.csv",
    "subscriptions": "Subscriptions.csv",
    "assets": "Assets.csv",
    "goals": "Goals.csv",
    "incomeSchedules": "Income_Schedules.csv",
    "reviewQueue": "Review_Queue.csv",
    "accounts": "Accounts.csv",
    "etlRuns": "ETL_Runs.csv",
    "taxDocuments": "Tax_Documents.csv",
}

TRANSACTION_OVERRIDES = (
    PROJECT_ROOT / "config" / "transaction_overrides.local.json"
)
REVIEW_DECISIONS = PROJECT_ROOT / "config" / "review_decisions.local.json"
PRIMARY_INCOME_ACCOUNT_ID = "principal_cop"


def read_rows(filename: str) -> list[dict[str, str]]:
    path = PAYLOAD_ROOT / filename
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def dashboard_payload() -> dict[str, list[dict[str, str]]]:
    return {key: read_rows(filename) for key, filename in SOURCES.items()}


def write_rows(filename: str, rows: list[dict[str, str]]) -> None:
    path = PAYLOAD_ROOT / filename
    if not rows:
        return
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    with temporary.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(
            target,
            fieldnames=list(rows[0]),
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def read_json(path: Path, key: str) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get(key, payload)
    return rows if isinstance(rows, list) else []


def write_json(path: Path, key: str, rows: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps({key: rows}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def category_details(
    category: str,
    subcategory: str,
) -> tuple[str, bool]:
    definitions = read_rows("Categories.csv")
    match = next(
        (
            row
            for row in definitions
            if row.get("category") == category
            and row.get("subcategory") == subcategory
        ),
        None,
    )
    if match is None:
        raise ValueError("La categoría o subcategoría no existe.")
    transaction_type = match.get("transaction_type") or "Gasto"
    return (
        transaction_type,
        category == "Transferencias entre cuentas",
    )


def update_transaction_row(
    row: dict[str, str],
    category: str,
    subcategory: str,
) -> None:
    transaction_type, internal = category_details(category, subcategory)
    if (
        transaction_type == "Ingreso"
        and row.get("account_id") != PRIMARY_INCOME_ACCOUNT_ID
    ):
        transaction_type = "Transferencia"
        category = "Transferencias entre cuentas"
        subcategory = "Cuenta propia"
        internal = True
        row["income_source"] = ""
    row["transaction_type"] = transaction_type
    row["category"] = category
    row["subcategory"] = subcategory
    row["is_internal_transfer"] = "true" if internal else "false"
    row["review_status"] = "Revisada"
    row["review_reason"] = "dashboard:user_category"


def save_transaction_category(payload: dict[str, Any]) -> dict[str, Any]:
    transaction_id = str(payload.get("transaction_id", "")).strip()
    category = str(payload.get("category", "")).strip()
    subcategory = str(payload.get("subcategory", "")).strip()
    if not transaction_id:
        raise ValueError("Falta el identificador del movimiento.")

    rows = read_rows("Transactions.csv")
    match = next(
        (row for row in rows if row.get("transaction_id") == transaction_id),
        None,
    )
    if match is None:
        raise ValueError("No se encontró el movimiento.")
    update_transaction_row(match, category, subcategory)
    write_rows("Transactions.csv", rows)

    overrides = read_json(TRANSACTION_OVERRIDES, "overrides")
    override = next(
        (
            item
            for item in overrides
            if str(item.get("transaction_id")) == transaction_id
        ),
        None,
    )
    values = {
        "transaction_id": transaction_id,
        "category": match["category"],
        "subcategory": match["subcategory"],
    }
    if override is None:
        overrides.append(values)
    else:
        override.update(values)
    write_json(TRANSACTION_OVERRIDES, "overrides", overrides)
    return {"transaction": match, "sheet_synced": False}


def group_matches(row: dict[str, str], group: dict[str, str]) -> bool:
    match_type = group.get("match_type", "")
    match_value = group.get("match_value", "")
    expression = group.get("match_expression", "")
    if match_type == "Regla general":
        return row.get("review_reason") == f"suggestion:rule:{match_value}"
    if match_type == "Regla amplia":
        return row.get("review_reason") == f"suggestion:{match_value}"
    if match_type == "Movimiento de alto impacto":
        return (
            row.get("direction") == group.get("direction")
            and row.get("normalized_description") == expression
        )
    return (
        row.get("review_reason") == match_value
        and row.get("normalized_description") == expression
    )


def save_review_decision(payload: dict[str, Any]) -> dict[str, Any]:
    group_id = str(payload.get("group_id", "")).strip()
    category = str(payload.get("category", "")).strip()
    subcategory = str(payload.get("subcategory", "")).strip()
    category_details(category, subcategory)

    review_rows = read_rows("Review_Queue.csv")
    group = next(
        (row for row in review_rows if row.get("group_id") == group_id),
        None,
    )
    if group is None:
        raise ValueError("No se encontró la pregunta de automatización.")
    group["decision"] = "Cambiar categoría"
    group["final_category"] = category
    group["final_subcategory"] = subcategory
    write_rows("Review_Queue.csv", review_rows)

    decisions = read_json(REVIEW_DECISIONS, "decisions")
    decision = next(
        (
            item
            for item in decisions
            if str(item.get("group_id")) == group_id
        ),
        None,
    )
    values = {
        "group_id": group_id,
        "decision": "Cambiar categoría",
        "final_category": category,
        "final_subcategory": subcategory,
    }
    if decision is None:
        decisions.append(values)
    else:
        decision.update(values)
    write_json(REVIEW_DECISIONS, "decisions", decisions)

    transactions = read_rows("Transactions.csv")
    updated_ids: list[str] = []
    for row in transactions:
        if group_matches(row, group):
            update_transaction_row(row, category, subcategory)
            updated_ids.append(row.get("transaction_id", ""))
    write_rows("Transactions.csv", transactions)
    return {
        "updated_transaction_ids": updated_ids,
        "sheet_synced": False,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/api/dashboard":
            payload = json.dumps(
                dashboard_payload(),
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?", 1)[0]
        if route not in {
            "/api/transaction-category",
            "/api/review-decision",
        }:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 65_536:
                raise ValueError("La solicitud no es válida.")
            payload = json.loads(
                self.rfile.read(content_length).decode("utf-8")
            )
            if route == "/api/transaction-category":
                result = save_transaction_category(payload)
            else:
                result = save_review_decision(payload)
            response = json.dumps(
                {"ok": True, **result},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
        except (ValueError, json.JSONDecodeError) as error:
            response = json.dumps(
                {"ok": False, "error": str(error)},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(HTTPStatus.BAD_REQUEST)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(response)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS",
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Accept",
        )
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    if not (WEB_ROOT / "index.html").exists():
        raise SystemExit(
            "No existe web/dist/index.html. Ejecuta npm run build dentro de web."
        )
    server = ThreadingHTTPServer(("127.0.0.1", port), DashboardHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
