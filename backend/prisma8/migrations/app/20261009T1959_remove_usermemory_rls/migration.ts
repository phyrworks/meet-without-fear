#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/dd3181deac81e028bbc91d79f32b15721f3f7c09dcc767228a78346da7964811/contract';
import startContract from '../../snapshots/dd3181deac81e028bbc91d79f32b15721f3f7c09dcc767228a78346da7964811/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract';
import endContract from '../../snapshots/ed356377780f4dc470e61d46329775bdc9993d3ca6b4f8652b84f80cf6d85e55/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.disableRowLevelSecurity({ schema: 'public', table: 'UserMemory' }),
      this.dropRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: 'user_memory_owner_delete_a2adeef6',
      }),
      this.dropRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: 'user_memory_owner_insert_127d690c',
      }),
      this.dropRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: 'user_memory_owner_read_0fda1f08',
      }),
      this.dropRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        policy: 'user_memory_owner_update_4db5a36c',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
