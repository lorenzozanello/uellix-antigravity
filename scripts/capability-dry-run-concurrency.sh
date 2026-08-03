#!/usr/bin/env bash
# scripts/capability-dry-run-concurrency.sh
#
# The assertions the single-session harness cannot make.
#
# CAP-01 L6, CAP-03 L3 and CAP-05 L4 all say "two concurrent calls, exactly one
# X". A DO block has one session, so those four cases were the ones the previous
# dry run checked by hand and the reaudit could not re-check.
#
# THE BARRIER. Two psql processes started with `&` do not reliably overlap: the
# first can finish before the second connects, and the assertion then passes
# without ever having tested contention. So both sessions are given the SAME
# wall-clock start instant and sleep until it, inside their transaction, after
# connecting. The overlap is engineered, not hoped for.
#
#   bash scripts/capability-dry-run-concurrency.sh <container>
set -euo pipefail
export MSYS_NO_PATHCONV=1

BOX="${1:?usage: capability-dry-run-concurrency.sh <container>}"
PSQL=(docker exec -i "$BOX" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=0)

rec() { docker exec "$BOX" psql -U supabase_admin -d postgres -q -tAc \
        "SELECT dryrun.rec('$1', $2, '$3')" >/dev/null; }
scalar() { docker exec "$BOX" psql -U supabase_admin -d postgres -tAc "$1"; }

# A shared instant, far enough ahead that both backends are connected and
# inside their transaction before either proceeds.
barrier() { scalar "SELECT (clock_timestamp() + interval '4 seconds')::text"; }

# One racing session. Everything before the sleep is setup; everything after is
# the contended statement.
race() {
  local at="$1" body="$2" tag="$3"
  { "${PSQL[@]}" <<SQL
BEGIN;
SELECT pg_sleep(GREATEST(0, EXTRACT(epoch FROM (TIMESTAMPTZ '$at' - clock_timestamp()))));
$body
COMMIT;
SQL
  } >"/tmp/race_$tag.out" 2>&1 || true
}

# ---------------------------------------------------------------------------
# CAP-01 L6 — two concurrent acceptances of the SAME invitation
# ---------------------------------------------------------------------------
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c "
  INSERT INTO public.users (id, email, is_super_admin)
  VALUES ('a1a1a1a1-0000-4000-8000-0000000000c1', 'race1@allowed.test', false)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.invitations (organization_id, email, role, status, token_hash, invited_by, expires_at)
  VALUES ('11111111-1111-4111-8111-111111111111', 'race1@allowed.test', 'analyst', 'pending',
          encode(sha256(convert_to(repeat('1', 64), 'UTF8')), 'hex'),
          'dddddddd-0000-4000-8000-000000000004', now() + interval '7 days')
  ON CONFLICT DO NOTHING;" >/dev/null

AT=$(barrier)
BODY="SELECT set_config('request.jwt.claim.sub','a1a1a1a1-0000-4000-8000-0000000000c1', true);
SELECT * FROM uellix_capability.accept_invitation(repeat('1', 64));"
race "$AT" "$BODY" c1a & race "$AT" "$BODY" c1b & wait

N=$(scalar "SELECT count(*) FROM public.organization_members WHERE user_id='a1a1a1a1-0000-4000-8000-0000000000c1' AND status='active'")
rec 'CAP01-L6' "$([ "$N" = "1" ] && echo true || echo false)" "memberships=$N"

# ---------------------------------------------------------------------------
# CAP-03 L3 — two concurrent begins for the same event id
# ---------------------------------------------------------------------------
AT=$(barrier)
BODY="SELECT uellix_capability.stripe_begin_event('evt_race', 'customer.subscription.updated');"
race "$AT" "$BODY" c3a & race "$AT" "$BODY" c3b & wait

CLAIMED=$(grep -ho 'claimed\|duplicate\|in_progress' /tmp/race_c3a.out /tmp/race_c3b.out | grep -c '^claimed$' || true)
ROWS=$(scalar "SELECT count(*) FROM public.stripe_webhook_events WHERE event_id='evt_race'")
rec 'CAP03-L3' "$([ "$CLAIMED" = "1" ] && [ "$ROWS" = "1" ] && echo true || echo false)" "claimed=$CLAIMED rows=$ROWS"

# ---------------------------------------------------------------------------
# CAP-05 L4 — two concurrent bootstraps with the SAME idempotency key
# ---------------------------------------------------------------------------
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c "
  INSERT INTO public.users (id, email, is_super_admin)
  VALUES ('a5a5a5a5-0000-4000-8000-0000000000c5', 'race5@allowed.test', false)
  ON CONFLICT DO NOTHING;" >/dev/null

AT=$(barrier)
BODY="SELECT set_config('request.jwt.claim.sub','a5a5a5a5-0000-4000-8000-0000000000c5', true);
SELECT * FROM uellix_capability.bootstrap_organization(
  '5a5a5a5a-0000-4000-8000-0000000000c5'::uuid, 'Race Co', 'race-co', NULL, 'ES', NULL);"
race "$AT" "$BODY" c5a & race "$AT" "$BODY" c5b & wait

ORGS=$(scalar "SELECT count(*) FROM public.organizations WHERE slug='race-co'")
MEMB=$(scalar "SELECT count(*) FROM public.organization_members WHERE user_id='a5a5a5a5-0000-4000-8000-0000000000c5' AND status='active'")
ATT=$(scalar "SELECT count(*) FROM public.capability_bootstrap_attempts WHERE user_id='a5a5a5a5-0000-4000-8000-0000000000c5'")
rec 'CAP05-L4' "$([ "$ORGS" = "1" ] && [ "$MEMB" = "1" ] && [ "$ATT" = "1" ] && echo true || echo false)" \
    "orgs=$ORGS memberships=$MEMB attempts=$ATT"

# ---------------------------------------------------------------------------
# CAP-05 L11 — a failure injected AFTER the organisation exists
# ---------------------------------------------------------------------------
# The whole call shares one transaction, so aborting it must remove the
# organisation, the membership, both audit rows AND the attempt row. The last
# one is the point: an attempt that survived would burn the idempotency key of
# a call that never happened.
docker exec "$BOX" psql -U supabase_admin -d postgres -q -c "
  INSERT INTO public.users (id, email, is_super_admin)
  VALUES ('a6a6a6a6-0000-4000-8000-0000000000c6', 'race6@allowed.test', false)
  ON CONFLICT DO NOTHING;" >/dev/null

"${PSQL[@]}" >/dev/null 2>&1 <<'SQL' || true
BEGIN;
SELECT set_config('request.jwt.claim.sub','a6a6a6a6-0000-4000-8000-0000000000c6', true);
SELECT * FROM uellix_capability.bootstrap_organization(
  '6a6a6a6a-0000-4000-8000-0000000000c6'::uuid, 'Doomed Co', 'doomed-co', NULL, 'ES', NULL);
ROLLBACK;
SQL

O=$(scalar "SELECT count(*) FROM public.organizations WHERE slug='doomed-co'")
A=$(scalar "SELECT count(*) FROM public.capability_bootstrap_attempts WHERE user_id='a6a6a6a6-0000-4000-8000-0000000000c6'")
M=$(scalar "SELECT count(*) FROM public.organization_members WHERE user_id='a6a6a6a6-0000-4000-8000-0000000000c6'")
rec 'CAP05-L11' "$([ "$O" = "0" ] && [ "$A" = "0" ] && [ "$M" = "0" ] && echo true || echo false)" \
    "orgs=$O attempts=$A memberships=$M"

# ---------------------------------------------------------------------------
# CAP-02 and CAP-04 under contention
# ---------------------------------------------------------------------------
# Neither document defines a concurrency case, but the brief asks for all five,
# and both have a real one: CAP-02's counter is an upsert on (report, day) and
# CAP-04's insert is an untargeted ON CONFLICT DO NOTHING. Two writers hitting
# either must not produce a duplicate or a deadlock.
AT=$(barrier)
BODY="SELECT uellix_capability.record_verification_hit('hash_totals');"
race "$AT" "$BODY" c2a & race "$AT" "$BODY" c2b & wait
ROWS=$(scalar "SELECT count(*) FROM public.capability_verification_hits")
HITS=$(scalar "SELECT COALESCE(max(hit_count),0) FROM public.capability_verification_hits")
rec 'CAP02-CONC' "$([ "$ROWS" = "1" ] && [ "$HITS" = "2" ] && echo true || echo false)" "rows=$ROWS count=$HITS"

AT=$(barrier)
BODY="SELECT uellix_capability.submit_lead('race@example.test','R',NULL,'pricing');"
race "$AT" "$BODY" c4a & race "$AT" "$BODY" c4b & wait
LEADS=$(scalar "SELECT count(*) FROM public.marketing_leads WHERE email='race@example.test'")
rec 'CAP04-CONC' "$([ "$LEADS" = "1" ] && echo true || echo false)" "rows=$LEADS"

echo "concurrency: recorded CAP01-L6, CAP02-CONC, CAP03-L3, CAP04-CONC, CAP05-L4, CAP05-L11"
