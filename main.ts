// mend: a CLI that applies AI-written edits to a tree of text files.
//
// The patch comes in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls) and is applied all at once or not at all:
// every edit runs against the tree the earlier edits left, a failed edit
// changes nothing, and when any edit fails no file is written at all.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A whole-run failure: exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: reported, and the edit changes nothing. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own break, its lines, whether it ends with a break. */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as "old\0new" pairs, for the R lines of the output. */
  readonly moves = new Set<string>();

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

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  move(oldP: string, newP: string, v: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, v);
    this.moves.add(`${oldP}\0${newP}`);
  }

  snapshot(): { now: Map<string, string | null>; moves: Set<string> } {
    return { now: new Map(this.now), moves: new Set(this.moves) };
  }

  restore(s: { now: Map<string, string | null>; moves: Set<string> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves.clear();
    for (const m of s.moves) this.moves.add(m);
  }
}

type Edit = (tree: Tree) => void;

/** The strict flag, read by the matchers. */
let strict = false;

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      const crlf = f.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.set(p, joinFile(f));
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

// ---- Section 5: matching lines ----

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line as a tier reads it: exact, trailing spaces/tabs off, or both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every position at or after `from` where O occurs in the file at this tier. */
function tierOccurrences(O: string[], file: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(O[j]!, tier) !== tierKey(file[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(O: string[], file: string[], from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = tierOccurrences(O, file, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `ctx` >= 0 is a context line, the index of its line in O; -1 is an added line. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines N writes over the match at `at`: context lines are the file's own, added lines re-indented at tier 2. */
function buildReplacement(O: string[], N: NewLine[], file: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const f = leadingWs(file[at] ?? '');
  const p = leadingWs(O[0] ?? '');
  for (const n of N) {
    if (n.ctx >= 0) {
      out.push(file[at + n.ctx]!);
      continue;
    }
    let t = n.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** O and N of a hunk or chunk body, and whether a `\` line follows its last context or `+` line. */
function bodyLines(body: string[]): { O: string[]; N: NewLine[]; noEol: boolean } {
  const O: string[] = [];
  const N: NewLine[] = [];
  let lastCtxOrAdd = -1;
  body.forEach((l, i) => {
    if (l.startsWith(' ')) {
      O.push(l.slice(1));
      N.push({ text: l.slice(1), ctx: O.length - 1 });
      lastCtxOrAdd = i;
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: -1 });
      lastCtxOrAdd = i;
    } else if (l === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
      lastCtxOrAdd = i;
    }
  });
  const noEol = lastCtxOrAdd >= 0 && body[lastCtxOrAdd + 1] !== undefined && body[lastCtxOrAdd + 1]!.startsWith('\\');
  return { O, N, noEol };
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path after `--- ` or `+++ `: up to the first tab, spaces off, a leading a/ or b/ off; null is /dev/null. */
function diffPath(rest: string): string | null {
  let p = rest.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Whether a `\` line follows the body's last `+` line, and whether it has one. */
function lastPlusNoEol(body: string[]): { hasPlus: boolean; noEol: boolean } {
  let idx = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.startsWith('+')) idx = i;
  if (idx < 0) return { hasPlus: false, noEol: false };
  const next = body[idx + 1];
  return { hasPlus: true, noEol: next !== undefined && next.startsWith('\\') };
}

/** Apply a section's hunks in order to a file's lines; `path` names the file for failures. */
function applyHunks(hunks: Hunk[], f: FileLines, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N, noEol } = bodyLines(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const rep = N.map((n) => n.text);
      f.lines.splice(at, 0, ...rep);
      if (rep.length > 0 && at === f.lines.length - rep.length) f.final = !noEol;
      d += N.length;
      continue;
    }
    const found = findTier(O, f.lines, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = buildReplacement(O, N, f.lines, best, found.tier);
    const runsToEnd = best + O.length === f.lines.length;
    f.lines.splice(best, O.length, ...rep);
    if (runsToEnd) f.final = !noEol;
    d += N.length - O.length;
  }
}

/** The old and new path a section names, from its ---/+++ pair, its rename lines, or its diff --git line. */
function resolveSection(s: UniSection): { oldP: string | null; newP: string | null } {
  const oldP = s.dashOld !== undefined ? s.dashOld : s.renOld !== undefined ? s.renOld : s.diffOld ?? null;
  const newP = s.dashNew !== undefined ? s.dashNew : s.renNew !== undefined ? s.renNew : s.diffNew ?? null;
  return { oldP, newP };
}

function unifiedSectionEdit(s: UniSection): Edit {
  const { oldP, newP } = resolveSection(s);
  return (tree) => {
    if (s.newFile || oldP === null) {
      // Creation: the file is the + lines of all its hunks, in order.
      const np = newP;
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
        const r = lastPlusNoEol(h.body);
        if (r.hasPlus) noEol = r.noEol;
      }
      tree.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (s.deletedFile || newP === null) {
      // Deletion: the hunks are not read.
      const op = oldP;
      if (op === null) return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.set(op, null);
      return;
    }
    if (oldP !== newP) {
      // Move: the hunks apply to the old file's lines, the result is written at the new path.
      const op = oldP!;
      const np = newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const f = splitFile(before);
      applyHunks(s.hunks, f, op);
      tree.move(op, np, joinFile(f));
      return;
    }
    // Change of the one path.
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    applyHunks(s.hunks, f, p);
    tree.set(p, joinFile(f));
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hasPair = false;
  const startSection = (diffOld: string | undefined, diffNew: string | undefined): UniSection => {
    const s: UniSection = {
      diffOld,
      diffNew,
      dashOld: undefined,
      dashNew: undefined,
      renOld: undefined,
      renNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    hasPair = false;
    return s;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(line.slice(4));
      const newP = diffPath(lines[i + 1]!.slice(4));
      if (cur !== null && inHeader && !hasPair) {
        cur.dashOld = oldP;
        cur.dashNew = newP;
        hasPair = true;
      } else {
        startSection(undefined, undefined);
        cur!.dashOld = oldP;
        cur!.dashNew = newP;
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader) cur.dashNew = diffPath(line.slice(4));
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('rename from ') && cur !== null && inHeader) {
      cur.renOld = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ') && cur !== null && inHeader) {
      cur.renNew = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode') && cur !== null && inHeader) {
      cur.newFile = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode') && cur !== null && inHeader) {
      cur.deletedFile = true;
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s));
}

/** Output rows for exit 0: one line per path whose state changed, byte order, R lines by their new path. */
function outputRows(tree: Tree): string[] {
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of tree.moves) {
    const [oldP, newP] = m.split('\0');
    if (tree.original(oldP!) !== null && tree.get(oldP!) === null && tree.original(newP!) === null && tree.get(newP!) !== null) {
      rows.push({ key: newP!, line: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP!);
      movedNew.add(newP!);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8'));
    return c !== 0 ? c : a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
  });
  return rows.map((r) => r.line);
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // Empty old lines: create the file with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildReplacement(
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      f.lines,
      at,
      found.tier,
    );
    f.lines.splice(at, oldLines.length, ...rep);
    tree.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | undefined;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, after the previous
    // block, that is not blank and does not start with three backticks.
    let path: string | undefined;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        sep = j;
        break;
      }
      if (l === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let k = sep + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, end)));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | undefined;
  lines: string[];
  chunks: V4aChunk[];
}

function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, raw: string[], rawStart: number, headerIdx: number): V4aSection {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    return { kind, path, moveTo: undefined, lines: fileLines, chunks: [] };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${rawStart + 1}`);
    return { kind, path, moveTo: undefined, lines: [], chunks: [] };
  }
  let moveTo: string | undefined;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = idx; k < raw.length; k++) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${rawStart + k + 1}`);
      cur.eof = true;
      cur = null;
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push(l);
    } else {
      throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headerIdx + 1}`);
  return { kind, path, moveTo, lines: [], chunks };
}

function v4aSectionEdit(s: V4aSection): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const found = findTier([c.anchor], f.lines, cursor);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.pos[0]! + 1;
      }
      const { O, N } = bodyLines(c.body);
      if (O.length === 0) {
        const at = c.eof ? f.lines.length : cursor;
        const rep = N.map((n) => n.text);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(O, f.lines, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      let at: number | null = null;
      if (c.eof) {
        for (const p of found.pos) {
          if (p + O.length === f.lines.length) {
            at = p;
            break;
          }
        }
        if (at === null) throw new Fail('no-match', s.path);
      } else {
        at = found.pos[0]!;
      }
      const rep = buildReplacement(O, N, f.lines, at, found.tier);
      f.lines.splice(at, O.length, ...rep);
      cursor = at + rep.length;
    }
    const out = joinFile(f);
    if (s.moveTo !== undefined) tree.move(s.path, s.moveTo, out);
    else tree.set(s.path, out);
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const isSectionStart = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(ADD)) {
      kind = 'add';
      path = line.slice(ADD.length).trim();
    } else if (line.startsWith(DEL)) {
      kind = 'delete';
      path = line.slice(DEL.length).trim();
    } else if (line.startsWith(UPD)) {
      kind = 'update';
      path = line.slice(UPD.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerIdx = i;
    i++;
    const rawStart = i;
    while (i < last && !isSectionStart(lines[i]!)) i++;
    const raw = lines.slice(rawStart, i);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aSectionEdit(parseV4aSection(kind, path, raw, rawStart, headerIdx)));
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  strict = false;
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
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = outputRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
