const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeSvg, hasSvgExtension } = require('./svgValidation');

test('hasSvgExtension accepts svg extension in lowercase', () => {
  assert.equal(hasSvgExtension('church-logo.svg'), true);
});

test('hasSvgExtension accepts svg extension in uppercase', () => {
  assert.equal(hasSvgExtension('church-logo.SVG'), true);
});

test('hasSvgExtension accepts files without extension when browser omits it', () => {
  assert.equal(hasSvgExtension('church-logo'), true);
});

test('hasSvgExtension rejects non-svg extensions', () => {
  assert.equal(hasSvgExtension('church-logo.png'), false);
});

test('accepts normal svg content', () => {
  const svg = '<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  assert.equal(isSafeSvg(svg), true);
});

test('accepts attributes that include "on" in the middle of words', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-configuration="default"></g></svg>';
  assert.equal(isSafeSvg(svg), true);
});

test('rejects script tags', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects inline event handlers', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects uppercase inline event handlers', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" ONLOAD="alert(1)"></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects foreignObject elements', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject></foreignObject></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects javascript URLs', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects javascript URLs with encoded separators', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x09;script:alert(1)">x</a></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects javascript URLs with uppercase hex entities', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x0A;script:alert(1)">x</a></svg>';
  assert.equal(isSafeSvg(svg), false);
});

test('rejects javascript URLs with entities missing semicolon', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x09script:alert(1)">x</a></svg>';
  assert.equal(isSafeSvg(svg), false);
});
