// The values a fresh instance starts with.
const DEFAULT_SETTINGS = {
  vollverdiener: 50,
  geringverdiener: 25,
  keinverdiener: 10,
  pausiert: 0,
  reportStartDate: null
};

const DEFAULT_SYSTEM_STATE = {
  inviteCode: '',
  ownerUid: null,
  superAdminUid: null
};

module.exports = { DEFAULT_SETTINGS, DEFAULT_SYSTEM_STATE };
