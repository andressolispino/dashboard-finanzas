from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence

from finance_etl.pipeline import (
    DEFAULT_ACCOUNTS_LOCAL,
    DEFAULT_CATEGORIES,
    DEFAULT_INCOME_SCHEDULES,
    DEFAULT_PRIVATE_RULES,
    DEFAULT_RULES,
    run_import,
    setup_spreadsheet,
)


def _default_if_exists(path: Path) -> str | None:
    return str(path) if path.is_file() else None


def _add_config_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--accounts-config",
        default=_default_if_exists(DEFAULT_ACCOUNTS_LOCAL),
        help="JSON local de cuentas; por defecto config/accounts.local.json",
    )
    parser.add_argument(
        "--categories-config",
        default=str(DEFAULT_CATEGORIES),
        help="JSON de taxonomía",
    )
    parser.add_argument(
        "--rules-config",
        default=str(DEFAULT_RULES),
        help="JSON de reglas base",
    )
    parser.add_argument(
        "--private-rules-config",
        default=_default_if_exists(DEFAULT_PRIVATE_RULES),
        help="JSON local de reglas privadas",
    )
    parser.add_argument(
        "--income-schedules-config",
        default=_default_if_exists(DEFAULT_INCOME_SCHEDULES),
        help="JSON local de programación de ingresos",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="finanzas-etl",
        description=(
            "ETL conservador para extractos bancarios y Google Sheets"
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup = subparsers.add_parser(
        "setup-sheet",
        help="crear pestañas, encabezados y validaciones",
    )
    setup.add_argument(
        "--spreadsheet-id",
        default=os.getenv("FINANCE_SPREADSHEET_ID"),
    )
    setup.add_argument(
        "--credentials",
        help="ruta al JSON de cuenta de servicio",
    )
    _add_config_arguments(setup)

    importer = subparsers.add_parser(
        "import",
        help="extraer PDF y cargar movimientos",
    )
    importer.add_argument(
        "--input",
        action="append",
        required=True,
        help="PDF o carpeta; puede repetirse",
    )
    importer.add_argument(
        "--dry-run",
        action="store_true",
        help="no conectarse ni escribir en Google Sheets",
    )
    importer.add_argument(
        "--spreadsheet-id",
        default=os.getenv("FINANCE_SPREADSHEET_ID"),
    )
    importer.add_argument(
        "--credentials",
        help="ruta al JSON de cuenta de servicio",
    )
    importer.add_argument(
        "--output-csv",
        help="copia local opcional para inspección",
    )
    _add_config_arguments(importer)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "setup-sheet":
        if not args.spreadsheet_id:
            parser.error(
                "--spreadsheet-id o FINANCE_SPREADSHEET_ID es obligatorio"
            )
        setup_spreadsheet(
            args.spreadsheet_id,
            credentials_path=args.credentials,
            accounts_config=args.accounts_config,
            categories_config=args.categories_config,
            rules_config=args.rules_config,
            private_rules_config=args.private_rules_config,
            income_schedules_config=args.income_schedules_config,
        )
        print(
            json.dumps(
                {
                    "status": "success",
                    "spreadsheet_id": args.spreadsheet_id,
                    "message": "schema and validations are ready",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    summary = run_import(
        args.input,
        dry_run=args.dry_run,
        spreadsheet_id=args.spreadsheet_id,
        credentials_path=args.credentials,
        accounts_config=args.accounts_config,
        categories_config=args.categories_config,
        rules_config=args.rules_config,
        private_rules_config=args.private_rules_config,
        income_schedules_config=args.income_schedules_config,
        output_csv=args.output_csv,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["status"] == "failed":
        raise SystemExit(2)
