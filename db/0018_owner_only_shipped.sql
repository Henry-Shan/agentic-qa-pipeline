-- Only the QA owner may declare a report shipped.
--
-- The site hides the button from everyone else, but RLS on qa_reports is
-- `qa_is_tester()` for all operations — so hiding a button changes nothing about
-- what the API accepts. This is the part that refuses.
--
-- Ownership follows the name a person PICKED at login (qa_allowed_emails
-- .display_name), not an address. One person signs in from several accounts:
-- alice+admin@ and alice+member@ are both "owner", while
-- admin@example.com is nobody's login. An email allowlist gets this wrong, and
-- did — the owner saw no button at all.
--
-- Two callers are legitimate: the worker's ship loop (service role) when GitHub
-- reports the PR merged, and the owner pressing "Mark as shipped". A direct
-- connection (psql, a migration, the SQL editor) carries no PostgREST claims and
-- is trusted, otherwise this would lock the table against its own maintenance.

create or replace function qa_guard_shipped() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims json;
  jwt_role text;
  jwt_email text;
  viewer_name text;
  owner_name text := 'owner';  -- keep in step with NEXT_PUBLIC_QA_OWNER_NAME
begin
  if new.status = 'shipped' and coalesce(old.status, '') <> 'shipped' then
    claims := nullif(current_setting('request.jwt.claims', true), '')::json;
    if claims is null then
      return new; -- direct/trusted connection
    end if;
    jwt_role := coalesce(claims ->> 'role', '');
    if jwt_role = 'service_role' then
      return new; -- the worker's automatic ship-on-merge
    end if;
    jwt_email := lower(coalesce(claims ->> 'email', ''));
    select lower(display_name) into viewer_name
      from qa_allowed_emails where lower(email) = jwt_email;
    if viewer_name is distinct from owner_name then
      raise exception 'only % may mark a report shipped (you are signed in as %)',
        owner_name, coalesce(nullif(viewer_name, ''), jwt_email, 'unknown');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists qa_reports_guard_shipped on qa_reports;
create trigger qa_reports_guard_shipped
  before update on qa_reports
  for each row execute function qa_guard_shipped();
