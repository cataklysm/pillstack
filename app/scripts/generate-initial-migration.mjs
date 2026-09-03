// Splits docs/schema.sql into individual statements and emits migration 001.
// Run again after editing the schema during design; once released, schema
// changes must be added as NEW migrations instead of editing this one.
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Strips a trailing `-- ...` comment, ignoring `--` inside a quoted literal.
 * Needed because several column comments themselves end in a semicolon, which
 * a naive split would mistake for the end of the statement.
 */
function withoutTrailingComment(line) {
  let insideStringLiteral = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "'") {
      insideStringLiteral = !insideStringLiteral;
      continue;
    }
    if (!insideStringLiteral && character === '-' && line[index + 1] === '-') {
      return line.slice(0, index).trim();
    }
  }

  return line.trim();
}

const source = readFileSync('docs/schema.sql', 'utf8');
const statements = [];
let buffer = [];
let insideTriggerBody = false;

for (const line of source.split(/\r?\n/)) {
  const code = withoutTrailingComment(line);
  if (buffer.length === 0 && code === '') continue;
  buffer.push(line);

  if (/^CREATE\s+TRIGGER/i.test(code)) insideTriggerBody = true;

  if (insideTriggerBody) {
    if (/^END;$/i.test(code)) {
      insideTriggerBody = false;
      statements.push(buffer.join('\n'));
      buffer = [];
    }
    continue;
  }

  if (code.endsWith(';')) {
    statements.push(buffer.join('\n'));
    buffer = [];
  }
}

if (buffer.length > 0) {
  throw new Error('unterminated statement at end of docs/schema.sql');
}

const escapeForTemplateLiteral = (statement) =>
  statement
    .split('\\')
    .join('\\\\')
    .split('`')
    .join('\\`')
    .split('${')
    .join('\\${');

const body = statements
  .map((statement) => '  `' + escapeForTemplateLiteral(statement) + '`')
  .join(',\n\n');

const output = `import { sql, type Kysely } from 'kysely';

/**
 * Initial schema.
 *
 * Generated from docs/schema.sql by app/scripts/generate-initial-migration.mjs.
 * tests/migrations.test.ts asserts that a migrated database still matches that
 * document, so the two cannot drift.
 *
 * This migration is released: change the schema by adding a new migration,
 * never by editing this one.
 */
export const initialSchemaStatements: readonly string[] = [
${body},
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of initialSchemaStatements) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(): Promise<void> {
  throw new Error('the initial migration cannot be rolled back; restore a backup instead');
}
`;

writeFileSync('app/src/persistence/migrations/001_initial.ts', output, 'utf8');
console.log(`emitted ${statements.length} statements`);
