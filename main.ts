// mend: one patch tool for every AI edit format.
//
// A patch arrives in one of four shapes (a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON tool calls) and mend applies it to the text
// files in the current directory: every file changes, or none does. SPEC.md
// is the contract this implements. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`, reading the patch from standard input
// when PATCH is absent or `-`.
//
// When MAKEFUN_ENV_URL is set, control passes to runner.ts (the tail of this
// file), which runs the grader's trial instead of the CLI itself.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to end the run at exit 2 with a single `error: ...` line. */
class ParseErr {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; the run reports it and carries on with the rest. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r off each, no empty tail piece. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, has no leading `/`,
 *  holds no `\`, and none of its `/`-separated pieces is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file's lines, its line break, and whether it ends with one. */
interface FileView {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function parseFile(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const lines = text.split(br);
  if (endsWithBreak) lines.pop();
  return { lines, br, endsWithBreak };
}

function renderFile(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.endsWithBreak ? v.br : '');
}

// Section 5: matching old lines at three tiers.

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function equalAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Occurrences of `want` in `lines`, at the first tier where any occur (strict: tier 0 only). */
function locate(lines: string[], want: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const at: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < want.length; j += 1) {
        if (!equalAtTier(lines[i + j]!, want[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: a context line (the file's own line) or a fresh line. */
interface NewLine {
  text: string;
  fromFile: boolean;
  oldIndex: number;
}

/** Render replacement lines: context lines come from the file itself; at tier 2
 *  the other lines are re-indented from the old lines' lead to the file's. */
function renderReplacement(fileLines: string[], at: number, oldFirst: string, news: NewLine[], tier: number): string[] {
  const fileLead = leadingWs(fileLines[at] ?? '');
  const oldLead = leadingWs(oldFirst);
  return news.map((e) => {
    if (e.fromFile) return fileLines[at + e.oldIndex]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(oldLead)) return fileLead + t.slice(oldLead.length);
    }
    return e.text;
  });
}

/** The tree as the edits leave it: changed paths in `pending` (null: deleted),
 *  everything else read from disk on demand. */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  /** Moves (old, new) the move edits recorded, for the `R` output lines. */
  readonly moves: [string, string][] = [];

  readOriginal(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  current(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.readOriginal(p);
  }
}

// Section 4: detecting the format.

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// Section 6: unified diffs.

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  start: number;
  body: HunkLine[];
}
interface DiffSection {
  gitOld?: string;
  gitNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ header names: after the four characters, up to a tab, spaces off, a/ or b/ off. */
function headerPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

/** Does a `\` line follow this hunk's last context or `+` line? */
function hunkEndsWithoutBreak(h: Hunk): boolean {
  let last = -1;
  h.body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') last = i;
  });
  return last >= 0 && h.body[last + 1]?.kind === '\\';
}

function applyHunks(view: FileView, hunks: Hunk[], path: string, strict: boolean): void {
  let drift = 0;
  for (const h of hunks) {
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        oldLines.push(b.text);
        newLines.push({ text: b.text, fromFile: true, oldIndex: oldLines.length - 1 });
      } else if (b.kind === '-') oldLines.push(b.text);
      else if (b.kind === '+') newLines.push({ text: b.text, fromFile: false, oldIndex: -1 });
    }
    if (oldLines.length === 0) {
      let pos = h.start + drift;
      if (pos < 0) pos = 0;
      if (pos > view.lines.length) pos = view.lines.length;
      const atEnd = pos === view.lines.length;
      view.lines.splice(pos, 0, ...newLines.map((e) => e.text));
      if (atEnd) view.endsWithBreak = !hunkEndsWithoutBreak(h);
      drift += newLines.length;
    } else {
      const found = locate(view.lines, oldLines, strict);
      if (found === null) throw new EditFail('no-match', path);
      const want = h.start - 1 + drift;
      let best = found.at[0]!;
      for (const p of found.at) {
        if (Math.abs(p - want) < Math.abs(best - want)) best = p;
      }
      const built = renderReplacement(view.lines, best, oldLines[0]!, newLines, found.tier);
      const reachesEnd = best + oldLines.length === view.lines.length;
      view.lines.splice(best, oldLines.length, ...built);
      if (reachesEnd) view.endsWithBreak = !hunkEndsWithoutBreak(h);
      drift += newLines.length - oldLines.length;
    }
  }
}

/** A created file's view: the `+` lines of all the section's hunks, in order. */
function creationView(hunks: Hunk[]): FileView {
  const flat: HunkLine[] = [];
  for (const h of hunks) flat.push(...h.body);
  const lines: string[] = [];
  let noBreak = false;
  flat.forEach((b, i) => {
    if (b.kind === '+') {
      lines.push(b.text);
      noBreak = flat[i + 1]?.kind === '\\';
    }
  });
  return { lines, br: '\n', endsWithBreak: !noBreak };
}

type EditFn = (tree: WorkTree) => void;

function sectionEdit(sec: DiffSection, strict: boolean): EditFn {
  const oldPath = sec.headOld !== undefined ? sec.headOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.headNew !== undefined ? sec.headNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const creating = sec.isNew || oldPath === null;
  const deleting = sec.isDeleted || newPath === null;
  return (tree) => {
    // Every path the section names is checked for safety before anything else about it.
    if (typeof oldPath === 'string' && !isSafePath(oldPath)) throw new EditFail('unsafe', oldPath);
    if (typeof newPath === 'string' && newPath !== oldPath && !isSafePath(newPath)) throw new EditFail('unsafe', newPath);
    if (creating) {
      const p = newPath as string;
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      tree.pending.set(p, renderFile(creationView(sec.hunks)));
      return;
    }
    if (deleting) {
      const p = oldPath as string;
      if (tree.current(p) === null) throw new EditFail('missing', p);
      tree.pending.set(p, null);
      return;
    }
    const from = oldPath as string;
    const to = (newPath as string | undefined) ?? from;
    const before = tree.current(from);
    if (before === null) throw new EditFail('missing', from);
    if (to !== from && tree.current(to) !== null) throw new EditFail('exists', to);
    const view = parseFile(before);
    applyHunks(view, sec.hunks, from, strict);
    if (to !== from) {
      tree.pending.set(to, renderFile(view));
      tree.pending.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.pending.set(from, renderFile(view));
    }
  };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: DiffSection[] = [];
  let sec: DiffSection | null = null;
  let i = 0;
  const pairStartsAt = (j: number): boolean =>
    lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, isNew: false, isDeleted: false, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseErr(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      const body: HunkLine[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (pairStartsAt(i)) break;
        const c = bl[0];
        if (bl === '') body.push({ kind: ' ', text: '' });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') body.push({ kind: c as HunkLine['kind'], text: bl.slice(1) });
        else break;
        i += 1;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      sec.hunks.push({ start: parseInt(m[1]!, 10), body });
      continue;
    }
    if (pairStartsAt(i)) {
      const o = headerPath(line.slice(4));
      const n = headerPath(lines[i + 1]!.slice(4));
      if (sec !== null && sec.headOld === undefined && sec.hunks.length === 0) {
        sec.headOld = o;
        sec.headNew = n;
      } else {
        sec = { headOld: o, headNew: n, isNew: false, isDeleted: false, hunks: [] };
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      throw new ParseErr(`error: parse ${i + 2}`);
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('+++ ')) {
        if (sec.headNew === undefined) sec.headNew = headerPath(line.slice(4));
      } else if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.isNew = true;
      else if (line.startsWith('deleted file mode')) sec.isDeleted = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditFail('exists', path);
      tree.pending.set(path, renderFile({ lines: [...newLines], br: '\n', endsWithBreak: true }));
      return;
    }
    const before = tree.current(path);
    if (before === null) throw new EditFail('missing', path);
    const view = parseFile(before);
    const found = locate(view.lines, oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const news: NewLine[] = newLines.map((t) => ({ text: t, fromFile: false, oldIndex: -1 }));
    const built = renderReplacement(view.lines, found.at[0]!, oldLines[0]!, news, found.tier);
    view.lines.splice(found.at[0]!, oldLines.length, ...built);
    tree.pending.set(path, renderFile(view));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
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
    if (eq < 0) throw new ParseErr(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(`error: parse ${searchIdx + 1}`);
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

/** The file an edit needs, or the failure for it not being there (safety first). */
function mustExist(tree: WorkTree, p: string): string {
  if (!isSafePath(p)) throw new EditFail('unsafe', p);
  const t = tree.current(p);
  if (t === null) throw new EditFail('missing', p);
  return t;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      tree.pending.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = mustExist(tree, p);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const fin = before !== '' && before.endsWith(br);
      if (fin) lines.pop();
      if (lineNo < 0 || lineNo > lines.length) throw new EditFail('no-match', p);
      lines.splice(lineNo, 0, ...add);
      tree.pending.set(p, lines.length === 0 ? '' : lines.join(br) + (fin ? br : ''));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseErr(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Section 8: V4A patches.

interface V4Chunk {
  anchor: string | null;
  body: HunkLine[];
  eof: boolean;
}

function applyV4Chunks(view: FileView, chunks: V4Chunk[], path: string, strict: boolean): void {
  const top = strict ? 0 : 2;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (let t = 0; t <= top && found < 0; t += 1) {
        for (let i = cursor; i < view.lines.length; i += 1) {
          if (equalAtTier(view.lines[i]!, ch.anchor, t)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) throw new EditFail('no-match', path);
      cursor = found + 1;
    }
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const b of ch.body) {
      if (b.kind === ' ') {
        oldLines.push(b.text);
        newLines.push({ text: b.text, fromFile: true, oldIndex: oldLines.length - 1 });
      } else if (b.kind === '-') oldLines.push(b.text);
      else if (b.kind === '+') newLines.push({ text: b.text, fromFile: false, oldIndex: -1 });
    }
    if (oldLines.length === 0) {
      const pos = ch.eof ? view.lines.length : Math.min(cursor, view.lines.length);
      view.lines.splice(pos, 0, ...newLines.map((e) => e.text));
      cursor = pos + newLines.length;
    } else {
      let tier = -1;
      let at = -1;
      for (let t = 0; t <= top && at < 0; t += 1) {
        for (let i = cursor; i + oldLines.length <= view.lines.length; i += 1) {
          if (ch.eof && i + oldLines.length !== view.lines.length) continue;
          let ok = true;
          for (let j = 0; j < oldLines.length; j += 1) {
            if (!equalAtTier(view.lines[i + j]!, oldLines[j]!, t)) {
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
      if (at < 0) throw new EditFail('no-match', path);
      const built = renderReplacement(view.lines, at, oldLines[0]!, newLines, tier);
      view.lines.splice(at, oldLines.length, ...built);
      cursor = at + built.length;
    }
  }
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(`error: parse ${lines.length + 1}`);
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
      if (!isBlank(line)) throw new ParseErr(`error: parse ${i + 1}`);
    } else {
      cur.body.push({ line, at: i });
    }
  }
  const edits: EditFn[] = [];
  for (const raw of raws) {
    while (raw.body.length > 0 && isBlank(raw.body[raw.body.length - 1]!.line)) raw.body.pop();
    if (raw.kind === 'add') {
      const content: string[] = [];
      for (const b of raw.body) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new ParseErr(`error: parse ${b.at + 1}`);
      }
      const p = raw.path;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (tree.current(p) !== null) throw new EditFail('exists', p);
        tree.pending.set(p, renderFile({ lines: content, br: '\n', endsWithBreak: true }));
      });
    } else if (raw.kind === 'delete') {
      const bad = raw.body.find((b) => !isBlank(b.line));
      if (bad !== undefined) throw new ParseErr(`error: parse ${bad.at + 1}`);
      const p = raw.path;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (tree.current(p) === null) throw new EditFail('missing', p);
        tree.pending.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (raw.body.length > 0 && raw.body[0]!.line.startsWith('*** Move to:')) {
        moveTo = raw.body[0]!.line.slice('*** Move to:'.length).trim();
        start = 1;
      }
      const chunks: V4Chunk[] = [];
      let chunk: V4Chunk | null = null;
      for (let k = start; k < raw.body.length; k += 1) {
        const b = raw.body[k]!;
        if (b.line.trimEnd() === '*** End of File') {
          if (chunk === null) throw new ParseErr(`error: parse ${b.at + 1}`);
          chunk.eof = true;
          chunk = null;
        } else if (b.line.startsWith('@@')) {
          const anchor = b.line.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(chunk);
        } else if (b.line === '' || b.line[0] === ' ' || b.line[0] === '-' || b.line[0] === '+') {
          if (chunk === null) {
            if (chunks.length > 0) throw new ParseErr(`error: parse ${b.at + 1}`);
            chunk = { anchor: null, body: [], eof: false };
            chunks.push(chunk);
          }
          const c = b.line[0];
          if (b.line === '') chunk.body.push({ kind: ' ', text: '' });
          else chunk.body.push({ kind: c as HunkLine['kind'], text: b.line.slice(1) });
        } else {
          throw new ParseErr(`error: parse ${b.at + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(`error: parse ${raw.at + 1}`);
      const p = raw.path;
      const mv = moveTo;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (mv !== null && !isSafePath(mv)) throw new EditFail('unsafe', mv);
        const before = tree.current(p);
        if (before === null) throw new EditFail('missing', p);
        if (mv !== null && tree.current(mv) !== null) throw new EditFail('exists', mv);
        const view = parseFile(before);
        applyV4Chunks(view, chunks, p, strict);
        if (mv !== null) {
          tree.pending.set(mv, renderFile(view));
          tree.pending.set(p, null);
          tree.moves.push([p, mv]);
        } else {
          tree.pending.set(p, renderFile(view));
        }
      });
    }
  }
  return edits;
}

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'json') return parseJson(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

// Section 10: order and atomicity, and section 1-2: the command line and its answers.

interface RunResult {
  code: number;
  out: string[];
}

function runCli(args: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
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
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new ParseErr('error: parse 1');
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.pending);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.pending.clear();
      for (const [k, v] of before) tree.pending.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalOf = (p: string): string | null => (tree.pending.has(p) ? tree.pending.get(p)! : tree.readOriginal(p));
  const changed = [...tree.pending.keys()].filter((p) => tree.readOriginal(p) !== finalOf(p));
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (consumed.has(o) || consumed.has(nw)) continue;
    if (tree.readOriginal(o) !== null && finalOf(o) === null && tree.readOriginal(nw) === null && finalOf(nw) !== null) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.readOriginal(p);
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
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
