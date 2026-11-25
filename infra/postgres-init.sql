CREATE ROLE jungle_app LOGIN PASSWORD 'jungle_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE jungle_test OWNER jungle_owner;
CREATE DATABASE jungle_migration_test OWNER jungle_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Table privileges are granted by the migration, after the schema exists.
