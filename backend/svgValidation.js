const path = require('path');

// Detects javascript: URLs, including common obfuscations via whitespace,
// numeric HTML entities (e.g. java&#x09;script) and percent-encoding (e.g. java%09script).
const javascriptUrlPattern = /java(?:\s|&#x?[0-9a-f]+;?|%[0-9a-f]{2})*script\s*:/i;

function hasSvgExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext === '' || ext === '.svg';
}

function isSafeSvg(svgContent) {
  if (typeof svgContent !== 'string') return false;

  // Remove UTF-8 BOM if present to keep SVG tag detection reliable.
  const content = svgContent.replace(/^\uFEFF/, '');
  const lower = content.toLowerCase();

  if (!lower.includes('<svg')) return false;
  if (lower.includes('<script')) return false;
  if (lower.includes('<foreignobject')) return false;
  if (javascriptUrlPattern.test(lower)) return false;
  if (/(?:^|[\s<])on[a-z]+\s*=/.test(lower)) return false;

  return true;
}

module.exports = { isSafeSvg, hasSvgExtension };
