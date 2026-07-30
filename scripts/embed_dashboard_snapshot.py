from __future__ import annotations

import json
from pathlib import Path

from dashboard_server import dashboard_payload


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    source = project / "web" / "dist" / "index.html"
    target = project / "index.html"
    html = source.read_text(encoding="utf-8")
    payload = json.dumps(
        dashboard_payload(),
        ensure_ascii=False,
        separators=(",", ":"),
    ).replace("</", "<\\/")
    marker = "</head>"
    snapshot = (
        "<script>window.__FINANCE_DASHBOARD_DATA__="
        f"{payload};</script>{marker}"
    )
    if marker not in html:
        raise RuntimeError("No se encontró </head> en el dashboard generado.")
    target.write_text(
        html.replace(marker, snapshot, 1),
        encoding="utf-8",
    )
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
