// The first setup: what it sends, checked, and the logo it may bring along.
const fs = require('fs');
const { churchLogoFile } = require('./context');
const { isSafeSvg } = require('./svgValidation');

function validateSetupPayload(body = {}) {
  const appName = typeof body.appName === 'string' ? body.appName.trim() : '';
  if (!appName) {
    throw new Error('Missing required configuration data.');
  }

  const adminUser = body.adminUser || {};
  const adminEmail = typeof adminUser.email === 'string' ? adminUser.email.trim() : '';
  const adminPassword = typeof adminUser.password === 'string' ? adminUser.password : '';
  const adminFirstName = typeof adminUser.firstName === 'string' ? adminUser.firstName.trim() : '';
  const adminLastName = typeof adminUser.lastName === 'string' ? adminUser.lastName.trim() : '';

  if (!adminEmail || !adminPassword || !adminFirstName || !adminLastName) {
    throw new Error('Missing required super-admin account details.');
  }
  if (adminPassword.length < 6) {
    throw new Error('Super-admin password must be at least 6 characters long.');
  }

  let smtp = null;
  if (body.smtp && typeof body.smtp === 'object') {
    smtp = {
      host: String(body.smtp.host || '').trim(),
      port: Number.isFinite(Number(body.smtp.port)) ? parseInt(body.smtp.port, 10) : 465,
      secure: body.smtp.secure === true,
      user: String(body.smtp.user || '').trim(),
      pass: String(body.smtp.pass || '')
    };
    if (!smtp.host) smtp = null;
  }

  const logoSvg = typeof body.logoSvg === 'string' ? body.logoSvg : null;
  const adminMemberSince = typeof adminUser.memberSince === 'string' && adminUser.memberSince.trim()
    ? adminUser.memberSince.trim()
    : new Date().toISOString().slice(0, 10);

  return {
    appName,
    smtp,
    logoSvg,
    adminUser: {
      email: adminEmail,
      password: adminPassword,
      firstName: adminFirstName,
      lastName: adminLastName,
      memberSince: adminMemberSince
    }
  };
}

async function saveOptionalLogo(logoSvg) {
  if (!logoSvg) {
    return;
  }
  if (!isSafeSvg(logoSvg)) {
    throw new Error('Invalid SVG file (Contains invalid tags or scripts)');
  }
  await fs.promises.writeFile(churchLogoFile, logoSvg, 'utf8');
}

module.exports = { validateSetupPayload, saveOptionalLogo };
