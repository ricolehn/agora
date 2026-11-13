const fs = require('fs');

function selectChurchLogoFilePath(uploadedLogoPath, bundledLogoPath) {
  return fs.existsSync(uploadedLogoPath) ? uploadedLogoPath : bundledLogoPath;
}

module.exports = {
  selectChurchLogoFilePath
};
