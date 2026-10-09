#!/usr/bin/env -S node
import type {
  Contract as End,
  Contract as Start,
} from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract';
import endContract from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract.json' with { type: 'json' };
import startContract from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-postgres/migration';

// E6 experiment: undo 20261009T2006_app_schema_ping. The vector extension is
// NOT dropped: three live columns depend on it (it predates this experiment).
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'app.drop-schema-ping',
        invariantId: 'app:drop-schema-ping-v1',
        label: 'Drop function app.ping() and schema "app"',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          { description: 'drop function app.ping()', sql: 'DROP FUNCTION IF EXISTS app.ping()' },
          { description: 'drop schema app', sql: 'DROP SCHEMA IF EXISTS app' },
        ],
        postcheck: [
          {
            description: 'schema app is gone',
            sql: "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') AS result",
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
