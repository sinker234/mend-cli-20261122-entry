// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds the lines an edit names at the first
// of three matching tiers, and changes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Files: a file's line break, its lines, and whether it ends with a break.
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function fileState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderState(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5).
// ---------------------------------------------------------------------------

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return trimWs(a) === trimWs(b);
}

/** Positions i (ascending) where O matches lines[i..], at one tier, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const positions = occurrences(lines, O, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function nearest(positions: number[], target: number): number {
  let best = positions[0]!;
  for (const p of positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  return best;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * The lines N writes when it replaces the O lines matched at `at`.
 * A context line is written as the file's own matched line, never the patch's.
 * At tier 2 every other line is re-indented (SPEC.md section 5).
 */
function buildReplacement(fileLines: string[], O: string[], N: NLine[], at: number, tier: number): string[] {
  const out: string[] = [];
  const F = leadWs(fileLines[at] ?? '');
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (const n of N) {
    if (n.ctx) {
      out.push(fileLines[at + n.oIdx]!);
      continue;
    }
    if (tier === 2 && n.text !== '' && !/^[ \t]+$/.test(n.text) && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

/** Turn hunk/chunk body lines into the old lines O and the new lines N. */
function bodyToON(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '') {
      O.push('');
      N.push({ text: '', ctx: true, oIdx: O.length - 1 });
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      const t = l.slice(1);
      O.push(t);
      N.push({ text: t, ctx: true, oIdx: O.length - 1 });
    } else if (c === '-') {
      O.push(l.slice(1));
    } else if (c === '+') {
      N.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4).
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  O: string[];
  N: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line (creation files) */
  plusNoEol: boolean;
  hasPlus: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunkBody(body: string[]): { O: string[]; N: NLine[]; noEol: boolean; plusNoEol: boolean; hasPlus: boolean } {
  const { O, N } = bodyToON(body);
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith('\\')) continue;
    if (l === '' || l[0] === ' ') lastCtxPlus = i;
    else if (l[0] === '+') {
      lastCtxPlus = i;
      lastPlus = i;
    }
  }
  const follows = (idx: number): boolean => idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]!.startsWith('\\');
  return { O, N, noEol: follows(lastCtxPlus), plusNoEol: follows(lastPlus), hasPlus: lastPlus >= 0 };
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function isDiffGit(l: string): boolean {
  return l.startsWith('diff --git ') || l === 'diff --git';
}

function parseDiffGit(l: string, lineNo: number): { old: string; new: string } {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return { old: m[1]!, new: m[2]!.replace(/\s+$/, '') };
}

/** Path from a `--- ` / `+++ ` line: after the four characters, up to the first tab, trimmed; null for /dev/null. */
function pathFromMarker(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

/** Parse a section's header (lines before its first hunk). Returns the index it stopped at. */
function parseSectionHeader(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  let pairSeen = sec.pairOld !== undefined;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (isDiffGit(l)) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!pairSeen) {
          sec.pairOld = pathFromMarker(l);
          sec.pairNew = pathFromMarker(lines[i + 1]!);
          pairSeen = true;
          i += 2;
          continue;
        }
        return i;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      sec.renameOld = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameNew = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.isCreate = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** Parse a section's hunks. Returns the index it stopped at. */
function parseSectionHunks(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (!l.startsWith('@@')) return i;
    const m = HUNK_HEAD.exec(l);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const a = parseInt(m[1]!, 10);
    i++;
    const body: string[] = [];
    while (i < n) {
      const bl = lines[i]!;
      if (isDiffGit(bl)) break;
      if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (!isBodyLine(bl)) break;
      body.push(bl);
      i++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const parsed = parseHunkBody(body);
    sec.hunks.push({ a, O: parsed.O, N: parsed.N, noEol: parsed.noEol, plusNoEol: parsed.plusNoEol, hasPlus: parsed.hasPlus });
  }
  return i;
}

/** Apply a section's hunks to a file's text, in order. */
function applyHunks(beforeText: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const st = fileState(beforeText);
  let lines = st.lines;
  let final = st.final;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      const ins = h.N.map((x) => x.text);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (atEnd) final = !h.noEol;
      d += h.N.length;
      continue;
    }
    const found = findTier(lines, h.O, strict, 0);
    if (!found) throw new Fail('no-match', failPath);
    const at = nearest(found.positions, h.a - 1 + d);
    const rep = buildReplacement(lines, h.O, h.N, at, found.tier);
    const atEnd = at + h.O.length === lines.length;
    lines = [...lines.slice(0, at), ...rep, ...lines.slice(at + h.O.length)];
    if (atEnd) final = !h.noEol;
    d += h.N.length - h.O.length;
  }
  return renderState({ lines, br: st.br, final });
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = newPath === null || sec.isDelete;
  if (oldPath === null && newPath === null) return () => {};
  if (isCreate) {
    const newP = newPath!;
    const plusLines: string[] = [];
    let noEol = false;
    for (const h of sec.hunks) {
      for (const nl of h.N) if (!nl.ctx) plusLines.push(nl.text);
      if (h.hasPlus) noEol = h.plusNoEol;
    }
    const content = plusLines.length === 0 ? '' : plusLines.join('\n') + (noEol ? '' : '\n');
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.exists(newP)) throw new Fail('exists', newP);
      tree.now.set(newP, content);
    };
  }
  if (isDelete) {
    const oldP = oldPath!;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldPath !== newPath) {
    const oldP = oldPath!;
    const newP = newPath!;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.exists(newP)) throw new Fail('exists', newP);
      const result = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, result);
      tree.moves.push({ old: oldP, new: newP });
    };
  }
  const p = oldPath!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const result = applyHunks(before, sec.hunks, strict, p);
    tree.now.set(p, result);
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const g = parseDiffGit(l, i + 1);
      const sec: Section = { gitOld: g.old, gitNew: g.new, pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined, isCreate: false, isDelete: false, hunks: [] };
      i++;
      i = parseSectionHeader(lines, i, sec);
      i = parseSectionHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { gitOld: undefined, gitNew: undefined, pairOld: pathFromMarker(l), pairNew: pathFromMarker(lines[i + 1]!), renameOld: undefined, renameNew: undefined, isCreate: false, isDelete: false, hunks: [] };
      i += 2;
      i = parseSectionHeader(lines, i, sec);
      i = parseSectionHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      if (sections.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      // A hunk after a section whose hunks ended: prose between two hunks of
      // the same section is ignored (SPEC 6: outside bodies, lines that are
      // not part of a section header are ignored), so this hunk still belongs
      // to that section — keep parsing hunks into it instead of throwing.
      i = parseSectionHunks(lines, i, sections[sections.length - 1]!);
    } else if (l.startsWith('diff --git')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let windowStart = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= windowStart; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    windowStart = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = fileState(before);
    const found = findTier(st.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = buildReplacement(st.lines, oldLines, N, at, found.tier);
    const out = [...st.lines.slice(0, at), ...rep, ...st.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderState({ lines: out, br: st.br, final: st.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
  O: string[];
  N: NLine[];
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function isV4aEndPatch(l: string): boolean {
  return l.trim() === '*** End Patch' && l[0] !== ' ';
}

function isV4aEndOfFile(l: string): boolean {
  return l.trim() === '*** End of File' && l[0] !== ' ';
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const collected: string[] = [];
      const fromPlus: boolean[] = [];
      while (i < last) {
        const cl = lines[i]!;
        if (isV4aSectionStart(cl) || isV4aEndPatch(cl)) break;
        if (cl.startsWith('+')) {
          collected.push(cl.slice(1));
          fromPlus.push(true);
          i++;
          continue;
        }
        if (blank(cl)) {
          collected.push('');
          fromPlus.push(false);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1] === '' && !fromPlus[fromPlus.length - 1]) {
        collected.pop();
        fromPlus.pop();
      }
      edits.push(v4aAddEdit(path, collected));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const cl = lines[i]!;
        if (isV4aSectionStart(cl) || isV4aEndPatch(cl)) break;
        if (blank(cl)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let seenContent = false;
      // Blank lines seen before the first chunk: held, not dropped — per SPEC 8
      // they are empty context lines of the first chunk, flushed into its body
      // when real chunk content arrives. They belong to no chunk when what
      // follows shows that (*** Move to: as the section's first line, an @@
      // chunk whose body starts after its header, or the end of the section),
      // so they are discarded there instead.
      let pendingBlanks: string[] = [];
      while (i < last) {
        const cl = lines[i]!;
        if (isV4aSectionStart(cl) || isV4aEndPatch(cl)) break;
        if (!seenContent && cl.startsWith('*** Move to: ')) {
          moveTo = cl.slice('*** Move to: '.length).trim();
          pendingBlanks = [];
          seenContent = true;
          i++;
          continue;
        }
        if (cl.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (isV4aEndOfFile(cl)) {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          seenContent = true;
          i++;
          continue;
        }
        if (cl.startsWith('@@')) {
          const anchor = cl.slice(2).trim();
          pendingBlanks = [];
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [], O: [], N: [] };
          chunks.push(cur);
          seenContent = true;
          i++;
          continue;
        }
        if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+') || blank(cl)) {
          if (cur === null) {
            if (blank(cl) && chunks.length > 0) {
              i++;
              continue;
            }
            if (blank(cl)) {
              // Before the first chunk: an empty context line, not a skipped
              // line (SPEC 8). Hold it until the first chunk starts.
              pendingBlanks.push(cl);
              i++;
              continue;
            }
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [], O: [], N: [] };
            chunks.push(cur);
            // Leading blank lines are the first chunk's empty context lines.
            for (const b of pendingBlanks) cur.body.push(b);
            pendingBlanks = [];
          }
          cur.body.push(cl);
          seenContent = true;
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        // Blank lines at the end of a section (before the next section or
        // *** End Patch) are not part of it (SPEC 8); blanks before
        // *** End of File are chunk body lines (empty context lines) and stay.
        if (!lastChunk.eof) {
          while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
        }
      }
      for (const ch of chunks) {
        const parsed = bodyToON(ch.body);
        ch.O = parsed.O;
        ch.N = parsed.N;
      }
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, lines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.exists(path)) throw new Fail('exists', path);
    tree.now.set(path, lines.length === 0 ? '' : lines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const st = fileState(before);
    let lines = st.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (!found) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      if (ch.O.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const ins = ch.N.map((x) => x.text);
        lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
        cursor = pos + ins.length;
        continue;
      }
      const found = findTier(lines, ch.O, strict, cursor);
      if (!found) throw new Fail('no-match', path);
      let at = found.positions[0]!;
      if (ch.eof) {
        const ok = found.positions.filter((p) => p + ch.O.length === lines.length);
        if (ok.length === 0) throw new Fail('no-match', path);
        at = ok[0]!;
      }
      const rep = buildReplacement(lines, ch.O, ch.N, at, found.tier);
      lines = [...lines.slice(0, at), ...rep, ...lines.slice(at + ch.O.length)];
      cursor = at + rep.length;
    }
    const result = renderState({ lines, br: st.br, final: st.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

// ---------------------------------------------------------------------------
// Running it (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Rows: A/D/M per changed path, R for a move that qualifies (SPEC.md section 2), sorted by path (new path for R).
  const moveByNew = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.new) === null && tree.now.get(m.new) !== null) {
      moveByNew.set(m.new, m.old);
    }
  }
  const movedOld = new Set([...moveByNew.values()]);
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveByNew.has(p)) {
      rows.push({ key: p, line: `R ${moveByNew.get(p)} -> ${p}` });
      continue;
    }
    if (movedOld.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
