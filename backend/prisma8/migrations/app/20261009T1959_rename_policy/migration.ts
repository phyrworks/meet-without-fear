#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/557229df553e8d9f5238930b7220a54709af28ff020d9dbfdb9060a528ab4325/contract';
import startContract from '../../snapshots/557229df553e8d9f5238930b7220a54709af28ff020d9dbfdb9060a528ab4325/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/dd3181deac81e028bbc91d79f32b15721f3f7c09dcc767228a78346da7964811/contract';
import endContract from '../../snapshots/dd3181deac81e028bbc91d79f32b15721f3f7c09dcc767228a78346da7964811/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.renameRlsPolicy({
        schema: 'public',
        table: 'UserMemory',
        from: 'user_memory_owner_select_0fda1f08',
        to: 'user_memory_owner_read_0fda1f08',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
