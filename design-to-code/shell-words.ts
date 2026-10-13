// shell-words.ts — the shell-command reading the plugin's hooks share: a command line as simple commands of
// words (verifier-guard.ts judges each one; verify-build.ts finds the plan-skeleton call that creates a plan).

/** One simple command: its words with quotes removed (a command substitution stays in its word as raw text). */
export type Words = string[];

// Splits a shell command line into simple commands at `;` `&` `|` newlines and parentheses, and lifts every
// `$( … )` / backtick substitution out as commands of its own (inside double quotes too) while its raw text
// stays in the word it sits in — `kill $(pgrep x)` is the command `kill $(pgrep x)` plus the command `pgrep x`.
// Not a full shell grammar: what it gets wrong errs towards reading text as a command, never towards hiding one.
export function simpleCommands(src: string): Words[] {
  const cmds: Words[] = [];
  interface Frame { words: Words; word: string; inWord: boolean; quote: string | null; closer: string; start: number }
  const stack: Frame[] = [];
  let words: Words = [], word = "", inWord = false, quote: string | null = null;
  const endWord = (): void => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endCmd = (): void => { endWord(); if (words.length) cmds.push(words); words = []; };
  const open = (closer: string, start: number): void => {
    stack.push({ words, word, inWord, quote, closer, start });
    words = []; word = ""; inWord = false; quote = null;
  };
  const close = (end: number): void => {
    endCmd();
    const f = stack.pop();
    if (!f) return;
    ({ words, word, quote } = f);
    word += src.slice(f.start, end + 1); inWord = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    const top = stack[stack.length - 1];
    if (c === "`") { if (top?.closer === "`") close(i); else open("`", i); continue; }
    if (c === "$" && src.charAt(i + 1) === "(") { open(")", i); i++; continue; }
    if (quote === "\"") {
      if (c === "\"") quote = null;
      // inside double quotes a backslash escapes only $ ` " \ and a newline (bash); before any other character it stays, as in a quoted Windows path
      else if (c === "\\" && "$`\"\\\n".includes(src.charAt(i + 1)) && i + 1 < src.length) word += src.charAt(++i);
      else word += c;
      continue;
    }
    if (c === ")" && top?.closer === ")") { close(i); continue; }
    if (c === "'" || c === "\"") { quote = c; inWord = true; continue; }
    if (c === "\\") { if (i + 1 < src.length && src.charAt(i + 1) !== "\n") { word += src.charAt(i + 1); inWord = true; } i++; continue; }
    if (c === "#" && !inWord) { while (i + 1 < src.length && src.charAt(i + 1) !== "\n") i++; continue; }
    if (";&|\n()".includes(c)) { endCmd(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; inWord = true;
  }
  while (stack.length) close(src.length - 1);
  endCmd();
  return cmds;
}

// The command line without its heredoc bodies: a body is data fed to a command — most often the text of a file
// being written — so it is not read as commands (a script fed to `sh <<EOF` this way goes unread).
export function dropHeredocBodies(cmd: string): string {
  const kept: string[] = [];
  let delim: string | null = null;
  for (const line of cmd.split("\n")) {
    if (delim !== null) { if (line.trim() === delim) delim = null; continue; }
    kept.push(line);
    const h = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (h && h[2]) delim = h[2];
  }
  return kept.join("\n");
}
