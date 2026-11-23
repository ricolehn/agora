// How a person is called in messages and lists: the name of their account, else their first and last name.

/** [user]'s name, else first and last name; '' when they have neither (each caller says what stands in for it). */
const fullName = (user) => user?.name || `${user?.firstName || ''} ${user?.lastName || ''}`.trim();

module.exports = { fullName };
