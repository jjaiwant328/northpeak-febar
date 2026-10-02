# Databricks notebook source
# MAGIC %md
# MAGIC # NorthPeak v2 — Recovery model evaluation: ML vs heuristic baseline
# MAGIC
# MAGIC Quantitative check beyond the training RMSE: score the held-out 20% of
# MAGIC `gold_transfer_outcomes` (same split as training, `random_state=42`)
# MAGIC with the registered `recovery_recommender @prod` AND with the closed-form
# MAGIC heuristic the gold MV uses (`gold_recovery_recommendations.sql`), then
# MAGIC compare both against the realized label (`recaptured_sales_usd`).
# MAGIC
# MAGIC Read-only: no retraining, no registry writes, no table writes. Exits
# MAGIC with a JSON summary captured as text evidence.

# COMMAND ----------

import json
import os

import mlflow
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, root_mean_squared_error
from sklearn.model_selection import train_test_split

CATALOG = os.environ.get("DEMO_CATALOG", "rtdemo")
SCHEMA = os.environ.get("DEMO_SCHEMA", "northpeak_v2")
MODEL_NAME = f"{CATALOG}.{SCHEMA}.recovery_recommender"

FEATURES = [
    "move_type", "distance_km", "units_moved", "days_to_fulfill",
    "price_usd", "margin_pct", "same_region",
]
LABEL = "recaptured_sales_usd"

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1 · Same data prep + split as training

# COMMAND ----------

train_sdf = spark.table(f"{CATALOG}.{SCHEMA}.gold_transfer_outcomes").select(
    "move_type", "distance_km", "units_moved", "days_to_fulfill",
    "price_usd", "margin_pct", "same_region", LABEL,
)
pdf = train_sdf.toPandas()
pdf["same_region"] = pdf["same_region"].astype(int)
pdf["move_type"] = pdf["move_type"].astype("category")
for c in ["distance_km", "units_moved", "days_to_fulfill", "price_usd", "margin_pct"]:
    pdf[c] = pdf[c].fillna(0.0).astype(float)

X = pdf[FEATURES].copy()
X["move_type"] = X["move_type"].cat.codes
y = pdf[LABEL].astype(float)
# Identical split to recovery_train_score.py — same held-out 20%.
X_tr, X_va, y_tr, y_va = train_test_split(X, y, test_size=0.2, random_state=42)
print(f"held-out rows: {len(X_va)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2 · Model predictions on held-out rows

# COMMAND ----------

mlflow.set_registry_uri("databricks-uc")
model = mlflow.pyfunc.load_model(f"models:/{MODEL_NAME}@prod")
# The registered signature names the encoded column move_type_indexed (the
# pyfunc wrapper renames it back internally) and types same_region as long.
X_in = X_va.rename(columns={"move_type": "move_type_indexed"}).copy()
X_in["move_type_indexed"] = X_in["move_type_indexed"].astype("int32")
X_in["same_region"] = X_in["same_region"].astype("int64")
model_pred = np.asarray(model.predict(X_in), dtype=float)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3 · Heuristic baseline on the same rows
# MAGIC
# MAGIC Mirrors `gold_recovery_recommendations.sql` closed-form recaptured-$:
# MAGIC transfer `units*price*0.9*(1-min(0.3, dist/1000))`, expedite
# MAGIC `units*price*0.82`, substitute `units*price*0.35`. The un-encoded
# MAGIC move_type comes from the original frame via the split indices.

# COMMAND ----------

va = pdf.loc[X_va.index]
heur_pred = np.select(
    [
        va["move_type"].astype(str) == "transfer",
        va["move_type"].astype(str) == "expedite",
    ],
    [
        va["units_moved"] * va["price_usd"] * 0.9
        * (1.0 - np.minimum(0.3, va["distance_km"] / 1000.0)),
        va["units_moved"] * va["price_usd"] * 0.82,
    ],
    default=va["units_moved"] * va["price_usd"] * 0.35,
).astype(float)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4 · Compare

# COMMAND ----------

result = {
    "model": MODEL_NAME + "@prod",
    "n_held_out": int(len(y_va)),
    "model_rmse": round(float(root_mean_squared_error(y_va, model_pred)), 2),
    "model_mae": round(float(mean_absolute_error(y_va, model_pred)), 2),
    "model_mean_signed_error": round(float((model_pred - y_va).mean()), 2),
    "heuristic_rmse": round(float(root_mean_squared_error(y_va, heur_pred)), 2),
    "heuristic_mae": round(float(mean_absolute_error(y_va, heur_pred)), 2),
    "heuristic_mean_signed_error": round(float((heur_pred - y_va).mean()), 2),
}
result["rmse_improvement_pct"] = round(
    100.0 * (result["heuristic_rmse"] - result["model_rmse"]) / result["heuristic_rmse"], 1,
)
print(json.dumps(result, indent=1))
dbutils.notebook.exit(json.dumps(result))
