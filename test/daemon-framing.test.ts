// The daemon socket's newline-delimited frame reassembly (bridge/src/daemon.ts framer) as a pure
// function — no port, no socket file, so this suite can run next to anything. It is fed the way a
// socket with setEncoding("utf8") feeds it: string chunks cut anywhere.
// The socket round trips (a real server-core bridge behind a real daemon) live in bridge.test.ts.
// Run with:  node test/daemon-framing.test.ts
import { PassThrough } from "node:stream";
import { check, report } from "./assert.ts";
import { framer } from "../bridge/src/daemon.ts";

/** Every frame `framer` hands out for these chunks, in order. */
function frames(chunks: readonly string[]): string[] {
  const out: string[] = [];
  const feed = framer((l) => out.push(l));
  for (const c of chunks) feed(c);
  return out;
}
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

console.log("framer — reassembly:");
check("one frame in one chunk", same(frames(['{"a":1}\n']), ['{"a":1}']));
check("one frame cut into many chunks comes out whole, once", same(frames(['{"a"', ":", "1", "}\n"]), ['{"a":1}']));
check("several frames in one chunk come out in order", same(frames(['{"a":1}\n{"b":2}\n{"c":3}\n']), ['{"a":1}', '{"b":2}', '{"c":3}']));
check("a chunk that ends one frame and starts the next", same(frames(['{"a":', '1}\n{"b"', ':2}\n']), ['{"a":1}', '{"b":2}']));
check("a newline that is the whole chunk ends the frame before it", same(frames(['{"a":1}', "\n", '{"b":2}', "\n"]), ['{"a":1}', '{"b":2}']));
check("a chunk that starts with the newline ends the frame before it", same(frames(['{"a":1}', '\n{"b":2}\n']), ['{"a":1}', '{"b":2}']));
check("an unfinished frame is held, not handed out", same(frames(['{"a":1}\n{"b":']), ['{"a":1}']));
check("empty lines are skipped (blank chunks too)", same(frames(["\n\n", "", '{"a":1}\n\n', "\n"]), ['{"a":1}']));
{
  // Every way to cut a few frames into two or three chunks gives the same frames.
  const wire = '{"x":"é😀"}\n\n{"y":[1,2]}\n{"z":null}\n';
  const want = ['{"x":"é😀"}', '{"y":[1,2]}', '{"z":null}'];
  let all = true;
  for (let i = 0; i <= wire.length; i++) {
    for (let j = i; j <= wire.length; j++) {
      if (!same(frames([wire.slice(0, i), wire.slice(i, j), wire.slice(j)]), want)) all = false;
    }
  }
  check("every two- and three-way cut of the same bytes gives the same frames", all);
}
{
  // A large frame in small reads: whole, and in linear time. Appending every read to one buffer and
  // searching it from the start is quadratic — about 4 s for this 4 MB frame in 1 KB reads (and tens
  // of seconds for a 100 MB export in 64 KB reads); the linear framer takes milliseconds.
  const body = '{"result":"' + "x".repeat(4 * 1024 * 1024) + '"}';
  const wire = body + "\n";
  const chunks: string[] = [];
  for (let i = 0; i < wire.length; i += 1024) chunks.push(wire.slice(i, i + 1024));
  const t = performance.now();
  const got = frames(chunks);
  const ms = performance.now() - t;
  check(`a 4 MB frame in 1 KB reads comes out whole (${ms.toFixed(0)} ms)`, got.length === 1 && got[0] === body);
  check("…and is split in well under a second", ms < 1000);
}
{
  // The socket's own decoder: setEncoding("utf8") holds back a character whose bytes are split across
  // reads, so the framer never sees half of one. A PassThrough uses the same Readable decoder a
  // net.Socket does.
  const s = new PassThrough();
  s.setEncoding("utf8");
  const got: string[] = [];
  s.on("data", framer((l) => got.push(l)));
  const bytes = Buffer.from('{"t":"ü€😀"}\n{"u":"ok"}\n', "utf8");
  for (let i = 0; i < bytes.length; i++) s.write(bytes.subarray(i, i + 1)); // one byte per read
  s.end();
  await new Promise((r) => s.once("end", r));
  check("multi-byte characters split across reads arrive intact (setEncoding decoder + framer)", same(got, ['{"t":"ü€😀"}', '{"u":"ok"}']));
}

report();
