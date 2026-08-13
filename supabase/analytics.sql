-- TrialMatch India — Analytics SQL Views
-- Run in Supabase SQL Editor after schema.sql

-- ══════════════════════════════════════════════════════════════
-- VIEW 1: Match rates by condition (diagnosis)
-- ══════════════════════════════════════════════════════════════
create or replace view v_match_rates_by_condition as
select
  p.org_id,
  -- Normalise diagnosis to title case, truncate long names
  initcap(split_part(p.diagnosis, ',', 1))                          as condition,
  count(distinct p.id)                                              as patient_count,
  count(distinct mr.id) filter (where mr.status = 'done')          as matched_count,
  -- Strong matches: count rows in jsonb array where matchStrength = STRONG
  coalesce(sum(
    (select count(*) from jsonb_array_elements(mr.matches) m
     where m->>'matchStrength' = 'STRONG')
  ), 0)::int                                                        as strong_match_total,
  -- Partial matches
  coalesce(sum(
    (select count(*) from jsonb_array_elements(mr.matches) m
     where m->>'matchStrength' = 'PARTIAL')
  ), 0)::int                                                        as partial_match_total,
  -- Average match score of top match per result
  round(avg(
    (select max((m->>'matchScore')::numeric)
     from jsonb_array_elements(mr.matches) m)
  )::numeric, 1)                                                    as avg_top_score,
  -- Average trials searched
  round(avg(mr.trials_searched)::numeric, 0)                       as avg_trials_searched,
  count(distinct mr.id) filter (
    where mr.status = 'done'
    and jsonb_array_length(coalesce(mr.matches, '[]'::jsonb)) > 0
  )                                                                 as results_with_matches
from patients p
left join match_results mr on mr.patient_id = p.id and mr.status = 'done'
where p.is_archived = false
group by p.org_id, initcap(split_part(p.diagnosis, ',', 1))
order by patient_count desc;


-- ══════════════════════════════════════════════════════════════
-- VIEW 2: Match jobs over time (weekly buckets)
-- ══════════════════════════════════════════════════════════════
create or replace view v_jobs_over_time as
select
  org_id,
  date_trunc('week', created_at)::date   as week_start,
  count(*)                               as jobs_run,
  sum(total_patients)                    as patients_processed,
  sum(done_patients)                     as patients_matched,
  count(*) filter (where status = 'completed') as jobs_completed,
  count(*) filter (where status = 'failed')    as jobs_failed,
  round(
    100.0 * count(*) filter (where status = 'completed') / nullif(count(*), 0),
    1
  )                                      as success_rate_pct
from match_jobs
group by org_id, date_trunc('week', created_at)::date
order by week_start;


-- ══════════════════════════════════════════════════════════════
-- VIEW 3: Recruitment funnel per org
-- ══════════════════════════════════════════════════════════════
create or replace view v_recruitment_funnel as
select
  mr.org_id,
  count(distinct p.id)                                              as total_patients,
  count(distinct mr.id) filter (where mr.status = 'done')          as patients_matched,
  -- Patients with at least one strong match
  count(distinct mr.patient_id) filter (
    where mr.status = 'done'
    and exists (
      select 1 from jsonb_array_elements(mr.matches) m
      where m->>'matchStrength' = 'STRONG'
    )
  )                                                                 as patients_with_strong_match,
  -- Patients with at least one partial match (no strong)
  count(distinct mr.patient_id) filter (
    where mr.status = 'done'
    and not exists (
      select 1 from jsonb_array_elements(mr.matches) m
      where m->>'matchStrength' = 'STRONG'
    )
    and exists (
      select 1 from jsonb_array_elements(mr.matches) m
      where m->>'matchStrength' = 'PARTIAL'
    )
  )                                                                 as patients_partial_only,
  -- Patients with no matches
  count(distinct mr.patient_id) filter (
    where mr.status = 'done'
    and jsonb_array_length(coalesce(mr.matches, '[]'::jsonb)) = 0
  )                                                                 as patients_no_match,
  -- Total strong matches across all results
  coalesce(sum(
    (select count(*) from jsonb_array_elements(mr.matches) m
     where m->>'matchStrength' = 'STRONG')
  ), 0)::int                                                        as total_strong_matches,
  coalesce(sum(
    (select count(*) from jsonb_array_elements(mr.matches) m
     where m->>'matchStrength' = 'PARTIAL')
  ), 0)::int                                                        as total_partial_matches,
  -- Database source breakdown
  coalesce(sum(mr.ctgov_count), 0)  as total_ctgov_trials,
  coalesce(sum(mr.ctri_count), 0)   as total_ctri_trials,
  -- Avg matches per patient
  round(
    avg(jsonb_array_length(coalesce(mr.matches, '[]'::jsonb)))::numeric, 1
  )                                                                 as avg_matches_per_patient
from patients p
left join match_results mr on mr.patient_id = p.id
where p.is_archived = false
group by mr.org_id;


-- ══════════════════════════════════════════════════════════════
-- VIEW 4: Top matched trials (most frequently matched NCT IDs)
-- ══════════════════════════════════════════════════════════════
create or replace view v_top_trials as
select
  mr.org_id,
  m_elem->>'nctId'          as nct_id,
  m_elem->>'title'          as trial_title,
  m_elem->>'source'         as source,
  m_elem->>'phase'          as phase,
  count(*)                  as times_matched,
  count(*) filter (where m_elem->>'matchStrength' = 'STRONG')  as strong_count,
  count(*) filter (where m_elem->>'matchStrength' = 'PARTIAL') as partial_count,
  round(avg((m_elem->>'matchScore')::numeric), 1)              as avg_score
from match_results mr,
     jsonb_array_elements(coalesce(mr.matches, '[]'::jsonb)) as m_elem
where mr.status = 'done'
  and m_elem->>'nctId' is not null
  and m_elem->>'nctId' != ''
group by mr.org_id, m_elem->>'nctId', m_elem->>'title', m_elem->>'source', m_elem->>'phase'
order by times_matched desc;


-- ══════════════════════════════════════════════════════════════
-- VIEW 5: Patient cohort by age + sex breakdown
-- ══════════════════════════════════════════════════════════════
create or replace view v_patient_demographics as
select
  org_id,
  sex,
  case
    when age < 18 then 'Under 18'
    when age between 18 and 30 then '18–30'
    when age between 31 and 45 then '31–45'
    when age between 46 and 60 then '46–60'
    when age between 61 and 75 then '61–75'
    else 'Over 75'
  end                      as age_group,
  count(*)                 as count
from patients
where is_archived = false
group by org_id, sex, age_group
order by org_id, age_group;


-- ══════════════════════════════════════════════════════════════
-- RPC: analytics summary for an org (single fast call)
-- ══════════════════════════════════════════════════════════════
create or replace function get_analytics_summary(p_org_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'total_patients',   (select count(*) from patients   where org_id = p_org_id and is_archived = false),
    'total_jobs',       (select count(*) from match_jobs where org_id = p_org_id),
    'total_results',    (select count(*) from match_results where org_id = p_org_id and status = 'done'),
    'total_strong',     (
      select coalesce(sum(
        jsonb_array_length(
          jsonb_path_query_array(matches, '$[*] ? (@.matchStrength == "STRONG")')
        )
      ), 0)
      from match_results where org_id = p_org_id and status = 'done'
    ),
    'avg_match_score',  (
      select round(avg((m->>'matchScore')::numeric), 1)
      from match_results mr, jsonb_array_elements(coalesce(mr.matches, '[]')) m
      where mr.org_id = p_org_id and mr.status = 'done'
        and m->>'matchScore' is not null
    ),
    'top_condition',    (
      select initcap(split_part(diagnosis, ',', 1))
      from patients
      where org_id = p_org_id and is_archived = false
      group by diagnosis
      order by count(*) desc
      limit 1
    ),
    'jobs_this_month',  (
      select count(*) from match_jobs
      where org_id = p_org_id
        and created_at >= date_trunc('month', now())
    ),
    'new_trials_found_last_rematch', (
      select coalesce(
        (metadata->>'new_trials_found')::int, 0
      )
      from audit_log
      where org_id = p_org_id
        and action = 'scheduled_rematch_complete'
      order by created_at desc
      limit 1
    )
  ) into result;
  return result;
end;
$$;
