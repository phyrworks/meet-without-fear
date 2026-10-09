#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/557229df553e8d9f5238930b7220a54709af28ff020d9dbfdb9060a528ab4325/contract';
import endContract from '../../snapshots/557229df553e8d9f5238930b7220a54709af28ff020d9dbfdb9060a528ab4325/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract';
import startContract from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.enableRowLevelSecurity({ schema: 'public', table: 'UserMemory' }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: {
          naming: { kind: 'wire', prefix: 'user_memory_owner_delete', hash: 'a2adeef6' },
          tableName: 'UserMemory',
          namespaceId: 'public',
          operation: 'delete',
          roles: ['mwf_app'],
          using: `"userId" = current_setting('app.current_user_id', true)`,
          permissive: true,
        },
      }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: {
          naming: { kind: 'wire', prefix: 'user_memory_owner_insert', hash: '127d690c' },
          tableName: 'UserMemory',
          namespaceId: 'public',
          operation: 'insert',
          roles: ['mwf_app'],
          withCheck: `"userId" = current_setting('app.current_user_id', true)`,
          permissive: true,
        },
      }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: {
          naming: { kind: 'wire', prefix: 'user_memory_owner_select', hash: '0fda1f08' },
          tableName: 'UserMemory',
          namespaceId: 'public',
          operation: 'select',
          roles: ['mwf_app'],
          using: `"userId" = current_setting('app.current_user_id', true)`,
          permissive: true,
        },
      }),
      this.createRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: {
          naming: { kind: 'wire', prefix: 'user_memory_owner_update', hash: '4db5a36c' },
          tableName: 'UserMemory',
          namespaceId: 'public',
          operation: 'update',
          roles: ['mwf_app'],
          using: `"userId" = current_setting('app.current_user_id', true)`,
          withCheck: `"userId" = current_setting('app.current_user_id', true)`,
          permissive: true,
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
