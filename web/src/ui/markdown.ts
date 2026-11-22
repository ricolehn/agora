// A light Markdown renderer for event descriptions and the AI's answers: paragraphs, headings, lists, quotes, tables,
// code, links and a little LaTeX math. Built with DOM nodes only (text always via textContent, never innerHTML).

const el = (tag: string, className = '', text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// --- Minimal LaTeX math ---
function balancedBraces(str: string, start: number): { content: string; endIndex: number } | null {
  if (str[start] !== '{') return null;
  for (let i = start, depth = 0; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}' && --depth === 0) return { content: str.slice(start + 1, i), endIndex: i };
  }
  return null;
}

function mathNodes(str: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const skipSpace = (pos: number) => {
    while (pos < str.length && /\s/.test(str[pos])) pos++;
    return pos;
  };
  const wrap = (tag: string, className: string, content: string) => {
    const wrapper = el(tag, className);
    wrapper.appendChild(mathNodes(content));
    return wrapper;
  };
  let i = 0;
  while (i < str.length) {
    const rest = str.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\\(?:frac|dfrac|tfrac)/))) {
      const num = balancedBraces(str, skipSpace(i + m[0].length));
      const den = num && balancedBraces(str, skipSpace(num.endIndex + 1));
      if (num && den) {
        const frac = el('span', 'md-math-frac');
        frac.append(wrap('span', 'md-math-num', num.content), wrap('span', 'md-math-den', den.content));
        frag.appendChild(frac);
        i = den.endIndex + 1;
        continue;
      }
    }
    if ((m = rest.match(/^\\sqrt(?:\[([^\]]+)\])?/))) {
      const radicand = balancedBraces(str, skipSpace(i + m[0].length));
      if (radicand) {
        const sqrt = el('span', 'md-math-sqrt');
        if (m[1]) sqrt.appendChild(el('sup', 'md-math-root-deg', m[1]));
        sqrt.append(el('span', 'md-math-sqrt-rad', '√'), wrap('span', 'md-math-sqrt-stem', radicand.content));
        frag.appendChild(sqrt);
        i = radicand.endIndex + 1;
        continue;
      }
    }
    if ((m = rest.match(/^\\(?:text|mathrm|mathbf|mathit|operatorname)/))) {
      const block = balancedBraces(str, skipSpace(i + m[0].length));
      if (block) {
        frag.appendChild(el('span', 'md-math-text', block.content));
        i = block.endIndex + 1;
        continue;
      }
    }
    if (str[i] === '^' || str[i] === '_') {
      const isSup = str[i++] === '^';
      const block = str[i] === '{' ? balancedBraces(str, i) : null;
      const content = block ? block.content : (str[i] ?? '');
      i = block ? block.endIndex + 1 : Math.min(i + 1, str.length);
      frag.appendChild(wrap(isSup ? 'sup' : 'sub', isSup ? 'md-math-sup' : 'md-math-sub', content));
      continue;
    }
    frag.appendChild(document.createTextNode(str[i++]));
  }
  return frag;
}

const MATH_SYMBOLS: Record<string, string> = {
  '\\pm': '±', '\\mp': '∓', '\\times': '×', '\\cdot': '·', '\\div': '÷',
  '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\neq': '≠', '\\ne': '≠',
  '\\approx': '≈', '\\equiv': '≡', '\\sim': '∼', '\\propto': '∝',
  '\\sum': '∑', '\\prod': '∏', '\\int': '∫', '\\iint': '∬', '\\iiint': '∭', '\\oint': '∮',
  '\\partial': '∂', '\\nabla': '∇', '\\infty': '∞',
  '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆', '\\cup': '∪', '\\cap': '∩', '\\emptyset': '∅',
  '\\forall': '∀', '\\exists': '∃', '\\nexists': '∄',
  '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒', '\\Leftarrow': '⇐', '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔',
  '\\dots': '…', '\\ldots': '…', '\\cdots': '⋯', '\\vdots': '⋮', '\\ddots': '⋱',
  '\\circ': '∘', '\\degree': '°', '\\deg': '°',
  '\\quad': ' ', '\\qquad': '  ', '\\,': ' ', '\\;': ' ', '\\:': ' ', '\\ ': ' ',
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε', '\\varepsilon': 'ε',
  '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
  '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\varpi': 'ϖ',
  '\\rho': 'ρ', '\\varrho': 'ϱ', '\\sigma': 'σ', '\\varsigma': 'ς', '\\tau': 'τ', '\\upsilon': 'υ',
  '\\phi': 'φ', '\\varphi': 'ϕ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
  '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ', '\\Xi': 'Ξ', '\\Pi': 'Π',
  '\\Sigma': 'Σ', '\\Upsilon': 'Υ', '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω'
};

function mathFragment(source: string): DocumentFragment {
  if (!source) return document.createDocumentFragment();
  let s = source
    .replace(/\\left([(\[{|.\\])/g, '$1')
    .replace(/\\right([)\]}|.\\])/g, '$1')
    .replace(/\\(sin|cos|tan|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|lim|min|max|sup|inf|det|gcd|deg)\b/g, '$1');
  for (const [cmd, sym] of Object.entries(MATH_SYMBOLS)) s = s.replace(new RegExp(cmd.replace(/\\/g, '\\\\') + '(?![a-zA-Z])', 'g'), sym);
  return mathNodes(s);
}

// --- Inline Markdown: math, code, bold/italic, strikethrough and links ---
const INLINE_MARKDOWN =
  /(\\\([\s\S]+?\\\)|(?<!\\)\$(?!\s)(?!\d+(?:[.,]\d+)?(?:\s|[.,;!?]|$))([^$\n]+?)(?<!\s)\$|`[^`]+`|\*\*\*(?:.+?)\*\*\*|\*\*(?:.+?)\*\*|__(?:.+?)__|\*(?:[^*]+)\*|_(?:[^_]+)_|~~(?:.+?)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;

function inlineNode(token: string, match: RegExpMatchArray): Node {
  const wrapped = (open: string, close = open) => token.startsWith(open) && token.endsWith(close) && token.length > open.length + close.length;
  const math = (content: string) => {
    const span = el('span', 'md-math-inline');
    span.appendChild(mathFragment(content));
    return span;
  };
  if (token.startsWith('\\(') && token.endsWith('\\)')) return math(token.slice(2, -2));
  if (wrapped('$')) return math(token.slice(1, -1));
  if (wrapped('`')) return el('code', '', token.slice(1, -1));
  if (wrapped('***')) {
    const strong = el('strong');
    strong.appendChild(el('em', '', token.slice(3, -3)));
    return strong;
  }
  if (wrapped('**') || wrapped('__')) return el('strong', '', token.slice(2, -2));
  if (wrapped('*') || wrapped('_')) return el('em', '', token.slice(1, -1));
  if (wrapped('~~')) return el('del', '', token.slice(2, -2));
  if (match[3] && match[4]) {
    const link = el('a', '', match[3]) as HTMLAnchorElement;
    Object.assign(link, { href: match[4], target: '_blank', rel: 'noopener noreferrer' });
    return link;
  }
  return document.createTextNode(token);
}

function appendInline(parent: Node, text: string) {
  if (!text) return;
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_MARKDOWN)) {
    if (match.index! > lastIndex) parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    parent.appendChild(inlineNode(match[0], match));
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) parent.appendChild(document.createTextNode(text.slice(lastIndex)));
}

function table(rows: string[]): HTMLElement {
  const wrapper = el('div', 'md-table');
  const tableEl = wrapper.appendChild(el('table'));
  const thead = el('thead');
  const tbody = el('tbody');
  let isHeader = true;
  for (const row of rows) {
    // Separator rows like |:---|:---| end the header
    if (/^[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/.test(row)) {
      isHeader = false;
      continue;
    }
    const cells = row.split('|');
    if (cells.length > 0 && cells[0].trim() === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
    const tr = (isHeader ? thead : tbody).appendChild(el('tr'));
    for (const cell of cells) appendInline(tr.appendChild(el(isHeader ? 'th' : 'td')), cell.trim());
    isHeader = false;
  }
  if (thead.childNodes.length > 0) tableEl.appendChild(thead);
  if (tbody.childNodes.length > 0) tableEl.appendChild(tbody);
  return wrapper;
}

function renderBlocks(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  const codeBlocks: Array<{ lang: string; code: string }> = [];
  const mathBlocks: string[] = [];
  const stashMath = (_: string, math: string) => `\x00MATH${mathBlocks.push(math.trim()) - 1}\x00`;
  const lines = text
    .replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang: string, code: string) => `\x00CODE${codeBlocks.push({ lang, code: code.replace(/\n$/, '') }) - 1}\x00`)
    .replace(/\$\$([\s\S]*?)(?:\$\$|$)/g, stashMath)
    .replace(/\\\[([\s\S]*?)(?:\\\]|$)/g, stashMath)
    .split('\n');

  let i = 0;
  // Consumes consecutive lines matching [pattern], returning them with [strip] removed
  const takeWhile = (pattern: RegExp, strip?: RegExp) => {
    const taken: string[] = [];
    while (i < lines.length && pattern.test(lines[i])) taken.push(strip ? lines[i++].replace(strip, '') : lines[i++]);
    return taken;
  };
  const list = (tag: string, items: string[]) => {
    const listEl = el(tag);
    for (const item of items) appendInline(listEl.appendChild(el('li')), item);
    return listEl;
  };
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\x00MATH(\d+)\x00$/))) {
      frag.appendChild(el('div', 'md-math-display')).appendChild(mathFragment(mathBlocks[Number(m[1])]));
      i++;
    } else if ((m = line.match(/^\x00CODE(\d+)\x00$/))) {
      const { lang, code } = codeBlocks[Number(m[1])];
      frag.appendChild(el('pre')).appendChild(el('code', lang ? `language-${lang}` : '', code));
      i++;
    } else if (/^[ \t]*>/.test(line)) {
      frag.appendChild(el('blockquote')).appendChild(renderBlocks(takeWhile(/^[ \t]*>/, /^[ \t]*>[ \t]?/).join('\n')));
    } else if (/^[ \t]*[-*+] /.test(line)) {
      frag.appendChild(list('ul', takeWhile(/^[ \t]*[-*+] /, /^[ \t]*[-*+] /)));
    } else if (/^[ \t]*\d+\. /.test(line)) {
      frag.appendChild(list('ol', takeWhile(/^[ \t]*\d+\. /, /^[ \t]*\d+\. /)));
    } else if ((m = line.match(/^(#{1,6}) (.+)/))) {
      appendInline(frag.appendChild(el(`h${m[1].length}`)), m[2]);
      i++;
    } else if (/^[ \t]*\|/.test(line)) {
      frag.appendChild(table(takeWhile(/^[ \t]*\|/).map(row => row.trim())));
    } else {
      if (/^(?:---+|\*\*\*+|___+)$/.test(line.trim())) frag.appendChild(el('hr'));
      else if (line.trim() === '') frag.appendChild(el('br'));
      else appendInline(frag.appendChild(el('p')), line);
      i++;
    }
  }
  return frag;
}

/** The nodes of [text] rendered as Markdown (for JSX: an array of DOM nodes). */
export const renderMarkdown = (text: string): Node[] => Array.from(renderBlocks(text).childNodes);
