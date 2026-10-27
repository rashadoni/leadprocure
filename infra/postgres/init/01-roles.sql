-- Runs once as the superuser (leadprocure_owner) when the DB is first created.
-- Creates the application role: NOSUPERUSER, NOBYPASSRLS, and NOT the table owner,
-- so PostgreSQL Row Level Security is actually enforced for the running API.
-- Migrations run as the owner (leadprocure_owner); the API connects as app_user.

CREATE ROLE app_user WITH LOGIN PASSWORD 'app_pass'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

GRANT CONNECT ON DATABASE leadprocure TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Tables/sequences are created later by the owner (leadprocure_owner) during migrations.
-- Default privileges grant DML on those future objects to app_user.
ALTER DEFAULT PRIVILEGES FOR ROLE leadprocure_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE leadprocure_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
