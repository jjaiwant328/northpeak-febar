# Databricks notebook source
# MAGIC %md
# MAGIC # NorthPeak v2 — Recovery-Move Recommendation: train + register + batch-score
# MAGIC
# MAGIC Trains a real ML model (XGBoost regressor) that **learns `recaptured_sales_usd`**
# MAGIC from NorthPeak's transfer history (`gold_transfer_outcomes`), registers it in Unity
# MAGIC Catalog as `recovery_recommender @prod`, then batch-scores the three candidate moves
# MAGIC (transfer / expedite / substitute) for every open shortfall and writes the ranked
# MAGIC result to `gold_recovery_recommendations_ml`.
# MAGIC
# MAGIC Spec: `specifications/03-ml-recovery.md`. The pipeline's heuristic MV
# MAGIC (`gold_recovery_recommendations`) is untouched — the model's output lands in a
# MAGIC shadow table (`_ml`) so consumers can be cut over deliberately.
# MAGIC
# MAGIC Run as the `northpeak_ml_v2` serverless job (widgets: `catalog`, `schema`).

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

USER = spark.sql("SELECT current_user()").first()[0]
EXPERIMENT = f"/Users/{USER}/northpeak-addons/experiments/recovery_recommender"
MODEL_NAME = f"{CATALOG}.{SCHEMA}.recovery_recommender"

FEATURES = [
    "move_type", "distance_km", "units_moved", "days_to_fulfill",
    "price_usd", "margin_pct", "same_region",
]
LABEL = "recaptured_sales_usd"

print(f"catalog={CATALOG} schema={SCHEMA} model={MODEL_NAME}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1 · Training data — one row per historical move + realized outcome

# COMMAND ----------

train_sdf = spark.table(f"{CATALOG}.{SCHEMA}.gold_transfer_outcomes").select(
    "move_type", "distance_km", "units_moved", "days_to_fulfill",
    "price_usd", "margin_pct", "same_region",
    "recaptured_sales_usd",
)

pdf = train_sdf.toPandas()
pdf["same_region"] = pdf["same_region"].astype(int)
pdf["move_type"] = pdf["move_type"].astype("category")
for c in ["distance_km", "units_moved", "days_to_fulfill", "price_usd", "margin_pct"]:
    pdf[c] = pdf[c].fillna(0.0).astype(float)
print(f"training rows: {len(pdf)}  label mean=${pdf[LABEL].mean():,.0f}  label std=${pdf[LABEL].std():,.0f}")
print(pdf.groupby("move_type", observed=True)[LABEL].agg(["count", "mean"]).round(0))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2 · Tune + train — XGBoost regressor, Optuna (10 trials), MLflow autolog

# COMMAND ----------

import mlflow
import mlflow.xgboost
import numpy as np
import optuna
import xgboost as xgb
from sklearn.metrics import mean_squared_error
from sklearn.model_selection import train_test_split

mlflow.set_registry_uri("databricks-uc")
# Experiment parent-folder trap: set_experiment only creates the leaf — the
# parent folders must exist first, or it NOT_FOUNDs (spec: 03-ml-recovery.md).
try:
    from databricks.sdk import WorkspaceClient

    WorkspaceClient().workspace.mkdirs(EXPERIMENT.rsplit("/", 1)[0])
except Exception as e:  # folder may already exist; mkdirs is idempotent
    print(f"experiment parent mkdirs: {e}")
mlflow.set_experiment(EXPERIMENT)

X = pdf[FEATURES].copy()
X["move_type"] = X["move_type"].cat.codes
y = pdf[LABEL].astype(float)
X_tr, X_va, y_tr, y_va = train_test_split(X, y, test_size=0.2, random_state=42)

def objective(trial):
    params = {
        "objective": "reg:squarederror",
        "max_depth": trial.suggest_int("max_depth", 3, 8),
        "learning_rate": trial.suggest_float("learning_rate", 0.02, 0.3, log=True),
        "n_estimators": trial.suggest_int("n_estimators", 100, 600),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
        "min_child_weight": trial.suggest_int("min_child_weight", 1, 10),
        "random_state": 42,
        "n_jobs": -1,
    }
    m = xgb.XGBRegressor(**params)
    m.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
    return float(np.sqrt(mean_squared_error(y_va, m.predict(X_va))))

study = optuna.create_study(direction="minimize")
study.optimize(objective, n_trials=10, show_progress_bar=False)
print(f"best trial RMSE: ${study.best_value:,.0f}  params: {study.best_params}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3 · Final fit + register to UC as `recovery_recommender @prod`

# COMMAND ----------

mlflow.xgboost.autolog(log_models=False)
with mlflow.start_run(run_name="recovery_recommender_final") as run:
    final_params = {**study.best_params, "objective": "reg:squarederror", "random_state": 42, "n_jobs": -1}
    model = xgb.XGBRegressor(**final_params)
    model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
    rmse = float(np.sqrt(mean_squared_error(y_va, model.predict(X_va))))
    mlflow.log_metric("rmse", rmse)

    # Signature carries the categorical move_type as its code (int) — the batch
    # scoring path builds the same frame (move_type_indexed).
    X_sig = X_tr.copy()
    X_sig = X_sig.rename(columns={"move_type": "move_type_indexed"})

    class RecoveryModel(mlflow.pyfunc.PythonModel):
        def predict(self, context, model_input):
            frame = model_input.copy()
            frame["move_type"] = frame["move_type_indexed"]
            return self.model.predict(frame[FEATURES].rename(columns={"move_type": "move_type"}))

    wrapped = RecoveryModel()
    wrapped.model = model
    info = mlflow.pyfunc.log_model(
        artifact_path="model",
        python_model=wrapped,
        input_example=X_sig.head(5),
        registered_model_name=MODEL_NAME,
    )
    print(f"run={run.info.run_id} rmse=${rmse:,.0f}")

client = mlflow.tracking.MlflowClient()
latest = max(v.version for v in client.search_model_versions(f"name='{MODEL_NAME}'"))
client.set_registered_model_alias(MODEL_NAME, "prod", latest)
model_version = int(latest)
print(f"registered {MODEL_NAME} v{model_version} as @prod")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4 · Candidate moves for every open shortfall
# MAGIC
# MAGIC Same three plays the heuristic constructs — transfer from the nearest
# MAGIC surplus, expedite from the DC, substitute a comparable in-stock SKU —
# MAGIC with the **model's** predicted recaptured-$ instead of hand-set
# MAGIC coefficients. Cost / margin-impact remain documented estimates
# MAGIC (freight + markdown arithmetic); the ranking key is
# MAGIC `net_value = predicted_recaptured − cost − margin_impact`.

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.window import Window

MOVE_TYPE_IDX = {"transfer": 0, "expedite": 1, "substitute": 2}

shortfalls = spark.table(f"{CATALOG}.{SCHEMA}.gold_open_shortfalls").select(
    "store_id", "product_id", "on_hand_units", "avg_daily_velocity",
    "nearest_surplus_store_id", "nearest_surplus_on_hand", "nearest_surplus_distance_km",
).withColumn(
    "units_needed",
    F.greatest(F.lit(1), F.ceil(F.col("avg_daily_velocity") * 14).cast("int") - F.col("on_hand_units")),
)

# SKU economics (price + margin) from the position spine.
econ = (
    spark.table(f"{CATALOG}.{SCHEMA}.gold_store_sku_position")
    .select("product_id", "price_usd")
    .groupBy("product_id").agg(F.max("price_usd").alias("price_usd"))
    .withColumn("margin_pct", F.lit(0.45))
)

# Regions of shortfall store and surplus store for the same_region feature.
regions = (
    spark.table(f"{CATALOG}.{SCHEMA}.gold_store_sku_position")
    .select("store_id", "region").distinct()
)

# One comparable substitute SKU per category: same category, most network on-hand.
pos = spark.table(f"{CATALOG}.{SCHEMA}.gold_store_sku_position").select(
    "product_id", "category", "on_hand_units", "price_usd",
)
subs_w = Window.partitionBy("category").orderBy(F.col("tot_on_hand").desc())
substitutes = (
    pos.groupBy("category", "product_id")
    .agg(F.sum("on_hand_units").alias("tot_on_hand"))
    .withColumn("rn", F.row_number().over(subs_w))
    .filter("rn = 1")
    .select(F.col("category").alias("sub_category"), F.col("product_id").alias("substitute_product_id"))
)
sku_cat = pos.select("product_id", "category").distinct()

base = (
    shortfalls
    .join(econ, "product_id", "left")
    .join(sku_cat, "product_id", "left")
    .join(substitutes, sku_cat["category"] == F.col("sub_category"), "left")
    .drop("sub_category")
    .join(regions.alias("r_short"), shortfalls["store_id"] == F.col("r_short.store_id"), "left")
    .join(regions.alias("r_surp"), shortfalls["nearest_surplus_store_id"] == F.col("r_surp.store_id"), "left")
    .withColumn("same_region_bool",
                F.coalesce(F.col("r_short.region") == F.col("r_surp.region"), F.lit(False)))
    .select(
        shortfalls["*"], "price_usd", "margin_pct", "substitute_product_id", "same_region_bool",
    )
)

moves = []
move_specs = [
    ("transfer", F.least(F.col("units_needed"), F.coalesce(F.col("nearest_surplus_on_hand"), F.lit(0))), F.col("nearest_surplus_distance_km"), 2, F.col("same_region_bool")),
    ("expedite", F.col("units_needed"), F.lit(0.0), 4, F.lit(False)),
    ("substitute", F.col("units_needed"), F.lit(0.0), 0, F.lit(True)),
]
for move, units_expr, dist_expr, days, same_reg in move_specs:
    moves.append(
        base.select(
            "store_id", "product_id", "price_usd", "margin_pct",
            "nearest_surplus_store_id", "substitute_product_id",
            F.lit(move).alias("move_type"),
            units_expr.cast("double").alias("units_moved"),
            dist_expr.cast("double").alias("distance_km"),
            F.lit(days).cast("double").alias("days_to_fulfill"),
            same_reg.cast("int").alias("same_region"),
        )
    )
candidates = moves[0].unionByName(moves[1]).unionByName(moves[2])
candidates = candidates.withColumn(
    "move_type_indexed",
    F.when(F.col("move_type") == "transfer", 0)
     .when(F.col("move_type") == "expedite", 1)
     .otherwise(2).cast("int"),
)
print(f"candidate moves: {candidates.count()} (3 × open shortfalls)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5 · Batch-score with the registered model (`spark_udf` on `@prod`)

# COMMAND ----------

# env_manager="local": the job env already has xgboost installed — spinning up a
# fresh virtualenv per executor times out the first scoring batch on serverless.
score_udf = mlflow.pyfunc.spark_udf(
    spark, f"models:/{MODEL_NAME}@prod", env_manager="local",
)
scored = candidates.withColumn(
    "predicted_recaptured_usd",
    F.greatest(score_udf(F.struct("move_type_indexed", "distance_km", "units_moved",
                                  "days_to_fulfill", "price_usd", "margin_pct", "same_region")).cast("double"), F.lit(0.0)),
)

# Cost + margin-impact estimates (documented constants — freight & markdown arithmetic).
scored = (
    scored
    .withColumn("cost_usd", F.when(F.col("move_type") == "transfer",
                                   60 + F.col("distance_km") * 1.1)
                             .when(F.col("move_type") == "expedite",
                                   F.col("units_moved") * 9.0 + 400)
                             .otherwise(F.lit(0.0)))
    .withColumn("margin_impact_usd", F.when(F.col("move_type") == "substitute",
                                            F.col("units_moved") * F.col("price_usd") * 0.58 * 0.45)
                                      .otherwise(F.lit(0.0)))
    .withColumn("predicted_net_value_usd",
                F.col("predicted_recaptured_usd") - F.col("cost_usd") - F.col("margin_impact_usd"))
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6 · Rank per shortfall + write `gold_recovery_recommendations_ml`

# COMMAND ----------

rank_w = Window.partitionBy("store_id", "product_id").orderBy(F.col("predicted_net_value_usd").desc())
ranked = scored.withColumn("rn", F.row_number().over(rank_w))

top = ranked.filter("rn = 1").select(
    "store_id", "product_id",
    F.col("move_type").alias("recommended_move"),
    F.when(F.col("move_type") == "transfer", F.col("nearest_surplus_store_id")).alias("recommended_source_store_id"),
    F.when(F.col("move_type") == "substitute", F.col("substitute_product_id")).alias("recommended_substitute_product_id"),
    F.col("units_moved").cast("int").alias("recommended_units"),
    F.col("predicted_recaptured_usd"),
    F.col("predicted_net_value_usd"),
)

ranking_json = (
    ranked
    .withColumn("opt", F.struct(
        F.col("move_type").alias("move"),
        F.col("units_moved").cast("int").alias("units"),
        F.col("cost_usd"),
        F.col("predicted_recaptured_usd"),
        F.col("predicted_net_value_usd"),
        F.when(F.col("move_type") == "transfer", F.col("nearest_surplus_store_id")).alias("source_store_id"),
        F.when(F.col("move_type") == "substitute", F.col("substitute_product_id")).alias("substitute_product_id"),
    ))
    .groupBy("store_id", "product_id")
    .agg(F.to_json(F.sort_array(F.collect_list("opt"), asc=False)).alias("move_ranking"))
)

out = (
    top.join(ranking_json, ["store_id", "product_id"])
    .withColumn("scored_at", F.current_timestamp())
    .withColumn("model_version", F.lit(model_version))
)
out.write.mode("overwrite").saveAsTable(f"{CATALOG}.{SCHEMA}.gold_recovery_recommendations_ml")

n_shortfalls = spark.table(f"{CATALOG}.{SCHEMA}.gold_recovery_recommendations_ml").count()
mix = spark.table(f"{CATALOG}.{SCHEMA}.gold_recovery_recommendations_ml").groupBy("recommended_move").count().collect()
print(f"shortfalls scored: {n_shortfalls}  move mix: {[(r['recommended_move'], r['count']) for r in mix]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7 · Validation — hero shortfall + move mix + rollup

# COMMAND ----------

hero = spark.sql(f"""
  SELECT recommended_move, recommended_source_store_id, recommended_units,
         ROUND(predicted_recaptured_usd, 0) AS recaptured, ROUND(predicted_net_value_usd, 0) AS net
  FROM {CATALOG}.{SCHEMA}.gold_recovery_recommendations_ml
  WHERE store_id = 'STORE-0214' AND product_id = 'SKU-APP-04412'
""").first()
print("hero:", hero)

rollup = spark.sql(f"""
  SELECT ROUND(SUM(predicted_recaptured_usd), 0) AS total_recaptured,
         ROUND(SUM(predicted_net_value_usd), 0) AS total_net
  FROM {CATALOG}.{SCHEMA}.gold_recovery_recommendations_ml
""").first()
print("rollup:", rollup)

result = {
    "model_version": model_version,
    "rmse": round(rmse, 2),
    "shortfalls_scored": n_shortfalls,
    "transfer_recommended": next((r["count"] for r in mix if r["recommended_move"] == "transfer"), 0),
    "expedite_recommended": next((r["count"] for r in mix if r["recommended_move"] == "expedite"), 0),
    "substitute_recommended": next((r["count"] for r in mix if r["recommended_move"] == "substitute"), 0),
    "hero_move": hero["recommended_move"] if hero else None,
    "hero_source": hero["recommended_source_store_id"] if hero else None,
    "total_recaptured_usd": float(rollup["total_recaptured"]) if rollup else None,
}
print(json.dumps(result, indent=2))
if IN_NOTEBOOK:
    dbutils.notebook.exit(json.dumps(result))
