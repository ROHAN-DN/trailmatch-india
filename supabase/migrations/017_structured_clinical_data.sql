-- TrialMatch India — Migration 017
-- Run AFTER 016_audit_log_columns_fix.sql
--
-- Structured Clinical Data Model — Phase 1 (additive)
--
-- Why: lib/matcher.ts currently sends the patient record to Claude as
-- prose (`Labs:HbA1c 9.2%, eGFR 68`) and asks the model to judge every
-- criterion — including purely arithmetic ones like "age >= 18" or
-- "eGFR >= 45 mL/min" that don't need a language model at all. That's
-- the same structural gap that let a fetch failure get silently answered
-- with a fabricated trial (see 014's comments) — there's no deterministic
-- floor underneath the LLM anywhere in this pipeline. Structured data is
-- the prerequisite for building one: you cannot evaluate `lab_value >=
-- threshold` in code if the lab value lives inside a free-text sentence.
--
-- What this migration does NOT do: touch the existing patients.labs /
-- .medications / .biomarkers / .comorbidities / .allergies text columns,
-- change how lib/matcher.ts builds its prompt, or build the rule
-- evaluator itself. This is schema only — additive, alongside the
-- existing free-text fields, per this project's own established migration
-- philosophy (013compare, 014, 015, 016 all add rather than replace).
-- The matcher, the intake form, and the deterministic evaluator are
-- separate, subsequent pieces of work that consume this schema once it
-- exists; building all of it in one migration would be exactly the "big
-- bang" this project has consistently avoided elsewhere.
--
-- Scope: five entities, chosen because they cover the actual recurring
-- criterion shapes seen in this project's own trial data (see the
-- Section 3 eligibility breakdowns in clinical_trial_match_report_template.pdf
-- and the example trials in lib/matcher.ts's own prompt): lab thresholds,
-- medication status/duration, biomarker results, comorbidity flags, and
-- allergy exclusions. Deliberately NOT included: imaging, procedures,
-- vital signs as separate tables — nothing in this codebase's actual
-- matching logic references them yet, and adding them now would be
-- speculative structure with no consumer, which is its own kind of
-- over-engineering.
--
-- diagnosis/stage remain top-level columns on patients (not split out) —
-- the product currently models one primary diagnosis per patient, and
-- there's no evidence of a need for a multi-diagnosis timeline yet.
-- prior_treatments is intentionally NOT a separate table: a "prior
-- treatment" and a "medication with status=discontinued" are the same
-- fact. Two overlapping free-text fields for one concept was itself a
-- modeling smell in the original design; patient_medications.status
-- covers both without duplicating the entity.

-- ═══════════════════════════════════════════════════════════════════
-- patient_labs
-- ═══════════════════════════════════════════════════════════════════
-- One row per lab result. A patient accumulates these over time — the
-- matcher should use the most recent value per test_name when evaluating
-- a criterion, which is a query concern, not a schema concern (no "is
-- current" flag needed here, unlike medications below where currency
-- is the fact itself, not derived from recency).

CREATE TABLE IF NOT EXISTS patient_labs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  test_name       text NOT NULL,            -- e.g. 'HbA1c', 'eGFR', 'Creatinine' — free text for now,
                                             -- test_code below is the path to a controlled vocabulary later
  test_code       text,                     -- LOINC code, nullable — lib/fhir.ts's LOINC_MAP already maps
                                             -- a subset of these; this column is where that mapping lands
                                             -- when a lab result is structured, instead of staying implicit
  value_numeric   numeric,                  -- for comparable results: 'eGFR >= 45' needs this, not a string
  value_text      text,                     -- for non-numeric results: 'Positive', 'Detected', a free-text
                                             -- qualifier — never populate both value_numeric and value_text
                                             -- for a quantitative test; use whichever fits the actual result
  unit            text,                     -- 'mL/min', '%', 'mg/dL' — required for value_numeric to mean anything
  reference_range text,                     -- lab-provided normal range, as reported — for display, not evaluation
  collected_date  date,
  source          text DEFAULT 'manual' CHECK (source IN ('manual','fhir','abdm','hms_import')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz DEFAULT now(),

  -- A test must report at least one kind of value.
  CONSTRAINT patient_labs_has_value CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL)
);

-- ═══════════════════════════════════════════════════════════════════
-- patient_medications
-- ═══════════════════════════════════════════════════════════════════
-- Covers both "current medications" and "prior treatments" from the old
-- free-text fields — status is the distinguishing fact, not two separate
-- entities. "On stable Metformin dose >=1500mg/day for >=3 months" and
-- "No prior GLP-1 agonist use" are both queries against this one table.

CREATE TABLE IF NOT EXISTS patient_medications (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  name            text NOT NULL,            -- 'Metformin' — generic name where known
  dose            text,                     -- '500mg' — kept as text; fully structuring dose+unit+route is
                                             -- a rabbit hole with no current consumer (see migration comment above)
  frequency       text,                     -- 'twice daily', 'once weekly'
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued','unknown')),
  start_date      date,
  end_date        date,                     -- null while status = 'active'
  source          text DEFAULT 'manual' CHECK (source IN ('manual','fhir','abdm','hms_import')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz DEFAULT now(),

  CONSTRAINT patient_medications_end_after_start
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- ═══════════════════════════════════════════════════════════════════
-- patient_biomarkers
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS patient_biomarkers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  marker          text NOT NULL,            -- 'EGFR', 'PD-L1', 'BRCA1'
  status          text NOT NULL DEFAULT 'unknown' CHECK (status IN ('positive','negative','unknown','not_tested')),
  value           text,                     -- '30%', 'Exon 19 deletion' — free text, the specific finding
  tested_date     date,
  source          text DEFAULT 'manual' CHECK (source IN ('manual','fhir','abdm','hms_import')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════
-- patient_comorbidities
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS patient_comorbidities (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  condition       text NOT NULL,            -- 'Hypertension', 'Dyslipidaemia'
  icd10_code      text,                     -- nullable — controlled-vocabulary path, same idea as test_code above
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','unknown')),
  diagnosed_date  date,
  source          text DEFAULT 'manual' CHECK (source IN ('manual','fhir','abdm','hms_import')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════
-- patient_allergies
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS patient_allergies (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  substance       text NOT NULL,            -- 'Sulfa drugs'
  reaction        text,                     -- 'Rash', 'Anaphylaxis' — nullable, often not recorded
  severity        text DEFAULT 'unknown' CHECK (severity IN ('mild','moderate','severe','unknown')),
  source          text DEFAULT 'manual' CHECK (source IN ('manual','fhir','abdm','hms_import')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════
-- Small, cheap, unrelated-but-related fix: patients.ecog_status already
-- has a matching closed-set TypeScript type (EcogStatus, in
-- lib/types/domain.ts) but the DB column has never had a CHECK enforcing
-- it, and the intake form renders it as a free-text <input>, not a
-- dropdown — so despite the type existing, nothing has ever enforced it.
-- Adding the constraint now; the intake form dropdown is a UI-layer
-- follow-up, not a schema one.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_ecog_status_check;
ALTER TABLE patients
  ADD CONSTRAINT patients_ecog_status_check
  CHECK (ecog_status IS NULL OR ecog_status IN ('ECOG 0','ECOG 1','ECOG 2','ECOG 3','ECOG 4','ECOG 5'));

-- ═══════════════════════════════════════════════════════════════════
-- Indexes — matching the query patterns a rule engine will actually run:
-- "give me this patient's labs/meds/biomarkers/comorbidities/allergies",
-- and "find the most recent value for test X on patient Y".
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_patient_labs_patient        ON patient_labs (patient_id, test_name, collected_date DESC);
CREATE INDEX IF NOT EXISTS idx_patient_labs_org             ON patient_labs (org_id);
CREATE INDEX IF NOT EXISTS idx_patient_medications_patient  ON patient_medications (patient_id, status);
CREATE INDEX IF NOT EXISTS idx_patient_medications_org      ON patient_medications (org_id);
CREATE INDEX IF NOT EXISTS idx_patient_biomarkers_patient   ON patient_biomarkers (patient_id, marker);
CREATE INDEX IF NOT EXISTS idx_patient_biomarkers_org       ON patient_biomarkers (org_id);
CREATE INDEX IF NOT EXISTS idx_patient_comorbidities_patient ON patient_comorbidities (patient_id, status);
CREATE INDEX IF NOT EXISTS idx_patient_comorbidities_org    ON patient_comorbidities (org_id);
CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient    ON patient_allergies (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_allergies_org        ON patient_allergies (org_id);

-- ═══════════════════════════════════════════════════════════════════
-- RLS — identical pattern to every other org-scoped child table in this
-- schema (patients, match_results, etc.): denormalized org_id, same
-- policy shape. No new pattern introduced.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE patient_labs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_medications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_biomarkers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_comorbidities ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_allergies     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation_patient_labs"          ON patient_labs          USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
CREATE POLICY "org_isolation_patient_medications"   ON patient_medications   USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
CREATE POLICY "org_isolation_patient_biomarkers"    ON patient_biomarkers    USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
CREATE POLICY "org_isolation_patient_comorbidities" ON patient_comorbidities USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
CREATE POLICY "org_isolation_patient_allergies"     ON patient_allergies     USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Sanity check — 5 new tables, all with RLS enabled, no exceptions.
SELECT t.table_name, pt.rowsecurity
FROM information_schema.tables t
JOIN pg_tables pt ON pt.tablename = t.table_name
WHERE t.table_name IN (
  'patient_labs','patient_medications','patient_biomarkers',
  'patient_comorbidities','patient_allergies'
)
ORDER BY t.table_name;
-- Expected: 5 rows, rowsecurity = true for all.
