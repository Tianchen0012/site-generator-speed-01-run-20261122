// A faster drop-in for makefun-site 1.0.0, written from its README and its
// reference behaviour. run(input) returns exactly the output tree the
// reference build returns for the same input: every path it writes and that
// file's text, byte for byte.
//
// Where the reference walks the work several times over (splitting every
// source into lines, lexing Markdown into tokens, then rendering the tokens,
// then walking a template tree node by node), this module does each pass once:
// front matter is scanned in place, Markdown is rendered straight off the
// body string, and templates are parsed once and walked with plain object
// scopes (compiling them costs more per run than the walk saves on three
// cases). The semantics are the reference's own, kept line for line where
// they decide an answer; only the work is arranged differently.

// ------------------------------------------------------------------ text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped, nothing else. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Long dates repeat a lot (a few hundred distinct days); remember them. */
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let out = dateCache.get(date);
  if (out === undefined) {
    out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, out);
  }
  return out;
}

/**
 * The slug core over a string that needs no normalisation: A-Z lowered, every
 * run of characters other than a-z and 0-9 one "-", none at either end, cut to
 * SLUG_MAX characters with a "-" left at the cut dropped, "untitled" when
 * nothing is left. `ascii` says every code unit is below 128, so indexed
 * access and the character are the same thing.
 */
function slugAscii(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(code + 32);
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += plain[i];
    } else {
      gap = out.length > 0;
    }
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** The slug core over a string that may hold non-ASCII, one code point at a time. */
function slugWide(plain) {
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    let keep = '';
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** Titles and tag names repeat across a site; remember their slugs. */
const slugCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, then the slug rule. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const out = ascii ? slugAscii(text) : slugWide(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JavaScript whitespace, as \s matches it, checked inline: a call per
    // character would cost more than the test.
    if (
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    ) {
      inWord = false;
    } else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * A quoted string's value: "..." with \" and \\ its only escapes, or an
 * error; a bare string is the rest of the line, never opening on " or [.
 */
function stringValue(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevHyphen = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        if (c === 45) {
          if (prevHyphen) return { error: 'key "slug": not a slug' };
          prevHyphen = true;
        } else if (alnum) prevHyphen = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevHyphen) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The lines are walked
 * in place with indexOf, so the body is one slice, never a split and a join.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // The closing line: the next line that is exactly "---".
  let close = -1;
  let closeEnd = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const le = nl === -1 ? text.length : nl;
    if (le - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      close = pos;
      closeEnd = le;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = firstNl + 1;
  let lineNo = 2;
  while (p < close) {
    const nl = text.indexOf('\n', p);
    const le = nl === -1 || nl > close ? close : nl;
    const line = text.slice(p, le);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length && ((line[k] >= 'a' && line[k] <= 'z') || line[k] === '_')) k++;
      if (k === 0 || line[k] !== ':') return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = keyValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = nl === -1 || nl > close ? close : nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd + 1 <= text.length ? text.slice(closeEnd + 1) : '' };
}

// --------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isLangChar(c) {
  const code = c.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || c === '_' || c === '+' || c === '-';
}

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the rest of `line` from `from` is spaces and tabs only. */
function onlySpaces(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line[k])) k++;
  if (!onlySpaces(line, k)) return null;
  return line.slice(3, k);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaces(line, 3);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  if (depth === line.length) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let start = depth;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === start) return null;
  return { depth, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  return onlySpaces(line, 3);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let start = 0;
  let end = line.length;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * A bullet or ordered list's opening line: { ordered, start, text }, or null.
 * A bullet is "- " or "* "; an ordered list is 1 to 9 digits and ". ".
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let k = 0;
    while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
    if (k > 9 || k === line.length) return null;
    if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
    return { ordered: true, start: Number(line.slice(0, k)), text: line.slice(k + 2) };
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k === line.length) return false;
  return !/\s/.test(line[k]);
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is escaped exactly when the run of backslashes
 * right before it is odd: the scan from `from` pairs them up in order, so
 * the parity of that run is the whole story.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain stretches
 * are escaped in one call each instead of a character at a time, and the
 * closers of code spans, strong, emphasis and links are found with indexOf.
 */
function renderInline(s, env) {
  const parts = [];
  const n = s.length;
  let i = 0;
  let plain = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (plain < i) parts.push(escapeHtml(s.slice(plain, i)));
      parts.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
      i += 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (plain < i) parts.push(escapeHtml(s.slice(plain, i)));
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (plain < i) parts.push(escapeHtml(s.slice(plain, i)));
          parts.push('<strong>', renderInline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (plain < i) parts.push(escapeHtml(s.slice(plain, i)));
        parts.push('<em>', renderInline(s.slice(i + 1, j), env), '</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (plain < i) parts.push(escapeHtml(s.slice(plain, i)));
        parts.push('<a href="', escapeHtml(env.link(target)), '">', renderInline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        plain = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (plain < n) parts.push(escapeHtml(s.slice(plain)));
  return parts.join('');
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const nl = src.indexOf('\n', i);
    const le = nl === -1 ? n : nl;
    const line = src.slice(i, le);
    const after = nl === -1 ? n + 1 : nl + 1;
    if (isBlank(line)) {
      i = after;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i = after;
      while (i < n) {
        const nl2 = src.indexOf('\n', i);
        const le2 = nl2 === -1 ? n : nl2;
        const l2 = src.slice(i, le2);
        const after2 = nl2 === -1 ? n + 1 : nl2 + 1;
        if (isFenceClose(l2)) {
          i = after2;
          break;
        }
        body.push(l2);
        i = after2;
        if (nl2 === -1) {
          i = n + 1;
          break;
        }
      }
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const inner = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = renderInline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i = after;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i = after;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n) {
        const nl2 = src.indexOf('\n', i);
        const le2 = nl2 === -1 ? n : nl2;
        const l2 = src.slice(i, le2);
        if (l2.charCodeAt(0) !== 62) break;
        body.push(l2.replace(/^> ?/, ''));
        i = nl2 === -1 ? n + 1 : nl2 + 1;
      }
      const lines = body.map(trimLine).filter((l) => l !== '');
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${renderInline(lines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const list = listStart(line);
    if (list !== null) {
      const items = [[trimLine(list.text)]];
      i = after;
      while (i < n) {
        const nl2 = src.indexOf('\n', i);
        const le2 = nl2 === -1 ? n : nl2;
        const l2 = src.slice(i, le2);
        const after2 = nl2 === -1 ? n + 1 : nl2 + 1;
        const m = listStart(l2);
        if (m !== null && m.ordered === list.ordered) {
          items.push([trimLine(m.text)]);
          i = after2;
          if (nl2 === -1) break;
          continue;
        }
        if (isContinued(l2)) {
          items[items.length - 1].push(trimLine(l2));
          i = after2;
          if (nl2 === -1) break;
          continue;
        }
        break;
      }
      const tag = list.ordered ? 'ol' : 'ul';
      const open = list.ordered && list.start !== 1 ? `<ol start="${list.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((item) => `<li>${renderInline(item.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i = after;
    while (i < n) {
      const nl2 = src.indexOf('\n', i);
      const le2 = nl2 === -1 ? n : nl2;
      const l2 = src.slice(i, le2);
      if (endsParagraph(l2)) break;
      body.push(trimLine(l2));
      i = nl2 === -1 ? n + 1 : nl2 + 1;
    }
    const html = renderInline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// -------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src.slice(lineStart, open), 0) && onlySpaces(src.slice(end, lineEnd), 0);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The node tree walked in order, appending each node's text to `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n.text);
    else if (n.kind === 'var') out.push(escapeHtml(textOf(lookup(scope, n.path))));
    else if (n.kind === 'raw') out.push(textOf(lookup(scope, n.path)));
    else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          renderNodes(n.body, { vars: { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } }, parent: scope }, ctx, depth, out);
        }
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderTemplate(t, scope, ctx, depth + 1, out);
    }
  }
}

/** Parsed templates remembered by their source, across the cases of one run. */
const templateCache = new Map();

/** One parsed template: its tree of nodes. */
function prepareTemplate(name, src) {
  const hit = templateCache.get(src);
  if (hit !== undefined) return hit;
  const nodes = parseTemplate(name, src);
  templateCache.set(src, nodes);
  return nodes;
}

/** A parsed template rendered into `out`, walking its nodes. */
function renderTemplate(nodes, scope, ctx, depth, out) {
  renderNodes(nodes, scope, ctx, depth, out);
}

// ------------------------------------------------------------------- build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Every template parsed, in code-unit order of its name; one that does
  // not parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, prepareTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // The sources, in code-unit order of their paths, line ends made "\n";
  // a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Each source's front matter, in the checks' order; the first that fails
  // is the one reported. A draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files
  // they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, and equal dates by slug in code-unit
  // order; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count of posts, most first, then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Every page through its layout, the index pages and the tag pages
  // through theirs.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates };
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderTemplate(t, { vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
