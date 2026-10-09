#!/usr/bin/env -S node
import type {
  Contract as End,
  Contract as Start,
} from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract';
import endContract from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract.json' with { type: 'json' };
import startContract from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, createExtension, rawSql } from '@prisma/orm-postgres/migration';

// E6 experiment: hand-authored operations on an unchanged contract hash
// (scaffolded with `migration new --from <current hash>`).
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      createExtension('vector'),
      rawSql({
        id: 'app.schema',
        label: 'Create schema "app"',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [],
        execute: [{ description: 'create schema app', sql: 'CREATE SCHEMA IF NOT EXISTS app' }],
        postcheck: [
          {
            description: 'schema app exists',
            sql: "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') AS result",
          },
        ],
      }),
      rawSql({
        id: 'app.ping',
        invariantId: 'app:schema-ping-v1',
        label: 'Create function app.ping()',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'create SECURITY DEFINER function app.ping()',
            sql: 'CREATE OR REPLACE FUNCTION app.ping() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$',
          },
        ],
        postcheck: [
          {
            description: 'function app.ping() exists',
            sql: "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'ping') AS result",
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
