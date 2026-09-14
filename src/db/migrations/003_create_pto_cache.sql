CREATE TABLE pto_cache (
  employee_id   TEXT PRIMARY KEY,
  accrued       NUMERIC NOT NULL,
  used          NUMERIC NOT NULL,
  remaining     NUMERIC NOT NULL,
  as_of         DATE NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
