// The rules of the database structure (backend/db/schema/): a new table or field that breaks them fails here, and so
// does a docs/DATABASE.md that no longer matches the code (regenerate it: node backend/db/docs.js).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BACKEND_DIR } = require('./helpers');

const schema = require(path.join(BACKEND_DIR, 'db', 'schema'));
const { databaseMap, OUTPUT } = require(path.join(BACKEND_DIR, 'db', 'docs'));

// What a table of an area is called
const PREFIXES = { accounts: ['user_'], finance: ['finance_'], events: ['event_'], community: ['community_'], mentoring: ['mentoring_'], media: ['media_'], system: ['system_'] };
const MAIN_TABLES = ['events'];

describe('the database structure', () => {
  const collections = schema.allCollections();
  const names = new Set([...collections.map((spec) => spec.name), 'users']);

  test('tables are named <area>_<things> in snake_case and say what they are', () => {
    for (const spec of collections) {
      assert.match(spec.name, /^[a-z]+(_[a-z]+)*$/, spec.name);
      assert.ok(MAIN_TABLES.includes(spec.name) || PREFIXES[spec.area].some((prefix) => spec.name.startsWith(prefix)), `${spec.name} belongs to ${spec.area}`);
      assert.ok(spec.description && spec.description.length > 10, `${spec.name} has a description`);
    }
  });

  test('fields are camelCase and every one has a help text', () => {
    for (const spec of [...collections, { name: 'users', fields: schema.USERS_FIELDS }]) {
      for (const field of spec.fields) {
        assert.match(field.name, /^[a-z][a-zA-Z0-9]*$/, `${spec.name}.${field.name}`);
        assert.ok(typeof field.help === 'string' && field.help.length > 3, `${spec.name}.${field.name} has a help text`);
      }
    }
  });

  test('money is whole cents in a field ending in Cents', () => {
    for (const spec of collections) {
      for (const field of spec.fields) {
        if (field.type === 'number' && /amount|fee|total|price|balance/i.test(field.name)) assert.match(field.name, /Cents$/, `${spec.name}.${field.name}`);
        if (field.type === 'number' && /Cents$/.test(field.name)) assert.equal(field.onlyInt, true, `${spec.name}.${field.name} is a whole number`);
      }
    }
  });

  test('every table has created and updated; links point to tables that exist', () => {
    for (const spec of collections) {
      const fieldNames = spec.fields.map((field) => field.name);
      assert.ok(fieldNames.includes('created') && fieldNames.includes('updated'), `${spec.name} has created and updated`);
      for (const field of spec.fields.filter((candidate) => candidate.type === 'relation')) {
        assert.ok(names.has(field.target), `${spec.name}.${field.name} links to ${field.target}`);
      }
    }
  });

  test('the tables can be created in an order where every link has its target', () => {
    const order = schema.creationOrder().map((spec) => spec.name);
    assert.equal(order.length, collections.length);
    for (const spec of collections) {
      for (const field of spec.fields.filter((candidate) => candidate.type === 'relation' && candidate.target !== 'users' && candidate.target !== spec.name)) {
        assert.ok(order.indexOf(field.target) < order.indexOf(spec.name), `${field.target} before ${spec.name}`);
      }
    }
  });

  test('docs/DATABASE.md matches the code', () => {
    assert.equal(fs.readFileSync(OUTPUT, 'utf8'), databaseMap(), 'docs/DATABASE.md is out of date: run node backend/db/docs.js');
  });
});
