import assert from 'node:assert';
import { PbacSqlTranslator, PbacSubject } from '../repositories/pbac-sql-translator.js';
import { DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, Kysely } from 'kysely';

console.log('Testing PbacSqlTranslator...');

// Setup a dummy db to compile queries
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

// Subject with specific Workshop W01, Category C01, Confidentiality 2
const subject1: PbacSubject = {
  subjectId: 'u-001',
  roles: ['OPERATOR'],
  workshops: ['W01'],
  materialCategories: ['C01'],
  maxConfidentialityLevel: 2,
};

// 1. Compile WHERE clause
const whereClause1 = PbacSqlTranslator.buildWhereClause(subject1);
const compiled1 = db.selectFrom('productionOrders').selectAll().where(whereClause1).compile();
console.log('Compiled SQL 1:', compiled1.sql);
console.log('Parameters 1:', compiled1.parameters);

assert(compiled1.sql.includes('"workshopCode" IN ($1)'), 'Should contain workshopCode in condition');
assert(compiled1.sql.includes('"categoryCode" IN ($2)'), 'Should contain categoryCode in condition');
assert(compiled1.sql.includes('"confidentialityLevel" <= $3'), 'Should contain confidentialityLevel condition');
assert.deepStrictEqual(compiled1.parameters, ['W01', 'C01', 2]);

// 2. Wildcard Subject
const subjectWildcard: PbacSubject = {
  subjectId: 'u-admin',
  roles: ['ADMIN'],
  workshops: ['*'],
  materialCategories: ['*'],
};

const whereClauseWildcard = PbacSqlTranslator.buildWhereClause(subjectWildcard);
const compiledWildcard = db.selectFrom('materials').selectAll().where(whereClauseWildcard).compile();
console.log('Compiled Wildcard SQL:', compiledWildcard.sql);
assert(compiledWildcard.sql.includes('1 = 1'), 'Wildcard permissions should compile to 1 = 1');

// 3. Empty list (Zero permission)
const subjectEmpty: PbacSubject = {
  subjectId: 'u-blocked',
  roles: ['GUEST'],
  workshops: [],
};
const whereClauseEmpty = PbacSqlTranslator.buildWhereClause(subjectEmpty);
const compiledEmpty = db.selectFrom('materials').selectAll().where(whereClauseEmpty).compile();
console.log('Compiled Empty SQL:', compiledEmpty.sql);
assert(compiledEmpty.sql.includes('1 = 0'), 'Empty permissions should compile to 1 = 0');

console.log('PbacSqlTranslator tests passed successfully!');
