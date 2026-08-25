-- Only the QA owner may declare a report shipped.
--
-- The site hides the button from everyone else, but RLS on qa_reports is
-- `qa_is_tester()` for all operations — so hiding a button changes nothing about
-- what the API accepts. This is the part that refuses.
--
-- Two callers are legitimate:
--   * the worker's ship loop, which flips the row when GitHub reports the PR
--     merged. It connects with the service role.
--   * the owner, pressing "Mark as shipped".
-- Anything else raises.
--
-- A direct connection (psql, a migration, the SQL editor) has no PostgREST JWT
-- claims at all; those are trusted and allowed through, otherwise this would
-- lock the table against its own maintenance.

create or replace function qa_guard_shipped() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims json;
  jwt_role text;
  jwt_email text;
begin
  if new.status = 'shipped' and coalesce(old.status, '') <> 'shipped' then
    claims := nullif(current_setting('request.jwt.claims', true), '')::json;
    if claims is null then
      return new; -- direct/trusted connection
    end if;
    jwt_role := coalesce(claims ->> 'role', '');
    jwt_email := lower(coalesce(claims ->> 'email', ''));
    if jwt_role <> 'service_role' and jwt_email <> 'admin@example.com' then
      raise exception 'only the QA owner may mark a report shipped (got %)', coalesce(nullif(jwt_email, ''), jwt_role);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists qa_reports_guard_shipped on qa_reports;
create trigger qa_reports_guard_shipped
  before update on qa_reports
  for each row execute function qa_guard_shipped();
