# Databricks notebook source
# MAGIC %md
# MAGIC # NorthPeak v2 — Reverse-ETL: Lakebase `ops_actions` → UC Delta
# MAGIC
# MAGIC Pulls the app's writable operations table (`app_v2.ops_actions` in the
# MAGIC `northpeak` Lakebase instance, `dev` branch) back into Unity Catalog as
# MAGIC `{catalog}.{schema}.ops_actions_outcomes` — closing the loop so approved
# MAGIC operations (plus proposed/overridden, for a full audit picture) are
# MAGIC available to analytics alongside the gold layer.
# MAGIC
# MAGIC Auth: Lakebase OAuth — a short-lived token from
# MAGIC `WorkspaceClient().postgres.generate_database_credential(...)` is used as
# MAGIC the psycopg2 password; the Postgres user is the current workspace identity.
# MAGIC
# MAGIC Idempotent: Delta MERGE on `id`. Safe to re-run on the daily schedule.
# MAGIC
# MAGIC Run as the `northpeak_reverse_sync` serverless job (widgets: `catalog`, `schema`).

# COMMAND ----------

import json
import os

IN_NOTEBOOK = "dbutils" in dir()
if IN_NOTEBOOK:
    dbutils.widgets.text("catalog", "", "Catalog")
    dbutils.widgets.text("schema", "", "Schema")
    CATALOG = dbutils.widgets.get("catalog")
    SCHEMA = dbutils.widgets.get("schema")
else:
    CATALOG = os.environ.get("DEMO_CATALOG", "rtdemo")
    SCHEMA = os.environ.get("DEMO_SCHEMA", "northpeak_v2")
assert CATALOG and SCHEMA, "catalog + schema required"

# Lakebase source — project `northpeak`, branch `dev`, primary endpoint.
LAKEBASE_ENDPOINT = "projects/northpeak/branches/dev/endpoints/primary"
LAKEBASE_HOST = "ep-rapid-hill-d2gj3pkb.database.us-east-1.cloud.databricks.com"
LAKEBASE_DB = "databricks_postgres"
SOURCE_TABLE = "app_v2.ops_actions"
TARGET_TABLE = f"{CATALOG}.{SCHEMA}.ops_actions_outcomes"

print(f"target={TARGET_TABLE}  source={LAKEBASE_DB}:{SOURCE_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1 · Read `ops_actions` from Lakebase (OAuth token + psycopg2)

# COMMAND ----------

import psycopg2
import psycopg2.extras
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()
me = w.current_user.me()
if hasattr(w, "postgres"):
    token = w.postgres.generate_database_credential(endpoint=LAKEBASE_ENDPOINT).token
else:
    # Older SDK on serverless — same call over raw REST.
    res = w.api_client.do("POST", "/api/2.0/postgres/credentials",
                          body={"endpoint": LAKEBASE_ENDPOINT},
                          headers={"Accept": "application/json",
                                   "Content-Type": "application/json"})
    token = res["token"]

conn = psycopg2.connect(
    host=LAKEBASE_HOST,
    dbname=LAKEBASE_DB,
    user=me.user_name,
    password=token,
    sslmode="require",
)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute(f"""
    SELECT id, store_id, product_id, move_type, source_store_id, units,
           drafted_request, predicted_recaptured_usd, status, approved_by,
           audit_trail::text AS audit_trail, created_at, decided_at
    FROM {SOURCE_TABLE}
""")
rows = cur.fetchall()
conn.close()

for r in rows:
    r["id"] = str(r["id"])
print(f"rows read from Lakebase: {len(rows)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2 · Convert to Spark DataFrame and MERGE into the Delta target

# COMMAND ----------

from pyspark.sql.types import (
    DoubleType, IntegerType, StringType, StructField, StructType, TimestampType,
)

SYNC_SCHEMA = StructType([
    StructField("id", StringType(), False),
    StructField("store_id", StringType(), True),
    StructField("product_id", StringType(), True),
    StructField("move_type", StringType(), True),
    StructField("source_store_id", StringType(), True),
    StructField("units", IntegerType(), True),
    StructField("drafted_request", StringType(), True),
    StructField("predicted_recaptured_usd", DoubleType(), True),
    StructField("status", StringType(), True),
    StructField("approved_by", StringType(), True),
    StructField("audit_trail", StringType(), True),
    StructField("created_at", TimestampType(), True),
    StructField("decided_at", TimestampType(), True),
])

src_sdf = spark.createDataFrame(rows, schema=SYNC_SCHEMA)
src_sdf.createOrReplaceTempView("ops_actions_src")

spark.sql(f"""
  CREATE TABLE IF NOT EXISTS {TARGET_TABLE} (
    id STRING, store_id STRING, product_id STRING, move_type STRING,
    source_store_id STRING, units INT, drafted_request STRING,
    predicted_recaptured_usd DOUBLE, status STRING, approved_by STRING,
    audit_trail STRING, created_at TIMESTAMP, decided_at TIMESTAMP,
    synced_at TIMESTAMP
  ) USING DELTA
""")

merge_df = spark.sql(f"""
  MERGE INTO {TARGET_TABLE} AS t
  USING (SELECT *, current_timestamp() AS synced_at FROM ops_actions_src) AS s
  ON t.id = s.id
  WHEN MATCHED THEN UPDATE SET *
  WHEN NOT MATCHED THEN INSERT *
""")
merge_stats = merge_df.first().asDict() if merge_df is not None else {}
print(f"merge stats: {merge_stats}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3 · Validation — row count + status breakdown

# COMMAND ----------

n_target = spark.table(TARGET_TABLE).count()
statuses = {
    r["status"]: r["count"]
    for r in spark.table(TARGET_TABLE).groupBy("status").count().collect()
}
print(f"target rows: {n_target}  statuses: {statuses}")

result = {
    "target_table": TARGET_TABLE,
    "source_table": f"{LAKEBASE_DB}:{SOURCE_TABLE}",
    "rows_read": len(rows),
    "rows_in_target": n_target,
    "merge": {k: int(v) for k, v in merge_stats.items()} if merge_stats else {},
    "statuses": statuses,
}
print(json.dumps(result, indent=2, default=str))
if IN_NOTEBOOK:
    dbutils.notebook.exit(json.dumps(result, default=str))
