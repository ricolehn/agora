const path = require('path');

// The church logo is shown to every visitor, so an uploaded SVG may only draw: no scripts, event handlers,
// embedded documents or references to other files. Checked after decoding numeric entities, so that
// obfuscations like &#106;avascript: or java&#x09;script: are seen as what the browser makes of them.
const decodeEntities = (text) => text
  .replace(/&#x([0-9a-f]+);?/gi, (m, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
  .replace(/&#(\d+);?/g, (m, dec) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
  .replace(/&(colon|tab|newline);/gi, (m, name) => ({ colon: ':', tab: '\t', newline: '\n' })[name.toLowerCase()]);

// Elements that run code or load / embed other documents (also with a namespace prefix like <svg:script>)
const forbiddenElement = /<\s*(?:[a-z][\w.-]*:)?(?:script|foreignobject|iframe|frame|embed|object|applet|meta|base|link|handler|listener)\b/i;
// onload=, onbegin= … after whitespace, a slash, a quote or the tag start
const eventHandler = /[\s/"'<]on[a-z]+\s*=/i;
// javascript:, vbscript:, also split by whitespace / control characters or percent-encoding
const scriptUrl = /(?:java|vb)(?:[\s\u0000-\u001f]|%[0-9a-f]{2})*script(?:[\s\u0000-\u001f]|%[0-9a-f]{2})*:/i;
// data: URLs that are documents rather than pictures
const documentDataUrl = /data:\s*(?:text\/html|application\/(?:xhtml\+)?xml|image\/svg\+xml|text\/xml)/i;
// href / xlink:href / src may only point inside the file or carry an embedded raster picture
const externalReference = /\b(?:href|src)\s*=\s*["']\s*(?!#|data:image\/(?:png|jpe?g|gif|webp)[;,])[^"'\s]/i;
// CSS that loads something: @import, url(...) that is not a local #id or embedded picture
const externalCss = /@import|url\(\s*["']?\s*(?!#|data:image\/(?:png|jpe?g|gif|webp)[;,])[^)\s"']/i;
// DTDs with entity declarations (XXE / billion laughs) and XSLT stylesheets
const xmlTricks = /<!ENTITY|<!DOCTYPE[^>]*\[|<\?xml-stylesheet/i;

function hasSvgExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext === '' || ext === '.svg';
}

function isSafeSvg(svgContent) {
  if (typeof svgContent !== 'string') return false;

  // Remove UTF-8 BOM if present to keep SVG tag detection reliable.
  const content = decodeEntities(svgContent.replace(/^﻿/, ''));

  if (!/<\s*(?:[a-z][\w.-]*:)?svg\b/i.test(content)) return false;
  return ![forbiddenElement, eventHandler, scriptUrl, documentDataUrl, externalReference, externalCss, xmlTricks]
    .some((pattern) => pattern.test(content));
}

module.exports = { isSafeSvg, hasSvgExtension };
