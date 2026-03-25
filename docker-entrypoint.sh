#!/bin/bash
set -e

PGDATA="/var/lib/postgresql/data"
PGUSER="coconutfree"
PGPASS="coconutfree"
PGDB="coconutfree"

# Ensure postgres owns the data directory (volumes mount as root)
chown -R postgres:postgres "$PGDATA"

# Initialize the database cluster if it doesn't exist
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL data directory..."
  su postgres -c "initdb -D $PGDATA"

  # Write a clean pg_hba.conf:
  #   local (socket) — peer auth so `su postgres -c psql` works for admin
  #   host (TCP)     — scram-sha-256 so the app can connect with a password
  cat > "$PGDATA/pg_hba.conf" <<'HBA'
local   all   all                 peer
host    all   all   127.0.0.1/32  scram-sha-256
host    all   all   ::1/128       scram-sha-256
HBA
  chown postgres:postgres "$PGDATA/pg_hba.conf"
fi

# Start PostgreSQL in the background
echo "Starting PostgreSQL..."
su postgres -c "pg_ctl -D $PGDATA -l $PGDATA/postgresql.log start"

# Wait for PostgreSQL to be ready
until su postgres -c "pg_isready" > /dev/null 2>&1; do
  sleep 0.2
done

# Create user and database if they don't exist
su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE $PGUSER WITH LOGIN PASSWORD '$PGPASS'\""
su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='$PGDB'\"" | grep -q 1 \
  || su postgres -c "createdb -O $PGUSER $PGDB"

echo "PostgreSQL ready."

# Run the app (or whatever command was passed)
exec "$@"
