# Databricks notebook source
# MAGIC %md
# MAGIC # NorthPeak Retail — Stockout & Markdown Rescue · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the NorthPeak demo under `<catalog>.<schema>`
# MAGIC using Spark (Databricks Connect serverless when run locally, the runtime's
# MAGIC `spark` when run as a job). Follows the `databricks-synthetic-data-gen` skill:
# MAGIC `spark.range` + `F.when` + broadcast joins + Window + `F.element_at` against
# MAGIC literal arrays — no driver loops, no `.collect()` on big tables, no `.cache()`.
# MAGIC
# MAGIC **The load-bearing anomaly** (one misallocation, two visible symptoms): an early
# MAGIC cold snap ~3 weeks ago flipped demand for 5 cold-weather apparel SKUs — they sell
# MAGIC out in the ~30 northern (cold-climate) stores while piling up as dead stock in the
# MAGIC ~40 southern (warm-climate) stores. Same SKUs, opposite problem. The hero shortfall
# MAGIC is `STORE-0214` (Denver) × `SKU-APP-04412` (Summit Down Parka); the surplus that
# MAGIC covers it is `STORE-0377` (Colorado Springs, ~100 mi away). See `specifications/01-lakeflow.md`.
# MAGIC
# MAGIC **This is a worked example of the technique, not a fill-in-the-blanks template** —
# MAGIC a different demo rewrites the domain, schema, and anomaly. What carries over is the
# MAGIC *shape*: Spark-native idioms + one concentrated, explainable anomaly against a
# MAGIC realistic baseline. This script writes the RAW parquet datasets only; silver + gold
# MAGIC are the SDP pipeline's job (`src/pipeline/*.sql`).

# COMMAND ----------

from __future__ import annotations

import os
from datetime import datetime, timedelta

import numpy as np
from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql.window import Window

# ── Config ─────────────────────────────────────────────────────────────────
# Catalog/schema are parametrized (widgets in-job, env locally) so a DAB can
# deploy this to any workspace.
IN_NOTEBOOK = "dbutils" in dir()
if IN_NOTEBOOK:
    dbutils.widgets.text("catalog", "", "Catalog")
    dbutils.widgets.text("schema", "", "Schema")
    CATALOG = dbutils.widgets.get("catalog")
    SCHEMA = dbutils.widgets.get("schema")
else:
    import argparse

    _p = argparse.ArgumentParser()
    _p.add_argument("--catalog", default=os.environ.get("DEMO_CATALOG"))
    _p.add_argument("--schema", default=os.environ.get("DEMO_SCHEMA"))
    _a, _ = _p.parse_known_args()
    CATALOG, SCHEMA = _a.catalog, _a.schema
assert CATALOG and SCHEMA, "catalog + schema required (widgets in-job, --catalog/--schema or DEMO_CATALOG/DEMO_SCHEMA locally)"

# Volume holding the raw parquet datasets — the single source of raw truth.
# The SDP silver layer reads these via read_files() (no bronze, no raw Delta).
RAW_VOL = "raw_data"

# ── Story timeline ───────────────────────────────────────────────────────────
# NOW is the single source of truth. Default is ROLLING (datetime.now()) so the
# dashboard's right edge is always yesterday-real. Set NORTHPEAK_PIN_TIME=1 to
# freeze for recorded demos / baked-in IDs.
STORY_PINNED_NOW = datetime(2026, 8, 1)
NOW = STORY_PINNED_NOW if os.environ.get("NORTHPEAK_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)        # 18-month sell-through + transfer history
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
SNAP_ONSET = NOW - timedelta(days=21)             # cold snap begins ~3 weeks ago
VELOCITY_RAMP = NOW - timedelta(days=18)          # northern velocity on affected SKUs climbs
SNAPSHOT_DATE = NOW - timedelta(days=1)           # the "current" inventory snapshot
INV_WINDOW_START = NOW - timedelta(days=14)       # daily snapshots for the last ~14 days

# ── Deterministic story anchors (must match specs) ───────────────────────────
N_STORES = 400
N_PRODUCTS = 2_000                                # catalog sample (40K SKUs is talk-track)
N_AFFECTED_NORTH = 30                             # stocked-out northern stores
N_AFFECTED_SOUTH = 40                             # over-stocked southern stores

HERO_STORE = "STORE-0214"                         # Denver — the demo's spotlight shortfall
HERO_SURPLUS_STORE = "STORE-0377"                 # Colorado Springs (~100 mi from Denver) — the transfer source
HERO_SKU = "SKU-APP-04412"                        # Summit Down Parka

# The cold-weather apparel cluster — demand moves together when the weather turns.
# Each carries a searchable `description` — the substitute-recovery move + the app's
# product search run over these via Lakebase Search (hybrid text/vector on
# name+description). The three insulated outerwear/mid-layer items read as mutual
# substitutes so "find a comparable warm jacket" returns real candidates.
AFFECTED = [
    ("SKU-APP-04412", "Summit Down Parka",          "Apparel", "Outerwear",   249.0, 96.0,
     "Heavyweight insulated winter parka, 600-fill down, waterproof shell, storm hood — warmest cold-weather outerwear."),
    ("SKU-APP-04418", "Ridgeline Insulated Jacket",  "Apparel", "Outerwear",   189.0, 74.0,
     "Insulated winter jacket, synthetic fill, water-resistant shell — a warm midweight alternative to a down parka."),
    ("SKU-APP-04431", "Timberline Fleece Hoodie",    "Apparel", "Tops",         79.0, 24.0,
     "Heavy fleece hooded pullover, warm mid-layer for cold weather — pairs under a shell or wears standalone."),
    ("SKU-APP-04455", "Alpine Wool Beanie",          "Apparel", "Accessories",  34.0,  9.0,
     "Warm ribbed wool beanie, cold-weather head layer."),
    ("SKU-APP-04460", "Frostguard Thermal Gloves",   "Apparel", "Accessories",  44.0, 12.0,
     "Insulated thermal winter gloves, touchscreen fingertips, water-resistant."),
]
AFFECTED_SKUS = [a[0] for a in AFFECTED]

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('NORTHPEAK_PIN_TIME') == '1' else 'rolling'})")
print(f"SNAP_ONSET: {SNAP_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_STORE} short on {HERO_SKU}; surplus at {HERO_SURPLUS_STORE}")

# Reuse the runtime's spark when run as a job/notebook; else build a
# databricks-connect serverless session for local runs.
try:
    spark  # noqa: F821
except NameError:
    from databricks.connect import DatabricksSession

    spark = (
        DatabricksSession.builder.profile(os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"))
        .serverless(True)
        .getOrCreate()
    )

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.{RAW_VOL}")
RAW_VOL_ROOT = f"/Volumes/{CATALOG}/{SCHEMA}/{RAW_VOL}"


def _raw_path(table: str) -> str:
    """Volume subdir for a raw dataset: strip the `raw_` prefix."""
    return f"{RAW_VOL_ROOT}/{table.removeprefix('raw_')}"


def _save(df: DataFrame, table: str) -> None:
    """Write a raw dataset as parquet FILES into the UC Volume."""
    path = _raw_path(table)
    df.write.mode("overwrite").parquet(path)
    n = spark.read.parquet(path).count()
    print(f"  ✓ {table:26s} rows={n:>10,}  → {path}")


# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Stores — 400 US stores, climate-tagged, GPS-anchored
# MAGIC The North/South climate tag drives the whole story: cold-weather apparel sells
# MAGIC in the North, sits in the South. The affected northern + southern stores are the
# MAGIC first `N_AFFECTED_NORTH` / `N_AFFECTED_SOUTH` stores in their zone, with the hero
# MAGIC store + surplus store pinned to fixed IDs.

# COMMAND ----------

print("\n[1/6] Generating stores...")

# City anchors: (city, state, lat, lng, climate_zone, region). Cold cities → North,
# warm cities → South, temperate → Mixed. Weighted so the affected clusters land in
# the right zones.
_CITIES_NORTH = [
    ("Denver", "CO", 39.74, -104.99, "West"),
    ("Minneapolis", "MN", 44.98, -93.27, "Midwest"),
    ("Chicago", "IL", 41.88, -87.63, "Midwest"),
    ("Boston", "MA", 42.36, -71.06, "Northeast"),
    ("Buffalo", "NY", 42.89, -78.88, "Northeast"),
    ("Salt Lake City", "UT", 40.76, -111.89, "West"),
    ("Detroit", "MI", 42.33, -83.05, "Midwest"),
    ("Portland", "OR", 45.52, -122.68, "West"),
    ("Milwaukee", "WI", 43.04, -87.91, "Midwest"),
    ("Pittsburgh", "PA", 40.44, -79.996, "Northeast"),
]
_CITIES_SOUTH = [
    ("Phoenix", "AZ", 33.45, -112.07, "West"),
    ("Miami", "FL", 25.76, -80.19, "Southeast"),
    ("Houston", "TX", 29.76, -95.37, "South-Central"),
    ("San Diego", "CA", 32.72, -117.16, "West"),
    ("Tampa", "FL", 27.95, -82.46, "Southeast"),
    ("Dallas", "TX", 32.78, -96.80, "South-Central"),
    ("Orlando", "FL", 28.54, -81.38, "Southeast"),
    ("San Antonio", "TX", 29.42, -98.49, "South-Central"),
    ("New Orleans", "LA", 29.95, -90.07, "South-Central"),
    ("Jacksonville", "FL", 30.33, -81.66, "Southeast"),
]
_CITIES_MIXED = [
    ("Atlanta", "GA", 33.75, -84.39, "Southeast"),
    ("Charlotte", "NC", 35.23, -80.84, "Southeast"),
    ("Nashville", "TN", 36.16, -86.78, "South-Central"),
    ("Kansas City", "MO", 39.10, -94.58, "Midwest"),
    ("Sacramento", "CA", 38.58, -121.49, "West"),
    ("Richmond", "VA", 37.54, -77.44, "Northeast"),
]
# Colorado Springs — ~110 km south of Denver, same West region. The hero SURPLUS
# store lives here so the recommended transfer is genuinely "a short drive away"
# (Denver 39.74,-104.99 → here). Climate "Mixed": it gets cold, but this store
# was over-allocated on the plan and the cold snap concentrated demand in the
# Denver metro, so its cold-weather stock hasn't moved — a believable nearby surplus.
_CITY_COLO_SPRINGS = ("Colorado Springs", "CO", 38.83, -104.82, "West")
_FORMATS = ["flagship", "standard", "standard", "standard", "express"]


def _build_stores() -> list[tuple]:
    rng = np.random.default_rng(seed=7)
    out: list[tuple] = []
    # Assign zones: ~35% North, ~35% South, ~30% Mixed.
    n_north = int(N_STORES * 0.35)
    n_south = int(N_STORES * 0.35)
    zones = ["North"] * n_north + ["South"] * n_south + ["Mixed"] * (N_STORES - n_north - n_south)
    rng.shuffle(zones)
    # Force the hero store (index 213 → STORE-0214) to North/Denver and the
    # surplus store (index 376 → STORE-0377) to Colorado Springs (~110 km away,
    # same West region) — a nearby over-stocked store the transfer draws from.
    zones[213] = "North"
    zones[376] = "Mixed"
    for i in range(N_STORES):
        sid = f"STORE-{i + 1:04d}"
        z = zones[i]
        if sid == HERO_STORE:
            city, state, lat, lng, region = _CITIES_NORTH[0]  # Denver
        elif sid == HERO_SURPLUS_STORE:
            city, state, lat, lng, region = _CITY_COLO_SPRINGS  # ~110 km from Denver
        else:
            pool = _CITIES_NORTH if z == "North" else _CITIES_SOUTH if z == "South" else _CITIES_MIXED
            city, state, lat, lng, region = pool[int(rng.integers(0, len(pool)))]
        jlat = round(lat + float(rng.uniform(-0.02, 0.02)), 2)
        jlng = round(lng + float(rng.uniform(-0.02, 0.02)), 2)
        open_offset = int(rng.integers(400, 4000))
        out.append((
            sid, f"NorthPeak {city} #{i + 1:04d}", region, z, city, state, jlat, jlng,
            (NOW - timedelta(days=open_offset)).date().isoformat(),
            int(rng.integers(18_000, 120_000)),
            str(rng.choice(_FORMATS)),
        ))
    return out


stores_rows = _build_stores()
stores_df = spark.createDataFrame(
    stores_rows,
    "store_id string, store_name string, region string, climate_zone string, city string, "
    "state string, store_lat double, store_lng double, open_date string, square_feet int, format string",
).withColumn("open_date", F.to_date("open_date"))
_save(stores_df, "raw_stores")

# Sets we reuse below (small — driver-side is fine).
NORTH_STORES = [r[0] for r in stores_rows if r[3] == "North"]
SOUTH_STORES = [r[0] for r in stores_rows if r[3] == "South"]
# The affected clusters: first N northern stores (incl. hero) short; the over-stocked
# set is the hero surplus (Colorado Springs, Mixed-climate but over-allocated) + the
# first southern stores. Over-stock is an inventory posture, not a pure climate tag —
# so the nearby surplus store belongs here even though its zone is Mixed.
AFFECTED_NORTH = ([HERO_STORE] + [s for s in NORTH_STORES if s != HERO_STORE])[:N_AFFECTED_NORTH]
AFFECTED_SOUTH = ([HERO_SURPLUS_STORE] + [s for s in SOUTH_STORES if s != HERO_SURPLUS_STORE])[:N_AFFECTED_SOUTH]

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Products — ~2K catalog sample; the 5 affected SKUs pinned in Apparel
# MAGIC `seasonality` (`cold_weather`/`warm_weather`/`all_season`) is what makes demand
# MAGIC climate-driven. The 5 affected SKUs are `cold_weather`.

# COMMAND ----------

print("\n[2/6] Generating products...")

_APPAREL_NAMES = ["Tee", "Chino", "Denim", "Sweater", "Shorts", "Dress", "Sneaker", "Boot", "Jacket", "Polo"]
_HOME_NAMES = ["Duvet", "Cookware Set", "Lamp", "Rug", "Towel Set", "Curtain", "Pillow", "Blender", "Frame", "Vase"]
_GM_NAMES = ["Notebook", "Backpack", "Water Bottle", "Charger", "Headphones", "Toy", "Game", "Umbrella", "Mug", "Speaker"]


def _build_products() -> list[tuple]:
    rng = np.random.default_rng(seed=42)
    out: list[tuple] = []
    # Affected SKUs first — cold_weather, exact values + rich search descriptions.
    for pid, name, cat, sub, price, cost, desc in AFFECTED:
        out.append((pid, name, cat, sub, price, cost, "cold_weather", desc))
    families = [
        ("Apparel", ["Outerwear", "Tops", "Bottoms", "Footwear", "Accessories"], _APPAREL_NAMES, (20.0, 260.0), 0.45),
        ("Home", ["Bedding", "Kitchen", "Decor", "Bath"], _HOME_NAMES, (15.0, 400.0), 0.30),
        ("General Merchandise", ["Electronics", "Toys", "Travel", "Misc"], _GM_NAMES, (5.0, 120.0), 0.25),
    ]
    n_remaining = N_PRODUCTS - len(AFFECTED)
    idx = 0
    cat_prefix = {"Apparel": "APP", "Home": "HOM", "General Merchandise": "GM"}
    _seas_phrase = {
        "cold_weather": "warm cold-weather", "warm_weather": "lightweight warm-weather", "all_season": "all-season",
    }
    for cat, subs, names, (lo, hi), share in families:
        n_cat = int(n_remaining * share)
        for _ in range(n_cat):
            sub = str(rng.choice(subs))
            base = str(rng.choice(names))
            name = f"{base} {rng.integers(100, 999)}"
            price = round(float(rng.uniform(lo, hi)), 2)
            # Apparel gets a real seasonality mix; Home/GM mostly all_season.
            if cat == "Apparel":
                seas = str(rng.choice(["cold_weather", "warm_weather", "all_season"], p=[0.30, 0.30, 0.40]))
            else:
                seas = str(rng.choice(["warm_weather", "all_season"], p=[0.15, 0.85]))
            # A short searchable description (name + seasonality + category) so
            # Lakebase Search / the app's product search has real text to match.
            desc = f"{_seas_phrase[seas]} {sub.lower()} {base.lower()} in {cat.lower()}."
            out.append((
                f"SKU-{cat_prefix[cat]}-{idx + 10000:05d}", name, cat, sub,
                price, round(price * 0.42, 2), seas, desc,
            ))
            idx += 1
    return out


products_rows = _build_products()
products_df = (
    spark.createDataFrame(
        products_rows,
        "product_id string, product_name string, category string, subcategory string, "
        "price_usd double, cost_usd double, seasonality string, description string",
    )
    .withColumn("launch_date", F.date_sub(F.lit(NOW.date().isoformat()).cast("date"), (F.rand(1) * 1500).cast("int")))
    .withColumn("is_active", F.lit(True))
)
_save(products_df, "raw_products")

# Price lookup for the affected SKUs (driver-side; small).
AFFECTED_PRICE = {a[0]: a[4] for a in AFFECTED}

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Sales — 18 months of daily store×SKU POS sell-through
# MAGIC Baseline sales for a broad set of store×SKU pairs, PLUS the cold-snap velocity
# MAGIC divergence on the affected SKUs: northern affected stores ramp ~3× from
# MAGIC `VELOCITY_RAMP`; southern affected stores stay near zero. Pure Spark — build a
# MAGIC (store × SKU × day) grid for the affected cluster with an explicit velocity curve,
# MAGIC and a sampled baseline grid for everything else.

# COMMAND ----------

print("\n[3/6] Generating sales...")

_prices = F.broadcast(
    spark.createDataFrame([(a[0], a[4]) for a in AFFECTED], "product_id string, price_usd double")
)

# --- Affected cluster sales: north (ramping) — the load-bearing velocity signal.
# Grid = affected northern stores × affected SKUs × last 60 days (dense so the ramp reads).
north_grid = (
    spark.createDataFrame([(s,) for s in AFFECTED_NORTH], "store_id string")
    .crossJoin(spark.createDataFrame([(a[0],) for a in AFFECTED], "product_id string"))
    .crossJoin(spark.range(0, 60).withColumnRenamed("id", "day_offset"))
    .withColumn("sale_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("day_offset").cast("int")))
)
ramp_start_off = (SNAPSHOT_DATE - VELOCITY_RAMP).days   # days before snapshot the ramp began
# Recent 7-day velocity drives lost_sales_exposure (velocity × price × 30d horizon).
# Tuned so the ~150 affected northern positions roll up to ~$4.8M lost-sales exposure:
# ramped ~1.9× a 3–6 unit base ≈ 7–9 units/day on the hero parka.
north_sales = (
    north_grid
    .withColumn(
        "mult",
        F.when(F.col("day_offset") <= F.lit(ramp_start_off), 1.6 + F.rand(11) * 0.6)  # ramped (recent)
        .otherwise(0.8 + F.rand(12) * 0.3),                                            # pre-snap baseline
    )
    .withColumn("units_sold", F.greatest(F.lit(0), (F.col("mult") * (3 + F.rand(13) * 3)).cast("int")))
    .join(_prices, "product_id")
    .withColumn("net_sales_usd", F.round(F.col("units_sold") * F.col("price_usd"), 2))
    .withColumn("channel", F.element_at(F.array(F.lit("in_store"), F.lit("bopis"), F.lit("ship_from_store")), (F.rand(14) * 3 + 1).cast("int")))
    .filter(F.col("units_sold") > 0)
    .select("store_id", "product_id", "sale_date", "units_sold", "net_sales_usd", "channel")
)

# --- Baseline sales: a sampled broad grid (everyday). Sparse — one row per store×SKU×day
# that "sold". Use spark.range to synthesize ~3.3M rows without a full cross join.
N_BASELINE = 3_300_000
store_arr = F.array(*[F.lit(s) for s in [r[0] for r in stores_rows]])
# Baseline draws from NON-affected products only — the affected SKUs' sales come
# solely from the controlled `north_sales` grid above. This keeps the southern
# affected positions at zero recent affected-SKU velocity (→ clean `overstock`
# classification) and stops random baseline sales from muddying the signal.
_baseline_products = [p[0] for p in products_rows if p[0] not in AFFECTED_SKUS][:400]
prod_arr = F.array(*[F.lit(p) for p in _baseline_products])  # popular non-affected subset
_n_baseline_prod = len(_baseline_products)
baseline_sales = (
    spark.range(0, N_BASELINE)
    .withColumn("store_id", F.element_at(store_arr, (F.rand(21) * len(stores_rows) + 1).cast("int")))
    .withColumn("product_id", F.element_at(prod_arr, (F.rand(22) * _n_baseline_prod + 1).cast("int")))
    .withColumn("sale_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(23) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("dow_mult", F.when(F.dayofweek("sale_date").isin(1, 7), 1.6).otherwise(1.0))
    .withColumn("units_sold", F.greatest(F.lit(1), (F.col("dow_mult") * (1 + F.rand(24) * 3)).cast("int")))
    .join(F.broadcast(products_df.select("product_id", "price_usd")), "product_id")
    .withColumn("net_sales_usd", F.round(F.col("units_sold") * F.col("price_usd"), 2))
    .withColumn("channel", F.element_at(F.array(F.lit("in_store"), F.lit("bopis"), F.lit("ship_from_store")), (F.rand(25) * 3 + 1).cast("int")))
    .select("store_id", "product_id", "sale_date", "units_sold", "net_sales_usd", "channel")
)

sales_df = north_sales.unionByName(baseline_sales)
_save(sales_df, "raw_sales")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Inventory snapshots — daily on-hand for the last ~14 days + current
# MAGIC The current snapshot is where both symptoms live: affected northern positions →
# MAGIC on_hand 0; affected southern positions → high on_hand. Everyday positions get
# MAGIC healthy on-hand. `merch_note_text` (the `ai_classify` signal) skews aging on the
# MAGIC southern surplus.

# COMMAND ----------

print("\n[4/6] Generating inventory snapshots...")

_AGING_NOTES = [
    "season ending, still full racks", "no movement in three weeks",
    "warm-weather store, cold gear not selling", "overstocked vs plan", "clearance candidate",
]
_HEALTHY_NOTES = ["selling to plan", "steady turns", None, None]

aging_arr = F.array(*[F.lit(x) for x in _AGING_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])

# Build the affected positions (store × affected SKU) for both zones, across the
# daily snapshot window + the current snapshot.
n_snap_days = (SNAPSHOT_DATE - INV_WINDOW_START).days + 1
aff_north_pos = spark.createDataFrame([(s,) for s in AFFECTED_NORTH], "store_id string").withColumn("zone", F.lit("North"))
aff_south_pos = spark.createDataFrame([(s,) for s in AFFECTED_SOUTH], "store_id string").withColumn("zone", F.lit("South"))
affected_positions = (
    aff_north_pos.unionByName(aff_south_pos)
    .crossJoin(spark.createDataFrame([(a[0],) for a in AFFECTED], "product_id string"))
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
)
# North: on_hand decays to 0 by ~7 days ago (drained by the ramp). South: high, static.
affected_inv = (
    affected_positions
    .withColumn(
        "on_hand_units",
        F.when(
            F.col("zone") == "North",
            F.greatest(F.lit(0), (40 - (F.lit(n_snap_days) - 1 - F.col("d")) * 7 - (F.rand(31) * 5)).cast("int")),
        ).otherwise((550 + F.rand(32) * 450).cast("int")),  # southern surplus: many weeks of supply, drives ~$5.6M markdown exposure
    )
    .withColumn("on_order_units", F.when(F.col("zone") == "North", (F.rand(33) * 20).cast("int")).otherwise(F.lit(0)))
    .withColumn(
        "merch_note_text",
        F.when(
            (F.col("zone") == "South") & (F.rand(34) < 0.85), F.element_at(aging_arr, (F.rand(35) * len(_AGING_NOTES) + 1).cast("int")),
        ).when(F.rand(36) < 0.3, F.element_at(healthy_arr, (F.rand(37) * len(_HEALTHY_NOTES) + 1).cast("int")))
        .otherwise(F.lit(None).cast("string")),
    )
    .select("store_id", "product_id", "snapshot_date", "on_hand_units", "on_order_units", "merch_note_text")
)

# Everyday positions: current-snapshot only, healthy on-hand, HEALTHY notes only.
# The anomaly is confined to the affected SKUs — everyday positions must never
# read as 'overstock' (that would paint amber noise all over the map on SKUs the
# story isn't about). So no aging notes here → markdown_risk stays low → the
# gold overstock rule (which requires markdown_risk >= 0.6) can't fire on them.
everyday_inv = (
    spark.range(0, 250_000)
    .withColumn("store_id", F.element_at(store_arr, (F.rand(41) * len(stores_rows) + 1).cast("int")))
    .withColumn("product_id", F.element_at(prod_arr, (F.rand(42) * _n_baseline_prod + 1).cast("int")))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("on_hand_units", (20 + F.rand(43) * 120).cast("int"))
    .withColumn("on_order_units", (F.rand(44) * 30).cast("int"))
    .withColumn("merch_note_text", F.element_at(healthy_arr, (F.rand(47) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("store_id", "product_id", "snapshot_date", "on_hand_units", "on_order_units", "merch_note_text")
)

inventory_df = affected_inv.unionByName(everyday_inv)
_save(inventory_df, "raw_inventory_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Transfers — 18 months of recovery moves with outcomes (model training)
# MAGIC The recovery model learns from these: `transfer` from a close, same-region,
# MAGIC high-surplus source recaptures the most per dollar; `expedite` wins when no nearby
# MAGIC surplus exists; `substitute` recaptures less and thins margin. This separation is
# MAGIC what lets the model rank the hero shortfall as a transfer.

# COMMAND ----------

print("\n[5/6] Generating transfers...")

store_all_arr = F.array(*[F.lit(s) for s in [r[0] for r in stores_rows]])
aff_sku_arr = F.array(*[F.lit(a[0]) for a in AFFECTED])
sub_sku_arr = F.array(*[F.lit(a[0]) for a in AFFECTED])  # substitutes drawn from the same cluster

transfers_df = (
    spark.range(0, 40_000)
    .withColumn("transfer_id", F.concat(F.lit("TRF-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("move_type", F.element_at(F.array(F.lit("transfer"), F.lit("transfer"), F.lit("expedite"), F.lit("substitute")), (F.rand(51) * 4 + 1).cast("int")))
    .withColumn("product_id", F.element_at(aff_sku_arr, (F.rand(52) * len(AFFECTED) + 1).cast("int")))
    .withColumn("to_store_id", F.element_at(store_all_arr, (F.rand(53) * len(stores_rows) + 1).cast("int")))
    .withColumn("from_store_id", F.when(F.col("move_type") == "transfer", F.element_at(store_all_arr, (F.rand(54) * len(stores_rows) + 1).cast("int"))).otherwise(F.lit(None).cast("string")))
    .withColumn("substitute_product_id", F.when(F.col("move_type") == "substitute", F.element_at(sub_sku_arr, (F.rand(55) * len(AFFECTED) + 1).cast("int"))).otherwise(F.lit(None).cast("string")))
    .withColumn("units_moved", (20 + F.rand(56) * 80).cast("int"))
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(57) * HIST_SPAN_DAYS).cast("int")))
    # distance: transfers have a real distance; expedite (DC) + substitute ~ 0.
    .withColumn("distance_km", F.when(F.col("move_type") == "transfer", F.round(30 + F.rand(58) * 900, 1)).otherwise(F.lit(0.0)))
    .withColumn("days_to_fulfill", F.when(F.col("move_type") == "transfer", (1 + F.rand(59) * 2).cast("int")).when(F.col("move_type") == "expedite", (3 + F.rand(60) * 3).cast("int")).otherwise(F.lit(0)))
    .join(F.broadcast(products_df.select("product_id", "price_usd", "cost_usd")), "product_id")
    # --- Learnable outcomes (ranked by NET VALUE = recaptured − cost − margin_impact,
    # which is how 03-ml-recovery ranks the moves) ---
    # transfer:  high recapture, modest cost that scales with distance → BEST net when
    #            a nearby same-region surplus exists (the hero case: short drive, cheap).
    # expedite:  high recapture but heavy freight cost → net trails transfer unless no
    #            surplus is nearby (long transfer distance flips the ranking to expedite).
    # substitute: the customer leaks to a different (often cheaper) item → LOW recapture
    #            AND a real margin hit → clearly the worst net, so the model never learns
    #            "always substitute". Cheap to execute, but that doesn't rescue its net.
    .withColumn(
        "recaptured_sales_usd",
        F.when(F.col("move_type") == "transfer", F.round(F.col("units_moved") * F.col("price_usd") * (0.90 - F.col("distance_km") / 6000.0), 2))
        .when(F.col("move_type") == "expedite", F.round(F.col("units_moved") * F.col("price_usd") * 0.82, 2))
        .otherwise(F.round(F.col("units_moved") * F.col("price_usd") * 0.35, 2)),  # substitute leaks demand
    )
    .withColumn(
        "cost_usd",
        F.when(F.col("move_type") == "transfer", F.round(60 + F.col("distance_km") * 1.1, 2))
        .when(F.col("move_type") == "expedite", F.round(F.col("units_moved") * 9.0 + 400, 2))  # heavy freight
        .otherwise(F.lit(25.0)),
    )
    .withColumn(
        "margin_impact_usd",
        # substitute erodes margin (lower-margin item + discount to convert); the others
        # don't touch unit margin. Sized so substitute's NET (recap − cost − margin) is
        # the lowest of the three despite its trivial execution cost.
        F.when(F.col("move_type") == "substitute", F.round(F.col("units_moved") * (F.col("price_usd") - F.col("cost_usd")) * 0.45, 2)).otherwise(F.lit(0.0)),
    )
    .select(
        "transfer_id", "product_id", "from_store_id", "to_store_id", "move_type",
        "substitute_product_id", "units_moved", "initiated_date", "distance_km",
        "days_to_fulfill", "recaptured_sales_usd", "margin_impact_usd", "cost_usd",
    )
)
_save(transfers_df, "raw_transfers")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Store traffic — daily foot traffic (context)

# COMMAND ----------

print("\n[6/6] Generating store traffic...")

traffic_df = (
    spark.range(0, 400 * 550)  # ~400 stores × ~550 days
    .withColumn("store_id", F.element_at(store_all_arr, (F.col("id") % len(stores_rows) + 1).cast("int")))
    .withColumn("traffic_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.col("id") % 550).cast("int")))
    .withColumn("dow_mult", F.when(F.dayofweek("traffic_date").isin(1, 7), 1.7).otherwise(1.0))
    .withColumn("traffic_count", (F.col("dow_mult") * (400 + F.rand(61) * 900)).cast("int"))
    .select("store_id", "traffic_date", "traffic_count")
)
_save(traffic_df, "raw_store_traffic")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Six raw datasets written to the Volume. Next: run the SDP pipeline
# MAGIC (`src/pipeline/*.sql`) to build silver + gold, then the metric view, the recovery
# MAGIC model (`src/ml/recovery_train_score.py`), the dashboard, and the Genie space.
# MAGIC Validate against `specifications/01-lakeflow.md` Section C before publishing.

# COMMAND ----------

print("\n✅ NorthPeak raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero shortfall: {HERO_STORE} × {HERO_SKU}  → surplus at {HERO_SURPLUS_STORE}")
print(f"   Affected north stores: {len(AFFECTED_NORTH)}  south stores: {len(AFFECTED_SOUTH)}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_store": HERO_STORE, "hero_sku": HERO_SKU, "surplus_store": HERO_SURPLUS_STORE,
        "affected_north": len(AFFECTED_NORTH), "affected_south": len(AFFECTED_SOUTH),
    }))
