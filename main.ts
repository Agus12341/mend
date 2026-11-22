// main.ts is mend, the CLI SPEC.md specifies. It reads an edit an AI model wrote, in one of four formats (a unified
// diff, SEARCH/REPLACE blocks, a V4A patch, or JSON tool calls), and applies it to the tree of text files in the
// working directory: every file is changed or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

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
  /** Moves (old, new) recorded by the move edits that ran, for the `R` output lines. */
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, and whether its text ends with one. */
interface Model {
  lines: string[];
  br: string;
  final: boolean;
}

function toModel(text: string): Model {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const lines = text.split(br);
  if (fin) lines.pop();
  return { lines, br, final: fin };
}

function fromModel(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// Section 5: matching old lines at three tiers.

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Occurrences of O in lines at the first tier with at least one, or null. Occurrences may overlap. */
function findOcc(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t += 1) {
    const at: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (!tierEq(lines[i + j]!, o[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a replacement: a context line (also in O, at index oi) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oi: number;
}

/** The lines that replace the matched ones: context lines are the file's own, tier 2 re-indents the rest. */
function buildLines(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = leadST(fileLines[at] ?? '');
  const p = leadST(o[0] ?? '');
  return n.map((e) => {
    if (e.ctx) return fileLines[at + e.oi]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

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

// Section 6: unified diffs.

interface UBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path a --- or +++ line names: after the four characters, up to a tab, spaces removed, a/ or b/ stripped. */
function headerPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

/** Does a `\` line follow this hunk's last context or `+` line? */
function hunkNoEol(h: UHunk): boolean {
  let last = -1;
  h.body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') last = i;
  });
  return last >= 0 && h.body[last + 1]?.kind === '\\';
}

function applyHunks(model: Model, hunks: UHunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: true, oi: o.length - 1 });
      } else if (b.kind === '-') o.push(b.text);
      else if (b.kind === '+') n.push({ text: b.text, ctx: false, oi: -1 });
    }
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > model.lines.length) pos = model.lines.length;
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...n.map((e) => e.text));
      if (atEnd) model.final = !hunkNoEol(h);
      d += n.length;
    } else {
      const occ = findOcc(model.lines, o, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = occ.at[0]!;
      for (const p of occ.at) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const built = buildLines(model.lines, best, o, n, occ.tier);
      const reachesEnd = best + o.length === model.lines.length;
      model.lines.splice(best, o.length, ...built);
      if (reachesEnd) model.final = !hunkNoEol(h);
      d += n.length - o.length;
    }
  }
}

/** A created file's model: the `+` lines of all the section's hunks, in order. */
function creationModel(hunks: UHunk[]): Model {
  const flat: UBodyLine[] = [];
  for (const h of hunks) flat.push(...h.body);
  const lines: string[] = [];
  let noEol = false;
  flat.forEach((b, i) => {
    if (b.kind === '+') {
      lines.push(b.text);
      noEol = flat[i + 1]?.kind === '\\';
    }
  });
  return { lines, br: '\n', final: !noEol };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const isCreate = sec.newFile || oldPath === null;
  const isDelete = sec.deletedFile || newPath === null;
  return (tree) => {
    // Every path the section names is checked for safety before anything else about it.
    if (typeof oldPath === 'string' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (typeof newPath === 'string' && newPath !== oldPath && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const p = newPath as string;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fromModel(creationModel(sec.hunks)));
      return;
    }
    if (isDelete) {
      const p = oldPath as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldPath as string;
    const nw = (newPath as string | undefined) ?? o;
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (nw !== o && tree.get(nw) !== null) throw new Fail('exists', nw);
    const model = toModel(before);
    applyHunks(model, sec.hunks, o, strict);
    if (nw !== o) {
      tree.now.set(nw, fromModel(model));
      tree.now.set(o, null);
      tree.moves.push([o, nw]);
    } else {
      tree.now.set(o, fromModel(model));
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let i = 0;
  const startsPair = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { newFile: false, deletedFile: false, hunks: [], gitOld: m[1]!, gitNew: m[2]! };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: UBodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (startsPair(i)) break;
        const c = bl[0];
        if (bl === '') body.push({ kind: ' ', text: '' });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') body.push({ kind: c as UBodyLine['kind'], text: bl.slice(1) });
        else break;
        i += 1;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      sec.hunks.push({ a: parseInt(m[1]!, 10), body });
      continue;
    }
    if (startsPair(i)) {
      const o = headerPath(line.slice(4));
      const n = headerPath(lines[i + 1]!.slice(4));
      if (sec !== null && sec.pairOld === undefined && sec.hunks.length === 0) {
        sec.pairOld = o;
        sec.pairNew = n;
      } else {
        sec = { newFile: false, deletedFile: false, hunks: [], pairOld: o, pairNew: n };
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('+++ ')) {
        if (sec.pairNew === undefined) sec.pairNew = headerPath(line.slice(4));
      } else if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fromModel({ lines: [...newLines], br: '\n', final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = toModel(before);
    const occ = findOcc(model.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.at.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
    const built = buildLines(model.lines, occ.at[0]!, oldLines, n, occ.tier);
    model.lines.splice(occ.at[0]!, oldLines.length, ...built);
    tree.now.set(path, fromModel(model));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// Section 9: JSON edits.

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
      const fin = before !== '' && before.endsWith(br);
      if (fin) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (fin ? br : ''));
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

// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  body: UBodyLine[];
  eof: boolean;
}

function applyChunks(model: Model, chunks: VChunk[], path: string, strict: boolean): void {
  const maxTier = strict ? 0 : 2;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (let t = 0; t <= maxTier && found < 0; t += 1) {
        for (let i = cursor; i < model.lines.length; i += 1) {
          if (tierEq(model.lines[i]!, ch.anchor, t)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const o: string[] = [];
    const n: NLine[] = [];
    for (const b of ch.body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: true, oi: o.length - 1 });
      } else if (b.kind === '-') o.push(b.text);
      else if (b.kind === '+') n.push({ text: b.text, ctx: false, oi: -1 });
    }
    if (o.length === 0) {
      const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
      model.lines.splice(pos, 0, ...n.map((e) => e.text));
      cursor = pos + n.length;
    } else {
      let tier = -1;
      let at = -1;
      for (let t = 0; t <= maxTier && at < 0; t += 1) {
        for (let i = cursor; i + o.length <= model.lines.length; i += 1) {
          if (ch.eof && i + o.length !== model.lines.length) continue;
          let ok = true;
          for (let j = 0; j < o.length; j += 1) {
            if (!tierEq(model.lines[i + j]!, o[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            tier = t;
            at = i;
            break;
          }
        }
      }
      if (at < 0) throw new Fail('no-match', path);
      const built = buildLines(model.lines, at, o, n, tier);
      model.lines.splice(at, o.length, ...built);
      cursor = at + built.length;
    }
  }
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    at: number;
    body: { line: string; at: number }[];
  }
  const raws: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const kind = line.startsWith('*** Add File:') ? 'add' : line.startsWith('*** Delete File:') ? 'delete' : line.startsWith('*** Update File:') ? 'update' : null;
    if (kind !== null) {
      const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
      cur = { kind, path: line.slice(prefix.length).trim(), at: i, body: [] };
      raws.push(cur);
    } else if (cur === null) {
      if (!blank(line)) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.body.push({ line, at: i });
    }
  }
  const edits: Edit[] = [];
  for (const raw of raws) {
    while (raw.body.length > 0 && blank(raw.body[raw.body.length - 1]!.line)) raw.body.pop();
    if (raw.kind === 'add') {
      const content: string[] = [];
      for (const b of raw.body) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new Exit2(`error: parse ${b.at + 1}`);
      }
      const p = raw.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fromModel({ lines: content, br: '\n', final: true }));
      });
    } else if (raw.kind === 'delete') {
      const bad = raw.body.find((b) => !blank(b.line));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.at + 1}`);
      const p = raw.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (raw.body.length > 0 && raw.body[0]!.line.startsWith('*** Move to:')) {
        moveTo = raw.body[0]!.line.slice('*** Move to:'.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (let k = start; k < raw.body.length; k += 1) {
        const b = raw.body[k]!;
        if (b.line.trimEnd() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${b.at + 1}`);
          chunk.eof = true;
          chunk = null;
        } else if (b.line.startsWith('@@')) {
          const anchor = b.line.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(chunk);
        } else if (b.line === '' || b.line[0] === ' ' || b.line[0] === '-' || b.line[0] === '+') {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.at + 1}`);
            chunk = { anchor: null, body: [], eof: false };
            chunks.push(chunk);
          }
          const c = b.line[0];
          if (b.line === '') chunk.body.push({ kind: ' ', text: '' });
          else chunk.body.push({ kind: c as UBodyLine['kind'], text: b.line.slice(1) });
        } else {
          throw new Exit2(`error: parse ${b.at + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${raw.at + 1}`);
      const p = raw.path;
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const model = toModel(before);
        applyChunks(model, chunks, p, strict);
        if (mv !== null) {
          tree.now.set(mv, fromModel(model));
          tree.now.set(p, null);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, fromModel(model));
        }
      });
    }
  }
  return edits;
}

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return unifiedEdits(lines, strict);
  if (kind === 'search-replace') return srEdits(lines, strict);
  return v4aEdits(lines, strict);
}

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
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== finalOf(p));
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (consumed.has(o) || consumed.has(nw)) continue;
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(nw) === null && finalOf(nw) !== null) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = finalOf(p);
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = finalOf(p);
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
