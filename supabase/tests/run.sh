#!/usr/bin/env bash
# Test supabase/schema.sql on a local PostgreSQL that imitates Supabase.
# Needs psql access as a superuser (e.g. PGUSER=postgres). Creates and drops test databases.
set -euo pipefail
cd "$(dirname "$0")"
# Where psql throws away output: /dev/null, or NUL for the native Windows psql.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) NULLDEV=NUL ;; *) NULLDEV=/dev/null ;; esac
q() { psql -X -q -v ON_ERROR_STOP=1 -v devnull="$NULLDEV" "$@"; }
for db in tb_test tb_test_import; do
  q -d postgres -c "drop database if exists $db" -c "create database $db"
  q -d "$db" -f stub.sql
  q -d "$db" -f ../schema.sql
  q -d "$db" -f ../schema.sql # running it twice must be safe
done
q -d tb_test -f a_basics.sql
# Two devices bill at the same moment, 50 bills each, each bill its own transaction.
device() {
  { echo "set role authenticated;"
    echo "select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', false);"
    for _ in $(seq 1 50); do
      echo "select public.save_bill('{\"items\":[{\"menuId\":2,\"qty\":1,\"unitPaise\":12050}],\"orderType\":\"takeaway\",\"paymentMode\":\"cash\",\"discount\":{\"kind\":\"flat\",\"paise\":0},\"roundOffPaise\":50,\"totalPaise\":12100,\"cheesyLine\":\"\"}');"
    done
  } | q -d tb_test -o "$NULLDEV"
}
device 22222222-2222-2222-2222-222222222222 & A=$!
device 33333333-3333-3333-3333-333333333333 & B=$!
wait $A
wait $B
q -d tb_test -f b_after_parallel.sql
q -d tb_test -f d_sync.sql
q -d tb_test -f e_accounts_offline_retention.sql
q -d tb_test_import -f c_import.sql
for db in tb_test tb_test_import; do q -d postgres -c "drop database $db"; done
echo "ALL SCHEMA TESTS PASSED"
