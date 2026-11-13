// Where a table or field is stored right now. Normally under its own name; while an upgrade builds the new structure,
// a new table whose name an old table still holds is built under another name (and the new link field of users, while
// the old groups field still exists) - the stores read and write through these names, the upgrade sets them.
const DEFAULTS = { usersGroupsField: 'groups' };
const building = new Map();
let names = { ...DEFAULTS };

/** The name the table [name] is stored under now. */
const table = (name) => building.get(name) || name;

/** The field of users that holds the links to the groups. */
const usersGroupsField = () => names.usersGroupsField;

/** While an upgrade builds: [tables] maps final table names to the names they are built under; [fields] other names. */
function useBuildingNames(tables = {}, fields = {}) {
  building.clear();
  for (const [name, stored] of Object.entries(tables)) building.set(name, stored);
  names = { ...DEFAULTS, ...fields };
}

/** Back to the final names (after the switch, or after an attempt that failed). */
function useFinalNames() {
  building.clear();
  names = { ...DEFAULTS };
}

module.exports = { table, usersGroupsField, useBuildingNames, useFinalNames };
