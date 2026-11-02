import numpy as np
import pandas as pd
import pytest

from app.retention import preprocessing as prep
from app.retention.config import MODEL_FEATURES, REQUIRED_COLUMNS, RetentionConfig
from helpers import toy_frame


def test_real_phase3_schema_matches_required_columns(small_df):
    assert tuple(small_df.columns) == REQUIRED_COLUMNS
    prep.validate_training_frame(small_df)


def test_load_training_data_roundtrip_and_missing_file(tmp_path, small_df):
    path = tmp_path / "t.csv"
    small_df.to_csv(path, index=False)
    assert len(prep.load_training_data(path)) == len(small_df)
    with pytest.raises(FileNotFoundError, match="generate_all"):
        prep.load_training_data(tmp_path / "missing.csv")


@pytest.mark.parametrize("mutate,match", [
    (lambda d: d.drop(columns="distance_km"), "missing"),
    (lambda d: d.assign(extra=1), "unexpected"),
    (lambda d: d.assign(dropped_out=2), "0/1"),
    (lambda d: d.assign(dropped_out=0), "single class"),
    (lambda d: d.assign(participant_id="T-1"), "duplicate"),
    (lambda d: d.assign(phone_changed=3), "0/1"),
    (lambda d: d.assign(distance_km=d["distance_km"].where(d.index != 0)), "missing values"),  # required column null
    (lambda d: d.assign(missed_reminders=-1), "negative"),
    (lambda d: d.assign(visits_missed=99), "exceeds"),
    (lambda d: d.iloc[0:0], "empty"),
])
def test_schema_errors(mutate, match):
    with pytest.raises(prep.SchemaError, match=match):
        prep.validate_training_frame(mutate(toy_frame()))


def test_optional_columns_may_be_missing():
    df = toy_frame()
    df.loc[0, "age"] = np.nan
    df.loc[1, "reimbursement_delay_days"] = np.nan
    prep.validate_training_frame(df)


def test_features_target_separation_and_identifier_exclusion():
    df = toy_frame()
    X, y = prep.split_features_target(df)
    assert list(X.columns) == list(MODEL_FEATURES)
    for banned in ("participant_id", "dropped_out", "scheduled_visits"):
        assert banned not in X.columns
    assert y.name == "dropped_out" and set(y.unique()) <= {0, 1}
    # changing the identifier cannot change anything the model sees
    X2, _ = prep.split_features_target(df.assign(participant_id="X"))
    pd.testing.assert_frame_equal(X, X2)


def test_split_is_stratified_disjoint_and_70_15_15(small_df):
    s = prep.make_split(small_df, RetentionConfig())
    n = len(small_df)
    assert {k: len(v) for k, v in s.items()} == {"train": round(n * 0.7), "val": round(n * 0.15), "test": round(n * 0.15)}
    ids = [set(v["participant_id"]) for v in s.values()]
    assert not (ids[0] & ids[1]) and not (ids[0] & ids[2]) and not (ids[1] & ids[2])
    assert sum(len(i) for i in ids) == n
    for v in s.values():
        assert abs(v["dropped_out"].mean() - small_df["dropped_out"].mean()) < 0.02


def test_split_does_not_impute_and_is_deterministic(small_df):
    s1, s2 = prep.make_split(small_df, RetentionConfig()), prep.make_split(small_df, RetentionConfig())
    assert s1["test"].equals(s2["test"])
    assert sum(v["age"].isna().sum() for v in s1.values()) == small_df["age"].isna().sum()  # NaNs survive the split
    assert prep.make_split(small_df, RetentionConfig(seed=1))["test"]["participant_id"].tolist() != s1["test"]["participant_id"].tolist()


def test_bad_split_fractions_rejected():
    with pytest.raises(ValueError):
        prep.make_split(toy_frame(), RetentionConfig(train_frac=0.5))


def test_imputer_and_scaler_fit_on_training_rows_only():
    from sklearn.linear_model import LogisticRegression
    train, other = toy_frame(150, 1), toy_frame(150, 2)
    train["age"], other["age"] = 40.0, 70.0                # very different medians
    train.loc[:5, "age"] = np.nan
    pipe = prep.build_pipeline(LogisticRegression())
    X_tr, y_tr = prep.split_features_target(train)
    pipe.fit(X_tr, y_tr)
    pipe.transform if False else None
    num = pipe.named_steps["prep"].named_transformers_["num"]
    assert num.named_steps["impute"].statistics_[0] == 40.0          # age is the first numeric feature
    before = num.named_steps["impute"].statistics_.copy(), num.named_steps["scale"].mean_.copy()
    pipe.predict_proba(prep.split_features_target(other)[0])         # scoring other data must not refit anything
    assert np.array_equal(before[0], num.named_steps["impute"].statistics_) and np.array_equal(before[1], num.named_steps["scale"].mean_)


def test_missing_values_imputed_and_unknown_site_tolerated():
    from sklearn.linear_model import LogisticRegression
    df = toy_frame()
    df.loc[:10, ["age", "reimbursement_delay_days"]] = np.nan
    X, y = prep.split_features_target(df)
    pipe = prep.build_pipeline(LogisticRegression()).fit(X, y)
    Z = pipe.named_steps["prep"].transform(X)
    assert not Z.isna().any().any()
    novel = X.iloc[[0]].assign(site_id="SITE-NEW", age=np.nan)
    z = pipe.named_steps["prep"].transform(novel)
    assert z[[c for c in z.columns if c.startswith("site_id_")]].sum().sum() == 0   # unknown site -> all zeros
    assert 0 <= pipe.predict_proba(novel)[0, 1] <= 1


def test_feature_names_preserved():
    from sklearn.linear_model import LogisticRegression
    X, y = prep.split_features_target(toy_frame())
    names = prep.transformed_feature_names(prep.build_pipeline(LogisticRegression()).fit(X, y))
    assert {"age", "distance_km", "daily_wage_worker", "site_id_SITE-A"} <= set(names)
    assert not any("participant" in n for n in names)


def test_frame_from_features_orders_columns_and_nans_none():
    f = prep.frame_from_features({**{c: 1 for c in MODEL_FEATURES}, "age": None})
    assert list(f.columns) == list(MODEL_FEATURES) and np.isnan(f.loc[0, "age"])
