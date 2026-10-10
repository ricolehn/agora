// Features that are finished but switched off for now. One installation turns a feature on with its environment
// variable (e.g. AGORA_FEATURE_POLLS=1 in the Docker template), everyone gets it by changing the default here.
// A restart applies the change. Switched-off features keep their data: routes and UI are only not reachable.
const flag = (name, fallback) => {
  const value = String(process.env[name] ?? '').trim();
  return value ? /^(1|true|on|yes)$/i.test(value) : fallback;
};

module.exports = {
  // Anonymous polls: off while the community discusses whether it wants them
  polls: flag('AGORA_FEATURE_POLLS', false)
};
