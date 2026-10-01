#!/usr/bin/env python3
"""W11 — add the 'ML Recovery' page to the published NorthPeak dashboard.

Idempotent: skips if the page already exists. Reads the draft dashboard via
the Lakeview API, appends one dataset (gold_recovery_recommendations_ml,
rtdemo.northpeak_v2) and one canvas page cloned from the Recovery page's
widget patterns, writes the draft back, then re-publishes.

Usage: python3 scripts/add_ml_dashboard_page.py
Evidence: prints the API responses as JSON to stdout — pipe to a file.
"""
import json
import subprocess
import sys

DASHBOARD_ID = "01f1a24fdd6d187b81c668722ee06628"
PROFILE = "fe-vm-jai-classic-ws"
WAREHOUSE_ID = "bf7ffcda00a8c351"


def api(method, path, payload=None):
    cmd = ["databricks", "api", method, path, "--profile", PROFILE]
    if payload is not None:
        cmd += ["--json", json.dumps(payload)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"API {method} {path} failed: {out.stderr[:500]}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


ML_DATASET = {
    "name": "ds_ml_recovery",
    "displayName": "ds_ml_recovery",
    "queryLines": [
        "SELECT\n",
        "  m.store_id,\n",
        "  p.store_name,\n",
        "  m.product_id,\n",
        "  p.product_name,\n",
        "  get_json_object(m.move_ranking, '$[0].move') AS recommended_move,\n",
        "  get_json_object(m.move_ranking, '$[0].source_store_id') AS recommended_source_store_id,\n",
        "  CAST(get_json_object(m.move_ranking, '$[0].units') AS INT) AS units,\n",
        "  CAST(get_json_object(m.move_ranking, '$[0].predicted_recaptured_usd') AS DOUBLE) AS predicted_recaptured_usd,\n",
        "  CAST(get_json_object(m.move_ranking, '$[0].predicted_net_value_usd') AS DOUBLE) AS predicted_net_value_usd,\n",
        "  m.model_version,\n",
        "  m.scored_at\n",
        "FROM\n",
        "  gold_recovery_recommendations_ml m\n",
        "    LEFT JOIN gold_store_sku_position p\n",
        "      ON m.store_id = p.store_id\n",
        "      AND m.product_id = p.product_id\n",
        "ORDER BY predicted_net_value_usd DESC\n",
    ],
    "catalog": "rtdemo",
    "schema": "northpeak_v2",
}


def field(name, expr=None):
    return {"name": name, "expression": expr or f"`{name}`"}


def query_block(fields, disaggregated):
    return {
        "name": "main_query",
        "query": {
            "datasetName": "ds_ml_recovery",
            "fields": fields,
            "disaggregated": disaggregated,
        },
    }


def textbox(name, lines, pos):
    return {
        "widget": {"name": name, "multilineTextboxSpec": {"lines": lines}},
        "position": pos,
    }


def counter(name, title, value_field, value_expr, pos):
    return {
        "widget": {
            "name": name,
            "queries": [query_block([field(value_field, value_expr)], False)],
            "spec": {
                "frame": {"showTitle": True, "title": title},
                "version": 2,
                "widgetType": "counter",
                "encodings": {
                    "value": {"fieldName": value_field, "rowNumber": 0}
                },
                "data": {"queryName": "main_query"},
            },
        },
        "position": pos,
    }


def bar_move_mix(pos):
    return {
        "widget": {
            "name": "ml_bar_move_mix",
            "queries": [
                query_block(
                    [
                        field("recommended_move"),
                        field("count(store_id)", "COUNT(`store_id`)"),
                    ],
                    False,
                )
            ],
            "spec": {
                "frame": {"showTitle": True, "title": "ML-recommended move (mix over 150 shortfalls)"},
                "version": 3,
                "widgetType": "bar",
                "encodings": {
                    "x": {
                        "fieldName": "recommended_move",
                        "displayName": "recommended_move",
                        "scale": {"type": "categorical"},
                    },
                    "y": {
                        "fieldName": "count(store_id)",
                        "displayName": "store_id",
                        "scale": {"type": "quantitative"},
                    },
                    "color": {
                        "fieldName": "recommended_move",
                        "displayName": "recommended_move",
                        "scale": {"type": "categorical"},
                    },
                },
                "data": {"queryName": "main_query"},
            },
        },
        "position": pos,
    }


def table_top(pos):
    cols = [
        "store_name",
        "product_name",
        "recommended_move",
        "units",
        "predicted_recaptured_usd",
        "predicted_net_value_usd",
    ]
    return {
        "widget": {
            "name": "ml_table_top",
            "queries": [query_block([field(c) for c in cols], True)],
            "spec": {
                "frame": {"showTitle": True, "title": "Top ML-scored recovery moves (by net value)"},
                "version": 2,
                "widgetType": "table",
                "encodings": {"columns": [{"fieldName": c} for c in cols]},
                "data": {"queryName": "main_query"},
            },
        },
        "position": pos,
    }


ML_PAGE = {
    "name": "ml_recovery",
    "displayName": "ML Recovery",
    "pageType": "PAGE_TYPE_CANVAS",
    "layoutVersion": "GRID_V1",
    "layout": [
        textbox(
            "ml_header",
            [
                "## ML Recovery — scored by the registered model\n",
                "Rankings on this page come from **XGBoost `recovery_recommender` v6 @prod** "
                "(Unity Catalog) — trained with Optuna on 40K historical transfer outcomes, "
                "RMSE **$302.71** on held-out data, batch-scored across all 150 open shortfalls "
                "into `gold_recovery_recommendations_ml`. Served live behind endpoint "
                "`northpeak-recovery` (invocation matches batch to the cent).\n",
            ],
            {"x": 0, "y": 0, "width": 12, "height": 2},
        ),
        bar_move_mix({"x": 0, "y": 2, "width": 6, "height": 4}),
        counter(
            "ml_counter_recaptured",
            "Total predicted recaptured revenue (ML)",
            "sum(predicted_recaptured_usd)",
            "SUM(`predicted_recaptured_usd`)",
            {"x": 6, "y": 2, "width": 6, "height": 4},
        ),
        counter(
            "ml_counter_positions",
            "Open shortfalls scored",
            "count(store_id)",
            "COUNT(`store_id`)",
            {"x": 0, "y": 6, "width": 6, "height": 3},
        ),
        counter(
            "ml_counter_version",
            "Model version @prod",
            "max(model_version)",
            "MAX(`model_version`)",
            {"x": 6, "y": 6, "width": 6, "height": 3},
        ),
        table_top({"x": 0, "y": 9, "width": 12, "height": 6}),
    ],
}


def main():
    dash = api("get", f"/api/2.0/lakeview/dashboards/{DASHBOARD_ID}")
    s = json.loads(dash["serialized_dashboard"])

    if any(p.get("name") == "ml_recovery" for p in s["pages"]):
        print(json.dumps({"status": "page already exists — no change"}))
        return

    s["datasets"] = [d for d in s["datasets"] if d["name"] != "ds_ml_recovery"]
    s["datasets"].append(ML_DATASET)
    s["pages"].append(ML_PAGE)

    api(
        "patch",
        f"/api/2.0/lakeview/dashboards/{DASHBOARD_ID}",
        {"serialized_dashboard": json.dumps(s)},
    )

    published = api(
        "post",
        f"/api/2.0/lakeview/dashboards/{DASHBOARD_ID}/published",
        {"warehouse_id": WAREHOUSE_ID, "embed_credentials": True},
    )

    # Re-read and report what landed.
    after = api("get", f"/api/2.0/lakeview/dashboards/{DASHBOARD_ID}")
    s2 = json.loads(after["serialized_dashboard"])
    print(
        json.dumps(
            {
                "status": "published",
                "dashboard_id": DASHBOARD_ID,
                "pages": [p.get("displayName") for p in s2["pages"]],
                "datasets": [d["name"] for d in s2["datasets"]],
                "published_revision_id": published.get("revision_id"),
            },
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
