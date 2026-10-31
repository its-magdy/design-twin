// GENERATED from src/*.ts by build.ts — do not edit by hand. Run `bun run build`.
"use strict";
(() => {
  // ../bridge/src/json-util.ts
  function isRecord(x) {
    return typeof x === "object" && x !== null && !Array.isArray(x);
  }
  function isUnknownArray(x) {
    return Array.isArray(x);
  }
  function ifDefined(key, v) {
    const o = {};
    if (v !== void 0) o[key] = v;
    return o;
  }

  // ../bridge/src/hex-color.ts
  var HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  var HEX_COLOR_HINT = "a hex colour like #1A2B3C (#rgb, #rgba, #rrggbb or #rrggbbaa)";
  function parseHexColor(value) {
    if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) return null;
    let h = value.slice(1);
    if (h.length <= 4) h = h.split("").map((c2) => c2 + c2).join("");
    const chan = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    const c = { r: chan(0), g: chan(2), b: chan(4) };
    if (h.length === 8) c.a = chan(6);
    return c;
  }
  function formatHex(c) {
    const to = (x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
    const a = Math.round(c.a * 255);
    return "#" + to(c.r) + to(c.g) + to(c.b) + (a < 255 ? to(a) : "");
  }

  // ../bridge/src/pages-layout.ts
  function safe(id) {
    return String(id).replace(/[^a-zA-Z0-9]/g, "_");
  }
  function screenStem(name, id) {
    return safe(name || "layer") + "__" + safe(id);
  }
  var shown = (c) => !!c && typeof c === "object" && !c.hidden;
  function firstByName(node, name) {
    if (!node || typeof node !== "object") return null;
    if (node.name === name) return node;
    for (const c of node.children || []) {
      const found = shown(c) ? firstByName(c, name) : null;
      if (found) return found;
    }
    return null;
  }
  var PLACEHOLDER_TEXT = /* @__PURE__ */ new Set(["text", "label"]);
  function firstText(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "TEXT" && typeof node.text === "string") {
      const t = node.text.trim();
      if (t && !PLACEHOLDER_TEXT.has(t.toLowerCase())) return node.text;
    }
    for (const c of node.children || []) {
      const found = shown(c) ? firstText(c) : null;
      if (found) return found;
    }
    return null;
  }
  function firstNamedText(node, name) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "TEXT" && node.name === name && typeof node.text === "string" && node.text.trim()) {
      return node.text;
    }
    for (const c of node.children || []) {
      const found = shown(c) ? firstNamedText(c, name) : null;
      if (found) return found;
    }
    return null;
  }
  function deriveTitle(root) {
    const slot = firstByName(root, "Page Title");
    if (slot) {
      const named = firstNamedText(slot, "Title");
      if (named) return named;
      const anyText = firstText(slot);
      if (anyText) return anyText;
    }
    const fallback = firstText(root);
    return fallback || void 0;
  }
  function collectTexts(root, limit) {
    const n = limit || 8;
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    (function walk(node, isRoot) {
      if (!node || typeof node !== "object" || node.hidden && !isRoot || out.length >= n) return;
      if (node.type === "TEXT" && typeof node.text === "string") {
        const t = node.text.trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
      for (const c of node.children || []) {
        if (out.length >= n) break;
        walk(c, false);
      }
    })(root, true);
    return out;
  }
  function buildPageLayout(layersDoc, sep) {
    const doc = layersDoc || {};
    const { layers, index, ...rest } = doc;
    const join = (...parts) => ["pages"].concat(parts).join(sep);
    const byPage = /* @__PURE__ */ new Map();
    const pages = [];
    const layerFiles = [];
    const usedDirs = /* @__PURE__ */ new Set();
    const uniqueDir = (name) => {
      const base = safe(name) || "page";
      if (!usedDirs.has(base)) {
        usedDirs.add(base);
        return base;
      }
      let i = 2;
      while (usedDirs.has(base + "_" + i)) i++;
      usedDirs.add(base + "_" + i);
      return base + "_" + i;
    };
    (layers || []).forEach((l, i) => {
      const pageName = l.page || "(no page)";
      const key = l.pageId || "name:" + pageName;
      let bucket = byPage.get(key);
      if (!bucket) {
        const dir = uniqueDir(pageName);
        bucket = { page: pageName, ...ifDefined("pageId", l.pageId), dir, index: join(dir, "index.json"), entries: [] };
        byPage.set(key, bucket);
        pages.push(bucket);
      }
      const base = screenStem(l.name, l.id) + ".json";
      const src = layersDoc && layersDoc.sourceFile ? { sourceFile: layersDoc.sourceFile } : {};
      const rowSrc = layersDoc && layersDoc.sourceFile && layersDoc.sourceFileKey ? { ...src, sourceFileKey: layersDoc.sourceFileKey } : src;
      layerFiles.push({
        path: join(bucket.dir, base),
        data: { name: l.name, id: l.id, ...ifDefined("page", l.page), ...ifDefined("pageId", l.pageId), ...src, tree: l.tree, ...ifDefined("reference", l.reference), ...ifDefined("devResources", l.devResources) }
      });
      const title = l.tree ? deriveTitle(l.tree) : void 0;
      const texts = l.tree ? collectTexts(l.tree) : void 0;
      bucket.entries.push(Object.assign({}, (index || [])[i], { title, texts, ...rowSrc, file: join(bucket.dir, base) }));
    });
    const pageDirs = pages.map((b) => ({ page: b.page, ...ifDefined("pageId", b.pageId), dir: b.dir, index: b.index, layers: b.entries.length }));
    const meta = Object.assign(rest, { pageDirs, layers: pages.flatMap((b) => b.entries) });
    const indexFiles = pages.map((b) => ({ path: b.index, data: { page: b.page, ...ifDefined("pageId", b.pageId), layers: b.entries } }));
    return { meta, layerFiles, indexFiles, rootIndex: join("index.json") };
  }

  // ../bridge/src/errmsg.ts
  var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);

  // ../bridge/src/svg-normalize.ts
  var NUM_RE = /-?\d+\.\d+(?:[eE][+-]?\d+)?/g;
  function normalizeSvgText(svg) {
    return svg.replace(NUM_RE, (m) => {
      const n = Number(m);
      if (!Number.isFinite(n)) return m;
      const fixed = n.toFixed(1);
      return fixed === "-0.0" ? "0.0" : fixed;
    });
  }

  // src/util.ts
  var exportedAt = () => (/* @__PURE__ */ new Date()).toISOString();
  function round(n) {
    return typeof n === "number" ? Math.round(n * 100) / 100 : n;
  }
  var lower = (s) => s.toLowerCase();
  var propName = (k) => {
    const hash = k.indexOf("#");
    return hash === -1 ? k : k.slice(0, hash);
  };
  var propType = (t) => t;
  var nonEmpty = (o) => Object.keys(o).length ? o : void 0;
  function putNonEmpty(o, key, v) {
    const kept = v && nonEmpty(v);
    if (kept) o[key] = kept;
  }
  var xy = (v) => ({ x: round(v.x), y: round(v.y) });
  function putXY(o, key, v) {
    if (v && typeof v === "object") o[key] = xy(v);
  }
  function easingCurve(ez) {
    const o = {};
    if (ez.easingFunctionCubicBezier) o.cubicBezier = ez.easingFunctionCubicBezier;
    if (ez.easingFunctionSpring) o.spring = ez.easingFunctionSpring;
    return o;
  }
  function asJson(v) {
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
    if (Array.isArray(v)) return v.map((x) => {
      const j = asJson(x);
      return j === void 0 ? null : j;
    });
    if (typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const j = asJson(x);
        if (j !== void 0) out[k] = j;
      }
      return out;
    }
    return void 0;
  }
  function isList(v) {
    return Array.isArray(v);
  }
  function numProp(node, key) {
    const v = node[key];
    return typeof v === "number" ? v : void 0;
  }
  function anyProp(node, key) {
    return node[key];
  }
  function rgbaToHex(c) {
    return formatHex({ r: c.r * 255, g: c.g * 255, b: c.b * 255, a: c.a == null ? 1 : c.a });
  }
  var solidHex = (p) => rgbaToHex({ r: p.color.r, g: p.color.g, b: p.color.b, ...ifDefined("a", p.opacity) });
  function solidFromFills(fills) {
    if (!fills || fills === figma.mixed || !Array.isArray(fills)) return void 0;
    const s = fills.find((f) => f.visible !== false && f.type === "SOLID");
    return s ? solidHex(s) : void 0;
  }
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B64_CHUNK = 16384;
  function toBase64(bytes) {
    const n = bytes.length;
    let out = "";
    let chunk = "";
    for (let i = 0; i < n; i += 3) {
      const t = (bytes[i] || 0) << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
      chunk += B64.charAt(t >> 18 & 63) + B64.charAt(t >> 12 & 63) + (i + 1 < n ? B64.charAt(t >> 6 & 63) : "=") + (i + 2 < n ? B64.charAt(t & 63) : "=");
      if (chunk.length >= B64_CHUNK) {
        out += chunk;
        chunk = "";
      }
    }
    return out + chunk;
  }

  // ../bridge/src/design-system-layout.ts
  var DIR = "design-system";
  var COMPONENTS_DIR = "components";
  var TOKENS = "tokens.json";
  var COMPONENTS_LOCAL = "components.local.json";
  var COMPONENTS_LIBRARY = "components.library.json";
  var HYGIENE = "hygiene.json";
  var MANIFEST = "design-system.json";
  var STYLE_KIND_ROWS = {
    paint: { kind: "paint", file: "styles.paint.json", key: "stylesPaint" },
    text: { kind: "text", file: "styles.text.json", key: "stylesText" },
    effect: { kind: "effect", file: "styles.effect.json", key: "stylesEffect" },
    grid: { kind: "grid", file: "styles.grid.json", key: "stylesGrid" },
    animation: { kind: "animation", file: "styles.animation.json", key: "stylesAnimation" }
    // local custom animation styles
  };
  var STYLE_KINDS = Object.values(STYLE_KIND_ROWS);
  function stylesOf(styles, kind) {
    const list = styles ? styles[kind] : void 0;
    return Array.isArray(list) ? list : [];
  }
  function byStyleKey(value) {
    const out = {};
    for (const row of STYLE_KINDS) out[row.key] = value(row);
    return out;
  }
  function isLibraryEntry(c) {
    return !!(c && c.remote === true);
  }
  function buildDesignSystemLayout(ds, sep) {
    const d = ds || {};
    const join = (name) => DIR + (sep || "/") + name;
    const stamp = { ...ifDefined("exportedAt", d.exportedAt), ...ifDefined("file", d.file), ...ifDefined("colorProfile", d.colorProfile) };
    const components = Array.isArray(d.components) ? d.components : [];
    const rawLocal = components.filter((c) => !isLibraryEntry(c));
    const library = components.filter(isLibraryEntry);
    const hygiene = Array.isArray(d.hygiene) ? d.hygiene : [];
    const usedNames = /* @__PURE__ */ new Set();
    const uniqueDetailName = (name, id) => {
      const base = safe(name || "component") + "__" + safe(id);
      if (!usedNames.has(base)) {
        usedNames.add(base);
        return base;
      }
      let i = 2;
      while (usedNames.has(base + "_" + i)) i++;
      usedNames.add(base + "_" + i);
      return base + "_" + i;
    };
    const componentFiles = [];
    const local = rawLocal.map((c) => {
      if (c.type === "COMPONENT" && c.node) {
        const { node, ...rest } = c;
        const detailName2 = uniqueDetailName(c.name, c.id);
        const detailPath2 = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/") + detailName2 + ".json";
        componentFiles.push({
          path: detailPath2,
          data: { ...stamp, ...ifDefined("id", c.id), ...ifDefined("key", c.key), name: c.name, node }
        });
        return { ...rest, nodeFile: detailPath2 };
      }
      if (c.type !== "COMPONENT_SET" || !Array.isArray(c.variants) || !c.variants.some((v) => v && v.node)) {
        return c;
      }
      const slimVariants = c.variants.map((v) => {
        const rest = Object.assign({}, v);
        delete rest.node;
        return rest;
      });
      const detailName = uniqueDetailName(c.name, c.id);
      const detailPath = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/") + detailName + ".json";
      componentFiles.push({
        path: detailPath,
        data: { ...stamp, ...ifDefined("setId", c.id), ...ifDefined("setKey", c.key), name: c.name, variants: c.variants }
      });
      return { ...c, variants: slimVariants, variantsFile: detailPath };
    });
    const files = [
      { path: join(TOKENS), data: { ...stamp, ...ifDefined("collections", d.collections), ...ifDefined("variables", d.variables) } },
      ...STYLE_KINDS.map((row) => ({ path: join(row.file), data: { ...stamp, styles: stylesOf(d.styles, row.kind) } })),
      { path: join(COMPONENTS_LOCAL), data: { ...stamp, components: local } },
      { path: join(COMPONENTS_LIBRARY), data: { ...stamp, components: library } },
      { path: join(HYGIENE), data: { ...stamp, hygiene } },
      ...componentFiles
    ];
    const counts = {
      collections: (d.collections || []).length,
      variables: (d.variables || []).length,
      ...byStyleKey((row) => stylesOf(d.styles, row.kind).length),
      components: local.length,
      libraryComponents: library.length,
      hygiene: hygiene.length
    };
    const manifest = {
      ...stamp,
      files: {
        tokens: join(TOKENS),
        ...byStyleKey((row) => join(row.file)),
        componentsLocal: join(COMPONENTS_LOCAL),
        componentsLibrary: join(COMPONENTS_LIBRARY),
        hygiene: join(HYGIENE)
      },
      counts
    };
    const detailPrefix = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/");
    if (files.some((f) => String(f.path).startsWith(detailPrefix))) {
      manifest.files.componentsDir = DIR + (sep || "/") + COMPONENTS_DIR;
    }
    files.push({ path: MANIFEST, data: manifest });
    return { files, manifest, counts, dir: DIR };
  }
  var DESIGN_SYSTEM_FILE_NAMES = [TOKENS, ...STYLE_KINDS.map((row) => row.file), COMPONENTS_LOCAL, COMPONENTS_LIBRARY, HYGIENE, MANIFEST];

  // ../bridge/src/read-opts.ts
  var WALK = ["node", "selection", "pages"];
  var READ_OPTS = [
    {
      name: "css",
      flag: "--css",
      describe: "Include Figma's OWN computed CSS per node (getCSSAsync) \u2014 the design-to-code oracle. One async call per node, so larger/slower; use for a screen you're implementing.",
      scopes: WALK
    },
    {
      // NOT "Dev Mode only": per developers.figma.com only addMeasurement/editMeasurement/
      // deleteMeasurement carry that restriction — PageNode.getMeasurements() has no such note. And no
      // longer "current page": collect.ts reads measurements from the page(s) actually exported.
      name: "measurements",
      flag: "--measurements",
      describe: "Include measurement redlines (spacing specs the designer placed) for the exported page(s). Reading them does not require Dev Mode.",
      scopes: WALK
    },
    {
      name: "pluginData",
      flag: "--plugin-data",
      describe: "Include own-scope plugin data (getPluginData) stamped on nodes \u2014 round-trip metadata. Usually empty unless the write plane wrote it.",
      scopes: WALK
    },
    {
      name: "motion",
      flag: "--motion",
      describe: "Include motion/animation reads (timelines, manual keyframe tracks, animations, applied animation styles). Free via the Plugin API; useful for Slides/prototype animation. Can be verbose.",
      scopes: WALK
    },
    {
      name: "sharedData",
      flag: "--shared-data",
      describe: "Include cross-plugin shared data (getSharedPluginData) \u2014 notably Tokens Studio applied tokens (the semantic token layer on files without native Figma Variables). Free; per-node.",
      scopes: WALK
    },
    {
      name: "variantVisuals",
      flag: "--variant-visuals",
      describe: "Walk each COMPONENT_SET's variant children and record their real layout/fills/radius/tokens/css \u2014 the master-component source of truth, not the component-set wrapper's own selection-chrome visuals. One node walk per variant; noticeably slower on large systems.",
      scopes: [...WALK, "designSystem", "library"]
    },
    {
      // The odd one out: the others ADD work, this one REMOVES it. Asset export is one exportAsync (a
      // real render round-trip — SVG per vector, 2x PNG per image) PER NODE, run sequentially, and
      // unlike getCSSAsync it was never gated despite being the same O(nodes) shape and far more
      // expensive. On a real design-system page it dominates the export and can outgrow the bridge's
      // frame limit. Opt-IN to skipping, so the default stays exactly as it was.
      name: "skipAssets",
      flag: "--no-assets",
      describe: "Skip the per-node SVG/PNG render pass \u2014 the dominant cost on a big file. Structure, layout and tokens are unaffected; skipped nodes stay leaves marked `assetSkipped: true`. Asset BYTES are stripped from MCP results anyway, so this is usually pure savings here.",
      scopes: WALK
    }
  ];
  function readOptDefaults() {
    const o = {};
    for (const d of READ_OPTS) o[d.name] = false;
    return o;
  }

  // src/run.ts
  function memoName(fetch, unavailable) {
    const cache = /* @__PURE__ */ new Map();
    const get = (id) => {
      let p = cache.get(id);
      if (!p) {
        try {
          p = Promise.resolve(fetch(id)).catch(() => null);
        } catch (e) {
          p = Promise.resolve(null);
        }
        if (unavailable) p = p.then((o) => {
          if (!o && typeof id === "string" && id) unavailable(id);
          return o;
        });
        cache.set(id, p);
      }
      return p;
    };
    const fn = (async (id) => {
      const o = await get(id);
      return o ? o.name : void 0;
    });
    fn.obj = get;
    fn.ids = () => Array.from(cache.keys());
    return fn;
  }
  var WARN_EXAMPLES = 10;
  var Run = class {
    constructor(info) {
      this.readOpts = readOptDefaults();
      this.readsFixed = false;
      this.delivery = { sourceBytes: true };
      this.claimed = false;
      this.stats = {
        nodes: 0,
        assetsFailed: 0,
        assetsSkipped: 0,
        assetsSkippedInvisible: 0,
        assetsGeometry: 0,
        assetsHidden: 0,
        hiddenNodes: 0,
        truncated: 0
      };
      /** Per-run diagnostics so the agent knows what was and wasn't captured (never silent truncation). */
      this.warnings = [];
      this.grouped = /* @__PURE__ */ new Map();
      /** The run's exported assets — { id, name, format, file, base64/text }. */
      this.assets = [];
      /** assets.ts's naming tables: content hash -> the file already written for it, and taken basename (case-folded)
       *  -> the hash that owns it. `byContent` holds the same Asset objects (base64/text payloads) as `assets`. */
      this.assetFiles = { byContent: /* @__PURE__ */ new Map(), byName: /* @__PURE__ */ new Map() };
      /** Intrinsic pixel size per image hash, resolved once per run via getImageByHash().getSizeAsync(). A design
       *  reuses the same image across many fills/nodes, so memoize to avoid O(nodes) downloads. Holds the in-flight
       *  PROMISE: paints resolve concurrently, so a value-cache let two fills sharing a hash both miss — costing a
       *  second download AND pushing the source bytes into `assets` twice. */
      this.imageSizes = /* @__PURE__ */ new Map();
      this.varName = memoName((id) => figma.variables.getVariableByIdAsync(id), (id) => this.warn("variable metadata unavailable for '" + id + "' \u2014 token names unavailable; raw alias IDs retained where supported"));
      this.styleName = memoName((id) => figma.getStyleByIdAsync(id));
      /** Prototype destinations. */
      this.nodeName = memoName((id) => figma.getNodeByIdAsync(id));
      /** Variable collections, read to turn a node's pinned variable-mode ids into human names (theming). A file has a
       *  handful reused across every node, so the whole object is cached per run (its .modes list too) — the same
       *  memo, through `.obj`. */
      this.collection = memoName((id) => figma.variables && figma.variables.getVariableCollectionByIdAsync ? figma.variables.getVariableCollectionByIdAsync(id) : Promise.resolve(null), (id) => {
        if (figma.variables && typeof figma.variables.getVariableCollectionByIdAsync === "function") {
          this.warn("collection metadata unavailable for '" + id + "' \u2014 collection/mode names unavailable; raw mode IDs retained where supported");
        }
      }).obj;
      /** Who asked this run to stop, if anyone: the designer's Cancel button, or the bridge giving up on the request
       *  (progress.ts requestAbandon). One field rather than two flags so the run fails with exactly one, truthful
       *  message. Starts null with the run, so a cancel that landed while nothing was running — or after the run it
       *  was meant for had already finished — cannot kill the next one. */
      this.cancel = null;
      /** The page the walk is on (progress.ts enterPage), so the ticks that are not page boundaries can say WHERE they
       *  are. */
      this.page = void 0;
      /** When this run last posted a throttled progress frame. */
      this.lastPost = 0;
      /** Bound, so it can be handed on as a warning sink (`findNodeById(id, r.warn)`). */
      this.warn = (msg) => {
        this.warnings.push(msg);
      };
      /** `kind` is the stable grouping key (a sentence with no node-specific text in it); `ref` identifies
       *  the node — pass "<name> (<id>)" so the examples are actionable. */
      this.warnKind = (kind, ref) => {
        let g = this.grouped.get(kind);
        if (!g) {
          g = { count: 0, examples: [] };
          this.grouped.set(kind, g);
        }
        g.count++;
        if (ref && g.examples.length < WARN_EXAMPLES) g.examples.push(ref);
      };
      this.info = info;
    }
    /** The opt-in reads this run makes: all off until its collector names them (useReads). */
    get reads() {
      return this.readOpts;
    }
    /** Fix this run's read options. Once per run: a read cannot change what it reads halfway through, so a walk that
     *  needs a different policy says so in its own arguments (serialize.ts AssetPolicy). */
    useReads(opts) {
      if (this.readsFixed) throw new Error("a run's read options are fixed once, by its collector");
      this.readsFixed = true;
      const r = readOptDefaults();
      for (const k of Object.keys(r)) r[k] = !!(opts && opts[k]);
      this.readOpts = r;
    }
    /** See Delivery.sourceBytes. */
    get sourceBytes() {
      return this.delivery.sourceBytes;
    }
    /** The run's warnings: the one-off lines, then one line per kind (warnKind). A fresh array per call. */
    warningLines() {
      const out = this.warnings.slice();
      this.grouped.forEach((g, kind) => {
        let line = kind + ": " + g.count + " node(s)";
        if (g.examples.length) {
          line += " \u2014 e.g. " + g.examples.join("; ");
          if (g.count > g.examples.length) line += " (+" + (g.count - g.examples.length) + " more)";
        }
        out.push(line);
      });
      return out;
    }
    /** @internal claimRun's bookkeeping: the first collector to claim a scheduled run sets its delivery. */
    claim(delivery) {
      if (this.claimed) return false;
      this.claimed = true;
      if (delivery && delivery.sourceBytes === false) this.delivery = { sourceBytes: false };
      return true;
    }
    /** Drop the run's asset payloads (tens of MB of base64 PNG/SVG). A collector has already returned its own
     *  assets.slice(), and a run that THREW hands them to nobody; the dedupe tables go too, since `byContent` points
     *  at the same objects. Clearing drops the references only; the returned objects are never touched. */
    release() {
      this.assets.length = 0;
      this.assetFiles.byContent.clear();
      this.assetFiles.byName.clear();
    }
  };
  var SKIP_ASSETS_NOTE = (n) => `--no-assets: ${n} node(s) that would have exported an SVG/PNG were skipped; each is marked 'assetSkipped: true' in the tree and stays a leaf, exactly as the full export serializes it (structure, layout and tokens are unaffected). The per-root reference screenshot is still captured \u2014 it is one render per exported root, not per node.`;
  function manifestOf(r) {
    const note = r.reads.skipAssets && r.stats.assetsSkipped ? SKIP_ASSETS_NOTE(r.stats.assetsSkipped) : null;
    const all = r.warningLines();
    const reads = Object.keys(r.reads).filter((k) => r.reads[k]);
    return { ...r.stats, skipped: r.stats.truncated, reads, warnings: note ? all.concat(note) : all };
  }
  var current = null;
  var last = null;
  function install(r) {
    if (current && current !== r) current.release();
    current = r;
    last = r;
    return r;
  }
  function openRun(info) {
    return install(new Run(info));
  }
  function closeRun(r) {
    r.release();
    if (current === r) current = null;
  }
  function activeRun() {
    return current && current.info ? current : null;
  }
  function run() {
    return current || install(new Run(null));
  }
  function claimRun(delivery) {
    if (current && current.info) {
      if (!current.claim(delivery)) throw new Error("one collector per run: '" + current.info.label + "' already has its read");
      return current;
    }
    const r = install(new Run(null));
    r.claim(delivery);
    return r;
  }
  function assetRetention() {
    return last ? { assets: last.assets.length, byContent: last.assetFiles.byContent.size, byName: last.assetFiles.byName.size } : { assets: 0, byContent: 0, byName: 0 };
  }

  // src/progress.ts
  var CANCELLED_MESSAGE = "export cancelled by the designer in Figma";
  var ABANDONED_MESSAGE = "export cancelled: the bridge request that asked for it was abandoned (its caller timed out, stalled out, or disconnected)";
  var CANCELLED = "__designTwinCancelled";
  var ABANDONED = "__designTwinAbandoned";
  function cancelledError() {
    const e = new Error(CANCELLED_MESSAGE);
    e[CANCELLED] = true;
    return e;
  }
  function abandonedError() {
    const e = new Error(ABANDONED_MESSAGE);
    e[CANCELLED] = true;
    e[ABANDONED] = true;
    return e;
  }
  function isAbandonment(e) {
    return !!e && typeof e === "object" && e[ABANDONED] === true;
  }
  var MIN_INTERVAL_MS = 250;
  function post(m) {
    try {
      if (figma && figma.ui && typeof figma.ui.postMessage === "function") figma.ui.postMessage(m);
    } catch (e) {
    }
  }
  function postRunBegin(info) {
    post({ type: "run-begin", source: info.source, label: info.label, ...ifDefined("requestId", info.requestId) });
  }
  function postRunEnd(abandoned) {
    post(abandoned ? { type: "run-end", abandoned: true } : { type: "run-end" });
  }
  function postQueued(run2) {
    if (run2.source !== "bridge") return;
    post({ type: "progress", phase: "queued", source: "bridge", label: run2.label, ...ifDefined("requestId", run2.requestId) });
  }
  function postStarted(run2) {
    if (run2.source !== "bridge") return;
    post({ type: "progress", phase: "start", source: "bridge", label: run2.label, ...ifDefined("requestId", run2.requestId) });
  }
  function requestCancel() {
    const r = activeRun();
    if (!r || !r.info) return null;
    r.cancel = "designer";
    return r.info;
  }
  function requestAbandon(matches) {
    const r = activeRun();
    if (!r || !r.info || !matches(r.info)) return null;
    if (r.cancel === null) r.cancel = "abandoned";
    return r.info;
  }
  function checkCancelled() {
    const r = activeRun();
    if (!r) return;
    if (r.cancel === "designer") throw cancelledError();
    if (r.cancel === "abandoned") throw abandonedError();
  }
  function progress(phase, extra, force) {
    const r = activeRun();
    if (!r || !r.info) return;
    const now = Date.now();
    if (!force && now - r.lastPost < MIN_INTERVAL_MS) return;
    r.lastPost = now;
    post({ type: "progress", phase, source: r.info.source, label: r.info.label, ...ifDefined("page", r.page), ...extra });
  }
  function enterPage(phase, index, of, name, pageId, extra) {
    const r = activeRun();
    if (!r) return;
    r.page = { index, of, name, ...ifDefined("pageId", pageId) };
    progress(phase, extra, true);
  }

  // src/state.ts
  var queuedRuns = /* @__PURE__ */ new Set();
  var runChain = Promise.resolve();
  var inChain = 0;
  function serializeRun(fn, run2) {
    return enqueue(fn, run2, true);
  }
  function scheduleRun(kind, fn, run2) {
    if (kind === "identity") return fn();
    return enqueue(fn, run2, kind === "exclusive");
  }
  function enqueue(fn, run2, bracketed) {
    const ticket = { run: run2, abandoned: false };
    queuedRuns.add(ticket);
    const waits = inChain > 0;
    if (waits) postQueued(run2);
    inChain++;
    const go = () => {
      queuedRuns.delete(ticket);
      if (ticket.abandoned) {
        inChain--;
        return Promise.reject(abandonedError());
      }
      if (!bracketed && waits) postStarted(run2);
      const ran = bracketed ? bracket(fn, run2) : Promise.resolve().then(fn);
      return ran.finally(() => {
        inChain--;
      });
    };
    const next = runChain.then(go, go);
    runChain = next.then(() => {
    }, () => {
    });
    return next;
  }
  function cancelBridgeRequest(id) {
    for (const t of queuedRuns) {
      if (t.run.source === "bridge" && t.run.requestId === id) {
        t.abandoned = true;
        return t.run;
      }
    }
    return requestAbandon((r) => r.source === "bridge" && r.requestId === id);
  }
  function cancelBridgeRuns() {
    let hit = 0;
    for (const t of queuedRuns) {
      if (t.run.source === "bridge" && !t.abandoned) {
        t.abandoned = true;
        hit++;
      }
    }
    if (requestAbandon((r) => r.source === "bridge")) hit++;
    return hit;
  }
  async function bracket(fn, run2) {
    const ctx = openRun(run2);
    postRunBegin(run2);
    let abandoned = false;
    try {
      return await fn();
    } catch (e) {
      abandoned = isAbandonment(e);
      throw e;
    } finally {
      closeRun(ctx);
      postRunEnd(abandoned);
    }
  }
  async function loadAllPages(consequence, sink) {
    if (!figma.loadAllPagesAsync) return;
    try {
      await figma.loadAllPagesAsync();
    } catch (e) {
      sink("loadAllPagesAsync failed (" + consequence + "): " + errMsg(e));
    }
  }

  // ../bridge/src/node-id.ts
  var ID = "[A-Za-z0-9%:;_-]+";
  var NODE_ID_RE = new RegExp("node-id=(" + ID + ")");
  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }
  var COLON_ID_RE = /^I?\d+:\d+(?:[;:]\d+:\d+)*$/;
  function normalizeNodeId(raw) {
    if (!raw) return void 0;
    const s = decode(String(raw).trim()).replace(/-/g, ":");
    return COLON_ID_RE.test(s) || /^\d+$/.test(s) ? s : void 0;
  }
  function parseNodeId(input) {
    if (!input) return void 0;
    const s = String(input).trim();
    try {
      const nid = new URL(s).searchParams.get("node-id");
      if (nid) return normalizeNodeId(nid);
    } catch (e) {
    }
    const m = s.match(NODE_ID_RE);
    if (m) return normalizeNodeId(m[1]);
    return normalizeNodeId(s);
  }
  function toNodeId(raw) {
    return parseNodeId(raw) || (raw == null ? "" : String(raw));
  }

  // ../bridge/src/commands.ts
  var WRITE_OP_NAMES = ["createFrame", "createText", "setFill", "setText"];
  var WRITE_OPS = {
    createFrame: { effect: "creates", required: [], shows: {} },
    createText: { effect: "creates", required: ["text"], shows: { newText: "text" } },
    setFill: { effect: "overwrites", required: ["nodeId", "color"], shows: { newFill: "color" } },
    setText: { effect: "overwrites", required: ["nodeId", "text"], shows: { newText: "text" } }
  };
  function missingWriteFields(op, fields) {
    return WRITE_OPS[op].required.filter((k) => fields[k] === void 0);
  }
  var EDITS_OFF_MESSAGE = "Edits are off in the Design Twin plugin \u2014 tick 'Allow edits' in the plugin window, then retry. Nothing in the file was changed.";
  var COMMAND_TRAITS = {
    ping: { run: "identity", export: false },
    whoami: { run: "identity", export: false },
    getSelection: { run: "scene", export: false },
    listPages: { run: "scene", export: false },
    listChildren: { run: "scene", export: false },
    listLibraries: { run: "scene", export: false },
    exportFull: { run: "exclusive", export: true },
    exportDesignSystem: { run: "exclusive", export: true },
    exportLibrary: { run: "exclusive", export: true },
    exportSelection: { run: "exclusive", export: true },
    exportNode: { run: "exclusive", export: true },
    screenshot: { run: "exclusive", export: true },
    write: { run: "exclusive", export: false }
  };
  function isCmd(x) {
    return Object.prototype.hasOwnProperty.call(COMMAND_TRAITS, x);
  }
  var COMMANDS = Object.keys(COMMAND_TRAITS).filter(isCmd);
  function runKind(cmd) {
    return COMMAND_TRAITS[cmd].run;
  }
  var NO_NODE_ID = "No node id provided.";
  var isBool = (v) => typeof v === "boolean";
  var isStr = (v) => typeof v === "string";
  var isNum = (v) => typeof v === "number";
  function opt(a, key, ok, what, label = key) {
    const v = a[key];
    return v === void 0 || ok(v) ? null : `\`${label}\` is not ${what}`;
  }
  function first(errs) {
    for (const e of errs) if (e !== null) return e;
    return null;
  }
  var READ_OPT_NAMES = READ_OPTS.map((o) => o.name);
  var readOptArgs = (a) => first(READ_OPT_NAMES.map((k) => opt(a, k, isBool, "a boolean")));
  var nodeArgs = (a) => a.nodeId === void 0 || a.nodeId === null ? NO_NODE_ID : isStr(a.nodeId) ? null : "`nodeId` is not a string";
  var designSystemArgs = (a) => opt(a, "variantVisuals", isBool, "a boolean");
  var isPageSel = (v) => isStr(v) || Array.isArray(v) && v.every(isStr);
  var isWriteOpName = (v) => isStr(v) && Object.prototype.hasOwnProperty.call(WRITE_OPS, v);
  var isPadding = (v) => Array.isArray(v) && v.length === 4 && v.every(isNum);
  var WRITE_STR_FIELDS = ["parentId", "name", "fill", "text", "nodeId", "color"];
  var WRITE_NUM_FIELDS = ["width", "height", "itemSpacing", "fontSize"];
  function writeOpError(o, i) {
    const at = `ops[${i}]`;
    if (!isRecord(o)) return `\`${at}\` is not an object`;
    const op = o.op;
    if (!isWriteOpName(op)) return `\`${at}.op\` is not one of ${WRITE_OP_NAMES.join(" | ")}`;
    const typeErr = first([
      ...WRITE_STR_FIELDS.map((k) => opt(o, k, isStr, "a string", `${at}.${k}`)),
      ...WRITE_NUM_FIELDS.map((k) => opt(o, k, isNum, "a number", `${at}.${k}`)),
      opt(o, "layoutMode", (v) => v === "HORIZONTAL" || v === "VERTICAL", "HORIZONTAL or VERTICAL", `${at}.layoutMode`),
      opt(o, "padding", isPadding, "four numbers", `${at}.padding`)
    ]);
    if (typeErr !== null) return typeErr;
    const missing = missingWriteFields(op, o);
    return missing.length ? `\`${at}\` (${op}): missing ${missing.join(", ")}` : null;
  }
  var writeArgs = (a) => {
    if (!Array.isArray(a.ops)) return a.ops === void 0 ? "`ops` is missing" : "`ops` is not an array";
    return first(a.ops.map(writeOpError));
  };
  var noArgs = () => null;
  var ARGS_CHECKS = {
    ping: noArgs,
    whoami: noArgs,
    getSelection: noArgs,
    listPages: (a) => opt(a, "depth", (v) => v === 1 || v === 2, "1 or 2"),
    listChildren: nodeArgs,
    listLibraries: noArgs,
    exportFull: (a) => first([readOptArgs(a), opt(a, "allPages", isBool, "a boolean"), opt(a, "page", isPageSel, "a string or an array of strings")]),
    exportDesignSystem: designSystemArgs,
    exportLibrary: (a) => first([designSystemArgs(a), opt(a, "asLibrary", isStr, "a string")]),
    exportSelection: readOptArgs,
    exportNode: (a) => first([nodeArgs(a), readOptArgs(a)]),
    screenshot: (a) => first([nodeArgs(a), opt(a, "scale", isNum, "a number")]),
    write: writeArgs
  };
  function argsShapeError(cmd, args) {
    if (!isRecord(args)) return `bad ${cmd} args: not an object`;
    const e = ARGS_CHECKS[cmd](args);
    return e === null || e === NO_NODE_ID ? e : `bad ${cmd} args: ${e}`;
  }
  function hasArgs(cmd, a) {
    return ARGS_CHECKS[cmd](a) === null;
  }
  function parseCommandRequest(cmd, args) {
    if (!isCmd(cmd)) return { ok: false, error: "unknown cmd: " + cmd };
    const a = isRecord(args) ? args : {};
    const bad = () => ({ ok: false, error: argsShapeError(cmd, a) || `bad ${cmd} args` });
    switch (cmd) {
      case "ping":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "whoami":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "getSelection":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "listPages":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "listChildren":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "listLibraries":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "exportFull":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "exportDesignSystem":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "exportLibrary":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "exportSelection":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "exportNode":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "screenshot":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      case "write":
        return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
      default: {
        const exhaustive = cmd;
        return { ok: false, error: "unknown cmd: " + String(exhaustive) };
      }
    }
  }

  // src/layout.ts
  var ALIGN = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end",
    SPACE_BETWEEN: "space-between",
    SPACE_EVENLY: "space-evenly",
    SPACE_AROUND: "space-around",
    BASELINE: "baseline",
    // AUTO is never looked up (counterAxisAlignContent skips it via the `!== "AUTO"` check below); the
    // value exists only to make this Record total over AlignKey.
    AUTO: "flex-start"
  };
  function flexIntent(src) {
    const l = { display: "flex", flexDirection: src.layoutMode === "VERTICAL" ? "column" : "row" };
    const isAutoSpacing = src.primaryAxisAlignItems === "SPACE_BETWEEN" || src.primaryAxisAlignItems === "SPACE_EVENLY" || src.primaryAxisAlignItems === "SPACE_AROUND";
    if (src.itemSpacing && !isAutoSpacing) l.gap = src.itemSpacing;
    const pad = [src.paddingTop, src.paddingRight, src.paddingBottom, src.paddingLeft];
    if (pad.some((p) => p)) l.padding = pad;
    if (src.primaryAxisAlignItems && src.primaryAxisAlignItems !== "MIN") l.justifyContent = ALIGN[src.primaryAxisAlignItems];
    if (src.counterAxisAlignItems && src.counterAxisAlignItems !== "MIN") l.alignItems = ALIGN[src.counterAxisAlignItems];
    if (src.layoutWrap === "WRAP") {
      l.flexWrap = "wrap";
      if (src.counterAxisSpacing && src.counterAxisAlignContent !== "SPACE_BETWEEN") {
        if (l.flexDirection === "column") l.columnGap = src.counterAxisSpacing;
        else l.rowGap = src.counterAxisSpacing;
      }
      if (src.counterAxisAlignContent && src.counterAxisAlignContent !== "AUTO") l.alignContent = ALIGN[src.counterAxisAlignContent];
    }
    return l;
  }
  function simplifyGrid(g) {
    if (!g) return void 0;
    const o = { ...ifDefined("pattern", g.pattern ? lower(g.pattern) : void 0) };
    if (typeof g.sectionSize === "number") o.size = round(g.sectionSize);
    if (g.pattern !== "GRID") {
      if (typeof g.gutterSize === "number") o.gutter = round(g.gutterSize);
      if (typeof g.count === "number" && g.count !== Infinity) o.count = g.count;
      if (typeof g.offset === "number") o.offset = round(g.offset);
      if (g.alignment) o.alignment = lower(g.alignment);
    }
    if (g.visible === false) o.visible = false;
    return o;
  }
  function simplifyTrack(t) {
    const o = { ...ifDefined("type", t.type ? lower(t.type) : void 0) };
    if (typeof t.value === "number") o.value = round(t.value);
    return o;
  }
  var GRID_SELF = { MIN: "start", CENTER: "center", MAX: "end" };
  function layout(node) {
    if (!("children" in node)) return void 0;
    const n = node;
    if (!("layoutMode" in node) || n.layoutMode === "NONE") {
      if ("inferredAutoLayout" in node && n.inferredAutoLayout) {
        const l2 = flexIntent(n.inferredAutoLayout);
        l2.inferred = true;
        return l2;
      }
      if (!("width" in node)) return void 0;
      return { mode: "absolute", width: round(n.width), height: round(n.height) };
    }
    if (n.layoutMode === "GRID") {
      const g = { display: "grid" };
      const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
      if (pad.some((p) => p)) g.padding = pad;
      if ("gridColumnCount" in node && typeof n.gridColumnCount === "number") g.columns = n.gridColumnCount;
      if ("gridRowCount" in node && typeof n.gridRowCount === "number") g.rows = n.gridRowCount;
      if ("gridColumnGap" in node && typeof n.gridColumnGap === "number") g.columnGap = n.gridColumnGap;
      if ("gridRowGap" in node && typeof n.gridRowGap === "number") g.rowGap = n.gridRowGap;
      if ("gridColumnSizes" in node && Array.isArray(n.gridColumnSizes) && n.gridColumnSizes.length) g.columnSizes = n.gridColumnSizes.map(simplifyTrack);
      if ("gridRowSizes" in node && Array.isArray(n.gridRowSizes) && n.gridRowSizes.length) g.rowSizes = n.gridRowSizes.map(simplifyTrack);
      if ("gridItemsPositioning" in node && n.gridItemsPositioning && n.gridItemsPositioning !== "MANUAL") g.autoFlow = String(n.gridItemsPositioning).toLowerCase();
      if ("gridAutoTracks" in node && n.gridAutoTracks && n.gridAutoTracks !== "NONE") g.autoTracks = String(n.gridAutoTracks).toLowerCase();
      return g;
    }
    const l = flexIntent(n);
    if ("itemReverseZIndex" in node && n.itemReverseZIndex) l.reverseZ = true;
    return l;
  }

  // src/variables.ts
  function isVariableAlias(v) {
    return !!v && typeof v === "object" && "type" in v && v.type === "VARIABLE_ALIAS";
  }
  async function resolveVar(alias) {
    if (!isVariableAlias(alias)) return void 0;
    return run().varName(alias.id);
  }
  async function resolveBoundMap(bound) {
    if (!bound) return void 0;
    const out = {};
    for (const key of Object.keys(bound)) {
      const val = bound[key];
      if (Array.isArray(val)) {
        const names = (await Promise.all(val.map(resolveVar))).filter((x) => !!x);
        const [first2, ...rest] = names;
        if (first2 !== void 0) out[key] = rest.length ? names : first2;
      } else {
        const n = await resolveVar(val);
        if (n) out[key] = n;
      }
    }
    return nonEmpty(out);
  }
  async function boundTokens(node) {
    return resolveBoundMap(node.boundVariables);
  }
  async function styleName(id) {
    if (!id || id === figma.mixed) return void 0;
    return run().styleName(id);
  }
  var STYLE_FIELDS = [
    ["fillStyleId", "fill"],
    ["strokeStyleId", "stroke"],
    ["effectStyleId", "effect"],
    ["textStyleId", "text"],
    ["gridStyleId", "grid"]
    // a frame referencing a shared layout-grid style
  ];
  async function nodeStyles(node) {
    const names = await Promise.all(
      STYLE_FIELDS.map(([field]) => {
        if (!(field in node)) return Promise.resolve(void 0);
        const id = anyProp(node, field);
        return typeof id === "string" || id === figma.mixed ? styleName(id) : Promise.resolve(void 0);
      })
    );
    const out = {};
    STYLE_FIELDS.forEach(([, key], i) => {
      const n = names[i];
      if (n) out[key] = n;
    });
    return nonEmpty(out);
  }
  async function resolveModeMap(raw, skipSingleMode) {
    if (!raw || !Object.keys(raw).length) return void 0;
    const out = {};
    for (const [collectionId, modeId] of Object.entries(raw)) {
      const c = await run().collection(collectionId);
      if (!c || !Array.isArray(c.modes)) {
        out[collectionId] = modeId;
        continue;
      }
      if (skipSingleMode && c.modes.length <= 1) continue;
      const m = c.modes.find((x) => x.modeId === modeId);
      out[c.name] = m ? m.name : modeId;
    }
    return nonEmpty(out);
  }
  function variableModes(node) {
    return resolveModeMap(node.explicitVariableModes, false);
  }
  function resolvedModes(node) {
    return resolveModeMap(node.resolvedVariableModes, true);
  }
  function isComposedColor(v) {
    return typeof v === "object" && "opacity" in v && "color" in v;
  }
  function isRgb(x) {
    return !!x && typeof x === "object" && "r" in x && typeof x.r === "number" && "g" in x && typeof x.g === "number" && "b" in x && typeof x.b === "number";
  }
  function composedFromExpression(v) {
    const u = v;
    if (!u || typeof u !== "object" || !("type" in u) || u.type !== "VARIABLE_EXPRESSION") return null;
    if (!("expressionFunction" in u) || u.expressionFunction !== "COMPOSE_COLOR") return null;
    if (!("expressionArguments" in u) || !isUnknownArray(u.expressionArguments) || u.expressionArguments.length !== 2) return null;
    const [c, o] = u.expressionArguments;
    if (isVariableAlias(c)) {
      if (isVariableAlias(o) || typeof o === "number") return { color: c, opacity: o };
      return null;
    }
    return isRgb(c) && isVariableAlias(o) ? { color: c, opacity: o } : null;
  }
  function toComposed(v) {
    return isComposedColor(v) ? v : composedFromExpression(v);
  }
  function colorIsAlias(v) {
    return isVariableAlias(v.color);
  }
  function aliasIds(v) {
    if (isVariableAlias(v)) return v.id ? [v.id] : [];
    const c = toComposed(v);
    if (!c) return [];
    const out = [];
    if (isVariableAlias(c.color) && c.color.id) out.push(c.color.id);
    if (isVariableAlias(c.opacity) && c.opacity.id) out.push(c.opacity.id);
    return out;
  }
  async function aliasValue(a) {
    return { aliasOf: await run().varName(a.id) || a.id };
  }
  async function composedValue(v) {
    if (colorIsAlias(v)) {
      const [color, opacity] = await Promise.all([aliasValue(v.color), isVariableAlias(v.opacity) ? aliasValue(v.opacity) : v.opacity]);
      return { composed: { color, opacity } };
    }
    return { composed: { color: rgbaToHex(v.color), opacity: await aliasValue(v.opacity) } };
  }
  async function resolveModeValue(v, resolvedType) {
    if (isVariableAlias(v)) return aliasValue(v);
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (isComposedColor(v)) return composedValue(v);
    const fromExpression = composedFromExpression(v);
    if (fromExpression) return composedValue(fromExpression);
    if (resolvedType === "COLOR" && "r" in v && typeof v.r === "number") return rgbaToHex(v);
    return verbatimValue(v);
  }
  function verbatimValue(v) {
    const o = v;
    return o;
  }
  async function dumpVariables(opts) {
    const asLibrary = !!(opts && opts.asLibrary);
    const pendingPublish = [];
    const publishOf2 = async (o) => {
      try {
        if (!asLibrary || !o || typeof o.getPublishStatusAsync !== "function") return void 0;
        const s = await o.getPublishStatusAsync();
        return s ? String(s).toLowerCase() : void 0;
      } catch (e) {
        return void 0;
      }
    };
    const [collections, localVars] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync()
    ]);
    const collById = new Map(collections.map((c) => [c.id, c]));
    const collOf = (cid) => collById.get(cid);
    const localIds = new Set(localVars.map((v) => v.id));
    const variables = [];
    const hygiene = [];
    const aliasTargets = (v) => {
      const out = [];
      for (const value of Object.values(v.valuesByMode || {})) out.push(...aliasIds(value));
      return out;
    };
    const remoteVars = [];
    const seen = new Set(localIds);
    let frontier = [...new Set(run().varName.ids().concat(...localVars.map(aliasTargets)))].filter((id) => !seen.has(id));
    while (frontier.length) {
      for (const id of frontier) seen.add(id);
      const fetched = (await Promise.all(frontier.map((id) => run().varName.obj(id)))).filter(Boolean);
      remoteVars.push(...fetched);
      frontier = [...new Set([].concat(...fetched.map(aliasTargets)))].filter((id) => !seen.has(id));
    }
    const missingCollIds = [...new Set(remoteVars.map((v) => v.variableCollectionId).filter((cid) => cid && !collById.has(cid)))];
    for (const c of await Promise.all(missingCollIds.map((cid) => run().collection(cid)))) {
      if (c) collById.set(c.id, c);
    }
    const allCollections = [...collById.values()];
    const modeName = {};
    for (const c of allCollections) for (const m of c.modes) if (!(m.modeId in modeName)) modeName[m.modeId] = m.name;
    const resolvedIds = new Set(localIds);
    for (const v of remoteVars) resolvedIds.add(v.id);
    if (remoteVars.length) {
      hygiene.push(
        remoteVars.length + " variable(s) referenced by this file come from a published LIBRARY, not this file \u2014 included below with remote:true (getLocalVariablesAsync cannot enumerate them)"
      );
    }
    for (const v of localVars.concat(remoteVars)) {
      const values = {};
      let hasAlias = false;
      const modes = await Promise.all(Object.entries(v.valuesByMode).map(async ([modeId, raw]) => ({ modeId, raw, value: await resolveModeValue(raw, v.resolvedType) })));
      for (const { modeId, raw, value } of modes) {
        if (isVariableAlias(raw) || toComposed(raw)) hasAlias = true;
        for (const id of isVariableAlias(raw) ? [raw.id] : aliasIds(raw)) {
          if (!resolvedIds.has(id)) hygiene.push("broken alias in '" + v.name + "' \u2014 target " + id + " could not be resolved");
        }
        values[modeName[modeId] || modeId] = value;
      }
      const coll = collOf(v.variableCollectionId);
      const collKey = coll ? coll.key : void 0;
      const rec = {
        name: v.name,
        type: v.resolvedType,
        collection: (coll || {}).name,
        ...ifDefined("collectionKey", typeof collKey === "string" && collKey ? collKey : void 0),
        // tier: alias => semantic; raw+meaningfully-scoped => semantic leaf; raw+unscoped => primitive.
        // ALL_SCOPES is Figma's default catch-all (it pollutes every picker — see the hygiene flag below),
        // so it does NOT count as a meaningful scope; otherwise almost every variable would read semantic.
        tier: hasAlias ? "semantic" : v.scopes && v.scopes.some((s) => s !== "ALL_SCOPES") ? "semantic" : "primitive",
        values
      };
      if (v.scopes && v.scopes.length) rec.scopes = v.scopes;
      putNonEmpty(rec, "codeSyntax", v.codeSyntax);
      if (v.description) rec.description = v.description;
      if (v.remote) rec.remote = true;
      if (v.hiddenFromPublishing) rec.hiddenFromPublishing = true;
      if (v.key) rec.key = v.key;
      if (asLibrary) pendingPublish.push({ rec, obj: v });
      variables.push(rec);
      if (v.scopes && v.scopes.indexOf("ALL_SCOPES") !== -1) hygiene.push("ALL_SCOPES on '" + v.name + "' (pollutes every picker)");
      const modeCount = (collOf(v.variableCollectionId) || { modes: [] }).modes.length || 1;
      if (!hasAlias && v.resolvedType === "COLOR" && modeCount > 1) {
        hygiene.push("semantic color '" + v.name + "' holds a raw value in a multi-mode collection (breaks theming)");
      }
    }
    if (pendingPublish.length) {
      const st = await Promise.all(pendingPublish.map((p) => publishOf2(p.obj)));
      for (const [i, p] of pendingPublish.entries()) {
        const s = st[i];
        if (s) p.rec.publish = s;
      }
    }
    const collPublish = {};
    if (asLibrary) {
      const st = await Promise.all(allCollections.map((c) => publishOf2(c)));
      for (const [i, c] of allCollections.entries()) {
        const s = st[i];
        if (s) collPublish[c.id] = s;
      }
    }
    return {
      // Local collections plus any LIBRARY collection a referenced remote variable belongs to — the
      // token emitters need each collection's default mode to pick the `:root` value.
      collections: allCollections.map((c) => ({
        name: c.name,
        modes: c.modes.map((m) => m.name),
        // Which mode is the base/`:root` default (vs. the override theme) — codegen otherwise guesses.
        ...ifDefined("default", modeName[c.defaultModeId] || void 0),
        theming: c.modes.length > 1,
        // Extended collection (its modes inherit from a root collection via parentModeId) — codegen
        // should treat it as an override layer, not a standalone theme. Flag it; deep parent-mode
        // resolution (mode.parentModeId -> root mode) is deferred.
        ...ifDefined("extended", c.isExtension === true ? true : void 0),
        ...ifDefined("hiddenFromPublishing", c.hiddenFromPublishing === true ? true : void 0),
        ...ifDefined("key", c.key || void 0),
        // durable cross-file collection identity
        ...ifDefined("publish", collPublish[c.id] || void 0)
        // library mode only
      })),
      variables,
      hygiene
    };
  }

  // src/assets.ts
  var ASSET_DIR = "assets/";
  function contentHash(a) {
    const src = a.text != null ? normalizeSvgText(a.text) : a.base64 != null ? a.base64 : "";
    let h = 2166136261;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0") + "-" + src.length.toString(36);
  }
  function assetSafe(x) {
    return String(x).replace(/[^a-zA-Z0-9-]+/g, "_").replace(/_+/g, "_");
  }
  function baseNameFor(a) {
    if (a.kind === "reference") return safe(a.id.replace(/:ref$/, "")) + "_ref";
    if (a.kind === "source") return safe(a.id);
    const last2 = String(a.name || "").split("/").pop() || "";
    const cleaned = assetSafe(last2.trim()).replace(/^[-_]+|[-_]+$/g, "");
    return cleaned || safe(a.id);
  }
  function register(a) {
    const fmt = safe(a.format);
    const dedupable = a.kind !== "reference";
    const hash = contentHash(a);
    const r = run();
    const { byContent, byName } = r.assetFiles;
    if (dedupable) {
      const hit = byContent.get(hash + "." + fmt);
      if (hit) {
        (hit.asset.from || (hit.asset.from = [hit.asset.id])).push(a.id);
        return ASSET_DIR + hit.file;
      }
    }
    const base = baseNameFor(a);
    let file = base + "." + fmt;
    const key = file.toLowerCase();
    const taken = byName.get(key);
    if (taken !== void 0 && taken !== hash) {
      const [head = ""] = hash.split("-");
      file = base + "-" + head.slice(0, 6) + "." + fmt;
    }
    byName.set(file.toLowerCase(), hash);
    const asset = { ...a, file, hash };
    r.assets.push(asset);
    if (dedupable) byContent.set(hash + "." + fmt, { file, asset });
    return ASSET_DIR + file;
  }
  function imageFormat(b) {
    if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return "png";
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
    if (b.length >= 12 && b[0] === 82 && b[1] === 73 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) return "webp";
    if (b.length >= 6 && b[0] === 71 && b[1] === 73 && b[2] === 70) return "gif";
    return "bin";
  }
  function collectSourceImage(hash) {
    if (!hash) return Promise.resolve(void 0);
    const sizes = run().imageSizes;
    let p = sizes.get(hash);
    if (!p) {
      p = readSourceImage(hash);
      sizes.set(hash, p);
    }
    return p;
  }
  async function readSourceImage(hash) {
    let size;
    try {
      const img = figma.getImageByHash(hash);
      if (img) {
        const s = await img.getSizeAsync();
        if (s && typeof s.width === "number") size = { w: s.width, h: s.height };
        if (run().sourceBytes) {
          try {
            const bytes = await img.getBytesAsync();
            if (bytes && bytes.length) register({ id: "img:" + hash, name: hash, format: imageFormat(bytes), base64: toBase64(bytes), kind: "source" });
          } catch (e) {
          }
        }
      }
    } catch (e) {
      run().warn("source image unavailable for hash " + hash + " (" + errMsg(e) + ")");
    }
    return size;
  }
  var VECTOR_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON", "ELLIPSE"]);
  var ICON_CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "INSTANCE", "GROUP", "COMPONENT"]);
  function paints(v) {
    return Array.isArray(v) ? v : null;
  }
  function hasVisiblePaint(node, fills) {
    if (fills && fills.some((p) => p.visible !== false)) return true;
    const s = paints("strokes" in node ? node.strokes : void 0);
    return !!s && s.some((p) => p.visible !== false);
  }
  function hasArea(node) {
    if (!("width" in node) || typeof node.width !== "number" || typeof node.height !== "number") return true;
    return node.width > 0 && node.height > 0;
  }
  function paintsNothing(node, isVector, fills) {
    return !hasArea(node) || isVector && !hasVisiblePaint(node, fills);
  }
  function geometryOf(node) {
    const ds = (g) => g ? g.map((p) => p && p.data).filter((d) => typeof d === "string" && !!d) : [];
    const fills = ds("fillGeometry" in node ? node.fillGeometry : void 0);
    const strokes = ds("strokeGeometry" in node ? node.strokeGeometry : void 0);
    if (!fills.length && !strokes.length) return void 0;
    const out = {};
    if (fills.length) out.fills = fills;
    if (strokes.length) out.strokes = strokes;
    if ("width" in node && typeof node.width === "number") {
      out.w = round(node.width);
      out.h = round(node.height);
    }
    return out;
  }
  async function collectAsset(node, hidden, policy) {
    const r = run();
    const stats = r.stats;
    const isVector = VECTOR_TYPES.has(node.type);
    const rawFills = "fills" in node ? node.fills : void 0;
    const fills = Array.isArray(rawFills) ? rawFills : null;
    const kids = "children" in node && Array.isArray(node.children) ? node.children : null;
    const hasImage = !!fills && fills.some((f) => f.type === "IMAGE" && f.visible !== false) && !(kids && kids.length > 0);
    let iconLike = false;
    if (ICON_CONTAINER_TYPES.has(node.type) && node.name && /icon|logo|illustration|avatar/i.test(node.name) && "width" in node && "findOne" in node && Math.max(node.width, node.height) <= 96) {
      try {
        iconLike = !node.findOne((x) => x.type === "TEXT");
      } catch (e) {
        iconLike = false;
      }
    }
    if (!iconLike && ICON_CONTAINER_TYPES.has(node.type) && node.isAsset === true && "findOne" in node) {
      try {
        iconLike = !node.findOne((x) => x.type === "TEXT");
      } catch (e) {
        iconLike = false;
      }
    }
    if ((policy === "none" || r.reads.skipAssets) && (isVector || iconLike || hasImage)) {
      if (policy !== "none") stats.assetsSkipped++;
      return { skipped: true };
    }
    if (hidden && (isVector || iconLike || hasImage)) {
      if ((isVector || iconLike) && paintsNothing(node, isVector, fills)) {
        stats.assetsSkippedInvisible++;
        return void 0;
      }
      stats.assetsHidden++;
      return { skipped: "hidden" };
    }
    if (isVector || iconLike || hasImage) {
      checkCancelled();
      progress("assets", { nodes: stats.nodes, assets: r.assets.length });
    }
    if (isVector || iconLike) {
      if (paintsNothing(node, isVector, fills)) {
        stats.assetsSkippedInvisible++;
        return void 0;
      }
      let svg = null;
      let reason = "empty/invalid SVG";
      try {
        if ("exportAsync" in node) svg = await node.exportAsync({ format: "SVG_STRING" });
      } catch (e) {
        reason = errMsg(e);
      }
      if (svg && svg.indexOf("<svg") !== -1) {
        return { path: register({ id: node.id, name: node.name, format: "svg", text: svg }) };
      }
      const geo = isVector ? geometryOf(node) : void 0;
      if (geo) {
        stats.assetsGeometry++;
        return { geometry: geo };
      }
      stats.assetsFailed++;
      r.warnKind("asset export failed (no geometry to fall back on)", node.name + " (" + node.id + "): " + reason);
      return void 0;
    }
    try {
      if (hasImage && "exportAsync" in node) {
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 }, useAbsoluteBounds: true });
        if (!bytes || !bytes.length) {
          stats.assetsFailed++;
          r.warnKind("image asset export empty", node.name + " (" + node.id + ")");
          return void 0;
        }
        return { path: register({ id: node.id, name: node.name, format: "png", base64: toBase64(bytes) }) };
      }
    } catch (e) {
      stats.assetsFailed++;
      r.warnKind("image asset export failed", node.name + " (" + node.id + "): " + errMsg(e));
    }
    return void 0;
  }
  function referenceScale(node, opts) {
    if (opts && typeof opts.scale === "number" && opts.scale > 0) return opts.scale;
    const w = "width" in node ? node.width || 0 : 0;
    const h = "height" in node ? node.height || 0 : 0;
    return Math.min(2, 2048 / (Math.max(w, h) || 1));
  }
  async function collectReference(node, opts) {
    if (!node || !("exportAsync" in node) || !("width" in node)) return void 0;
    try {
      const value = referenceScale(node, opts);
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
      if (!bytes || !bytes.length) {
        run().warn("reference screenshot empty: " + node.name);
        return void 0;
      }
      return register({ id: node.id + ":ref", name: node.name + " (reference)", format: "png", base64: toBase64(bytes), kind: "reference" });
    } catch (e) {
      run().warn("reference screenshot failed: " + node.name + " (" + errMsg(e) + ")");
      return void 0;
    }
  }
  async function devResources(node) {
    if (!node) return void 0;
    try {
      const rs = await node.getDevResourcesAsync({ includeChildren: true });
      if (!Array.isArray(rs) || !rs.length) return void 0;
      return rs.map((r) => {
        const o = { name: r.name, url: r.url };
        if (r.nodeId) o.nodeId = r.nodeId;
        if (r.inheritedNodeId) o.inheritedNodeId = r.inheritedNodeId;
        return o;
      });
    } catch (e) {
      run().warn("dev resources unavailable for '" + node.name + "' (" + errMsg(e) + ")");
      return void 0;
    }
  }

  // src/paint.ts
  var FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
  function imageFilters(f) {
    if (!f.filters || typeof f.filters !== "object") return void 0;
    const src = f.filters;
    const out = {};
    for (const k of FILTER_KEYS) {
      const v = src[k];
      if (typeof v === "number" && v) out[k] = round(v);
    }
    return nonEmpty(out);
  }
  function paintExtras(f, o) {
    if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
    if (typeof f.opacity === "number" && f.opacity < 1) o.opacity = round(f.opacity);
    return o;
  }
  function mediaPaint(f, type, hash, transform) {
    const o = paintExtras(f, { type, ...ifDefined("scaleMode", f.scaleMode ? lower(f.scaleMode) : void 0) });
    if (hash) o.hash = hash;
    if (f.scaleMode === "TILE" && typeof f.scalingFactor === "number") o.scale = f.scalingFactor;
    if (typeof f.rotation === "number" && f.rotation) o.rotation = f.rotation;
    if (Array.isArray(transform)) o.transform = transform;
    const flt = imageFilters(f);
    if (flt) o.filters = flt;
    return o;
  }
  async function shaderColor(c, tokenKey, tokens) {
    if (isVariableAlias(c)) {
      const name = await resolveVar(c);
      if (name) tokens[tokenKey] = name;
      return void 0;
    }
    return rgbaToHex(c);
  }
  async function shaderValue(v, defId, tokens) {
    if (typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") return round(v);
    if (v == null || typeof v !== "object") return void 0;
    if (isVariableAlias(v)) {
      const name = await resolveVar(v);
      if (name) tokens[defId] = name;
      return void 0;
    }
    if ("stops" in v) {
      const stops = await Promise.all(v.stops.map(async (s, i) => {
        const color = await shaderColor(s.color, `${defId}.stops.${i}.color`, tokens);
        return color === void 0 ? { pos: round(s.position) } : { pos: round(s.position), color };
      }));
      return { stops };
    }
    if ("color" in v) {
      const color = await shaderColor(v.color, `${defId}.color`, tokens);
      return color === void 0 ? xy(v) : { ...xy(v), color };
    }
    if ("radius" in v) {
      return "angle" in v ? { ...xy(v), radius: round(v.radius), angle: round(v.angle) } : { ...xy(v), radius: round(v.radius) };
    }
    if ("x2" in v) return { ...xy(v), x2: round(v.x2), y2: round(v.y2) };
    if ("x" in v) return xy(v);
    if ("r" in v && "g" in v && "b" in v) return { color: rgbaToHex(v) };
    return void 0;
  }
  async function shaderDefs(meta) {
    if (!meta || typeof meta !== "object") return void 0;
    const out = {};
    for (const [defId, d] of Object.entries(meta)) {
      if (!d || typeof d.name !== "string" || typeof d.type !== "string") continue;
      const def = { name: d.name, type: lower(d.type) };
      if (d.defaultValue != null) {
        const dt = {};
        const dv = await shaderValue(d.defaultValue, "default", dt);
        if (dv !== void 0) def.default = dv;
        putNonEmpty(def, "tokens", dt);
      }
      if (typeof d.description === "string" && d.description) def.description = d.description;
      out[defId] = def;
    }
    return out;
  }
  async function putShaderProperties(o, props, meta) {
    const out = {};
    const tokens = {};
    if (props && typeof props === "object") {
      for (const [defId, pv] of Object.entries(props)) {
        const v = await shaderValue(pv, defId, tokens);
        if (v !== void 0) out[defId] = v;
      }
    }
    putNonEmpty(o, "properties", out);
    putNonEmpty(o, "propertyDefs", await shaderDefs(meta));
    putNonEmpty(o, "tokens", tokens);
  }
  async function simplifyFills(fills) {
    if (!fills || fills === figma.mixed || !Array.isArray(fills)) return void 0;
    const vis = fills.filter((f) => f.visible !== false);
    const out = await Promise.all(
      vis.map(async (f) => {
        let o;
        if (f.type === "SOLID") {
          o = { type: "solid", color: solidHex(f) };
          if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
        } else if (f.type.startsWith("GRADIENT")) {
          const g = f;
          const gp = paintExtras(g, { type: "gradient", kind: g.type });
          if (isList(g.gradientStops)) {
            gp.stops = await Promise.all(
              g.gradientStops.map(async (s) => {
                const stop = { pos: round(s.position), color: rgbaToHex(s.color) };
                const bv = await resolveBoundMap(s.boundVariables);
                if (bv) stop.tokens = bv;
                return stop;
              })
            );
          }
          if (Array.isArray(g.gradientTransform)) gp.transform = g.gradientTransform;
          o = gp;
        } else if (f.type === "IMAGE") {
          const mp = mediaPaint(f, "image", f.imageHash, f.imageTransform);
          const size = await collectSourceImage(f.imageHash);
          if (size) mp.intrinsicSize = size;
          o = mp;
        } else if (f.type === "VIDEO") {
          o = mediaPaint(f, "video", f.videoHash, f.videoTransform);
        } else if (f.type === "PATTERN") {
          const pp = paintExtras(f, { type: "pattern" });
          if (f.sourceNodeId) pp.sourceNodeId = f.sourceNodeId;
          if (f.tileType) pp.tileType = String(f.tileType).toLowerCase();
          if (typeof f.scalingFactor === "number") pp.scale = f.scalingFactor;
          if (f.spacing) pp.spacing = xy(f.spacing);
          if (f.horizontalAlignment) pp.align = String(f.horizontalAlignment).toLowerCase();
          o = pp;
        } else if (f.type === "SHADER") {
          const sp = paintExtras(f, { type: "shader" });
          if (f.id) sp.shaderId = f.id;
          await putShaderProperties(sp, f.properties, f.propertyMetadata);
          o = sp;
        } else {
          const future = f;
          o = paintExtras(future, { type: future.type.toLowerCase() });
        }
        const pbv = f.type === "SOLID" ? await resolveBoundMap(f.boundVariables) : void 0;
        if (pbv) o.tokens = pbv;
        return o;
      })
    );
    return out.length ? out : void 0;
  }
  var SIDE_WEIGHTS = [
    ["strokeTopWeight", "top"],
    ["strokeRightWeight", "right"],
    ["strokeBottomWeight", "bottom"],
    ["strokeLeftWeight", "left"]
  ];
  async function simplifyStrokes(node) {
    if (!("strokes" in node) || !isList(node.strokes)) return void 0;
    const vis = node.strokes.filter((s) => s.visible !== false);
    if (!vis.length) return void 0;
    const out = {};
    const solids = vis.filter((s) => s.type === "SOLID");
    if (solids.length) out.colors = solids.map(solidHex);
    if (vis.some((s) => s.type !== "SOLID")) {
      const paints2 = await simplifyFills(vis);
      if (paints2) out.paints = paints2;
    }
    const strokeNode = node;
    const strokeWeight = strokeNode.strokeWeight;
    if (strokeWeight && strokeWeight !== figma.mixed) {
      out.weight = strokeWeight;
    } else if (strokeWeight === figma.mixed) {
      const sides = {};
      SIDE_WEIGHTS.forEach(([k, s]) => {
        const v = numProp(node, k);
        if (v != null) sides[s] = v;
      });
      putNonEmpty(out, "weights", sides);
    }
    const n = strokeNode;
    if (n.strokeAlign) out.align = lower(n.strokeAlign);
    if (n.dashPattern && n.dashPattern.length) out.dash = [...n.dashPattern];
    if ("strokeCap" in node && n.strokeCap && n.strokeCap !== figma.mixed && n.strokeCap !== "NONE") out.cap = String(n.strokeCap).toLowerCase();
    if ("strokeJoin" in node && n.strokeJoin && n.strokeJoin !== figma.mixed && n.strokeJoin !== "MITER") out.join = String(n.strokeJoin).toLowerCase();
    if ("strokeMiterLimit" in node && typeof n.strokeMiterLimit === "number" && n.strokeMiterLimit !== 4) out.miter = n.strokeMiterLimit;
    const vw = n.variableWidthStrokeProperties;
    if (vw && vw.widthProfile) {
      const variableWidth = { profile: lower(vw.widthProfile) };
      if (vw.widthProfile === "CUSTOM" && isList(vw.variableWidthPoints) && vw.variableWidthPoints.length) {
        variableWidth.points = vw.variableWidthPoints.map((p) => ({ pos: round(p.position), width: round(p.width) }));
      }
      out.variableWidth = variableWidth;
    }
    if ("complexStrokeProperties" in node) {
      const complex = complexStroke(node.complexStrokeProperties);
      if (complex) out.complex = complex;
    }
    return out;
  }
  function complexStroke(c) {
    if (!c || typeof c !== "object") return void 0;
    if (c.type === "DYNAMIC") return { type: "dynamic", frequency: round(c.frequency), wiggle: round(c.wiggle), smoothen: round(c.smoothen) };
    if (c.type !== "BRUSH") return void 0;
    if (c.brushType === "STRETCH") return { type: "brush", brushType: "stretch", brushName: lower(c.brushName), direction: lower(c.direction) };
    return {
      type: "brush",
      brushType: "scatter",
      brushName: lower(c.brushName),
      gap: round(c.gap),
      wiggle: round(c.wiggle),
      sizeJitter: round(c.sizeJitter),
      angularJitter: round(c.angularJitter),
      rotation: round(c.rotation)
    };
  }

  // src/effects.ts
  var GLASS_FIELDS = ["lightIntensity", "lightAngle", "refraction", "depth", "dispersion", "radius"];
  function effectBody(e) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const o = { type: lower(e.type) };
      if (e.color) o.color = rgbaToHex(e.color);
      if (e.offset) o.offset = xy(e.offset);
      if (typeof e.radius === "number") o.radius = round(e.radius);
      if (typeof e.spread === "number" && e.spread) o.spread = round(e.spread);
      if (e.blendMode && e.blendMode !== "NORMAL") o.blendMode = e.blendMode.toLowerCase();
      if (e.type === "DROP_SHADOW" && e.showShadowBehindNode) o.behindNode = true;
      return o;
    }
    if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      const o = { type: lower(e.type) };
      if (typeof e.radius === "number") o.radius = round(e.radius);
      if (e.blurType && e.blurType !== "NORMAL") o.blurType = lower(e.blurType);
      const be = e;
      putXY(o, "startOffset", be.startOffset);
      putXY(o, "endOffset", be.endOffset);
      if (typeof be.startRadius === "number") o.startRadius = round(be.startRadius);
      return o;
    }
    if (e.type === "NOISE") {
      const o = { type: "noise" };
      if (e.noiseType) o.noiseType = String(e.noiseType).toLowerCase();
      if (e.color) o.color = rgbaToHex(e.color);
      if (typeof e.density === "number") o.density = round(e.density);
      if (typeof e.noiseSize === "number") o.noiseSize = round(e.noiseSize);
      putXY(o, "noiseSizeVector", e.noiseSizeVector);
      if (e.noiseType === "DUOTONE" && e.secondaryColor) o.secondaryColor = rgbaToHex(e.secondaryColor);
      if (e.noiseType === "MULTITONE" && typeof e.opacity === "number") o.opacity = round(e.opacity);
      if (e.blendMode && e.blendMode !== "NORMAL") o.blendMode = e.blendMode.toLowerCase();
      return o;
    }
    if (e.type === "GLASS") {
      const o = { type: "glass" };
      for (const k of GLASS_FIELDS) {
        const v = e[k];
        if (typeof v === "number") o[k] = round(v);
      }
      return o;
    }
    if (e.type === "TEXTURE") {
      const o = { type: "texture" };
      if (typeof e.noiseSize === "number") o.noiseSize = round(e.noiseSize);
      putXY(o, "noiseSizeVector", e.noiseSizeVector);
      if (typeof e.radius === "number") o.radius = round(e.radius);
      if (typeof e.clipToShape === "boolean") o.clipToShape = e.clipToShape;
      return o;
    }
    if (e.type === "SHADER") {
      const o = { type: "shader" };
      if (e.id) o.shaderId = e.id;
      return o;
    }
    const future = e;
    return { type: future.type.toLowerCase() };
  }
  async function simplifyEffects(effects) {
    if (!isList(effects)) return void 0;
    const vis = effects.filter((e) => e.visible !== false);
    const out = await Promise.all(
      vis.map(async (e) => {
        const o = effectBody(e);
        if (e.type === "SHADER" && o.type === "shader") await putShaderProperties(o, e.properties, e.propertyMetadata);
        const bv = await resolveBoundMap("boundVariables" in e ? e.boundVariables : void 0);
        if (bv) o.tokens = o.tokens ? { ...o.tokens, ...bv } : bv;
        return o;
      })
    );
    return out.length ? out : void 0;
  }

  // src/text.ts
  var lenUnit = (v) => ({ value: round(v.value), unit: v.unit === "PERCENT" ? "percent" : "px" });
  function lineH(v) {
    if (!v || v === figma.mixed) return void 0;
    if (v.unit === "AUTO") return { unit: "auto" };
    return lenUnit(v);
  }
  function letterS(v) {
    if (!v || v === figma.mixed || !v.value) return void 0;
    return lenUnit(v);
  }
  function decoLen(v) {
    if (!v || v === figma.mixed || v.unit === "AUTO" || typeof v.value !== "number") return void 0;
    return lenUnit(v);
  }
  function fontObj(src) {
    const f = {};
    f.size = src.fontSize !== figma.mixed ? src.fontSize : "mixed";
    if (src.fontName && src.fontName !== figma.mixed) {
      f.family = src.fontName.family;
      f.weight = src.fontName.style;
      const vs = src.fontName.variationSettings;
      if (vs && Object.keys(vs).length) f.variationSettings = { ...vs };
    }
    if (typeof src.fontWeight === "number") f.weightValue = src.fontWeight;
    if (src.fontStyle === "ITALIC") f.fontStyle = "italic";
    const lh = lineH(src.lineHeight);
    if (lh) f.lineHeight = lh;
    const ls = letterS(src.letterSpacing);
    if (ls) f.letterSpacing = ls;
    if (src.textCase && src.textCase !== figma.mixed && src.textCase !== "ORIGINAL") f.case = lower(src.textCase);
    if (src.textDecoration && src.textDecoration !== figma.mixed && src.textDecoration !== "NONE") f.decoration = lower(src.textDecoration);
    if (f.decoration) {
      if (src.textDecorationStyle && src.textDecorationStyle !== figma.mixed && src.textDecorationStyle !== "SOLID") f.decorationStyle = String(src.textDecorationStyle).toLowerCase();
      const tdc = src.textDecorationColor && src.textDecorationColor !== figma.mixed ? src.textDecorationColor.value : void 0;
      const dc = solidFromFills(tdc && tdc !== "AUTO" ? [tdc] : void 0);
      if (dc) f.decorationColor = dc;
      const th = decoLen(src.textDecorationThickness);
      if (th) f.decorationThickness = th;
      const off = decoLen(src.textDecorationOffset);
      if (off) f.decorationOffset = off;
      if (src.textDecorationSkipInk === false) f.decorationSkipInk = false;
    }
    const feats = src.openTypeFeatures;
    if (feats && feats !== figma.mixed) {
      const on = Object.keys(feats).filter((k) => feats[k]);
      if (on.length) f.openType = on;
    }
    const color = solidFromFills(src.fills);
    if (color) f.color = color;
    return f;
  }
  var TEXT_SEG_FIELDS = [
    "fontName",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textCase",
    "textDecoration",
    "textDecorationStyle",
    "textDecorationColor",
    "textDecorationThickness",
    "textDecorationOffset",
    "textDecorationSkipInk",
    "fills",
    "hyperlink",
    "listOptions",
    "indentation",
    "listSpacing",
    "openTypeFeatures",
    "textStyleId",
    "fillStyleId",
    "boundVariables",
    "textWrapStyle",
    "fontStyle",
    "paragraphIndent",
    "paragraphSpacing",
    "textStyleOverrides"
  ];
  function overrideName(o) {
    if (typeof o === "string") return o;
    if (o !== null && typeof o === "object" && "type" in o && typeof o.type === "string") return o.type;
    return void 0;
  }
  function styleOverrides(s) {
    const ov = s.textStyleOverrides;
    if (!s.textStyleId || !Array.isArray(ov) || !ov.length) return void 0;
    const names = [];
    for (const o of ov) {
      const n = overrideName(o);
      if (n !== void 0) names.push(n.toLowerCase());
    }
    return names.length ? names : void 0;
  }
  function inlineExtras(src, out) {
    const hl = src.hyperlink;
    if (hl && hl !== figma.mixed && hl.value) {
      if (hl.type === "NODE") out.linkNode = hl.value;
      else out.href = hl.value;
    }
    const lo = src.listOptions;
    if (lo && lo !== figma.mixed && lo.type && lo.type !== "NONE") out.list = lo.type.toLowerCase();
    if (typeof src.indentation === "number" && src.indentation) out.indent = src.indentation;
  }
  async function serializeText(node) {
    const out = { text: node.characters };
    let segs;
    try {
      segs = node.getStyledTextSegments(TEXT_SEG_FIELDS);
    } catch (e) {
      segs = void 0;
    }
    let font;
    const s0 = segs && segs[0];
    if (segs && segs.length > 1 && s0) {
      const wrapMixed = "textWrapStyle" in node && node.textWrapStyle === figma.mixed;
      const spacingMixed = "paragraphSpacing" in node && node.paragraphSpacing === figma.mixed;
      const indentMixed = "paragraphIndent" in node && node.paragraphIndent === figma.mixed;
      out.runs = await Promise.all(
        segs.map(async (s) => {
          const r = { text: s.characters, font: fontObj(s) };
          inlineExtras(s, r);
          const [ts, fs, bv] = await Promise.all([styleName(s.textStyleId), styleName(s.fillStyleId), resolveBoundMap(s.boundVariables)]);
          if (ts) r.textStyle = ts;
          if (fs) r.fillStyle = fs;
          if (bv) r.tokens = bv;
          if (wrapMixed && typeof s.textWrapStyle === "string" && s.textWrapStyle !== "AUTO") r.textWrap = lower(s.textWrapStyle);
          if (spacingMixed && typeof s.paragraphSpacing === "number" && s.paragraphSpacing) r.paragraphSpacing = s.paragraphSpacing;
          if (indentMixed && typeof s.paragraphIndent === "number" && s.paragraphIndent) r.paragraphIndent = s.paragraphIndent;
          const ov = styleOverrides(s);
          if (ov) r.textStyleOverrides = ov;
          return r;
        })
      );
      font = out.font = fontObj(s0);
    } else {
      font = out.font = fontObj(s0 ? s0 : node);
      const bv = await resolveBoundMap(s0 ? s0.boundVariables : void 0);
      if (bv) out.textTokens = bv;
      inlineExtras(s0 || node, out);
      const ov = s0 ? styleOverrides(s0) : void 0;
      if (ov) out.textStyleOverrides = ov;
    }
    if ("textAlignHorizontal" in node && node.textAlignHorizontal) font.align = lower(node.textAlignHorizontal);
    if ("paragraphSpacing" in node && typeof node.paragraphSpacing === "number" && node.paragraphSpacing) font.paragraphSpacing = node.paragraphSpacing;
    if ("paragraphIndent" in node && typeof node.paragraphIndent === "number" && node.paragraphIndent) font.paragraphIndent = node.paragraphIndent;
    if ("listSpacing" in node && typeof node.listSpacing === "number" && node.listSpacing) font.listSpacing = node.listSpacing;
    if ("leadingTrim" in node && node.leadingTrim && node.leadingTrim !== figma.mixed && node.leadingTrim !== "NONE") font.leadingTrim = node.leadingTrim.toLowerCase();
    if ("textAlignVertical" in node && node.textAlignVertical && node.textAlignVertical !== "TOP") font.valign = lower(node.textAlignVertical);
    if ("textWrapStyle" in node) {
      const tw = node.textWrapStyle;
      if (typeof tw === "string" && tw !== "AUTO") font.textWrap = lower(tw);
    }
    if ("hangingList" in node && node.hangingList === true) font.hangingList = true;
    if ("hangingPunctuation" in node && node.hangingPunctuation === true) font.hangingPunctuation = true;
    if ("type" in node && node.type === "TEXT") {
      if (node.textAutoResize && node.textAutoResize !== "NONE") out.autoResize = lower(node.textAutoResize);
      if (node.textTruncation === "ENDING") out.truncate = true;
      if (typeof node.maxLines === "number" && node.maxLines) out.maxLines = node.maxLines;
    }
    if (node.hasMissingFont === true) {
      out.missingFont = true;
      const name = "name" in node ? node.name : void 0;
      const id = "id" in node ? node.id : void 0;
      run().warnKind("missing font \u2014 Figma is substituting a fallback; the recorded family may differ from the render", name + " (" + id + ")");
    }
    if ("width" in node && node.width === 0) {
      const name = "name" in node ? node.name : void 0;
      const id = "id" in node ? node.id : void 0;
      run().warnKind("zero-width text node (possible collapsed thread)", name + " (" + id + ")");
    }
    return out;
  }

  // src/prototype.ts
  function simplifyTransition(tr) {
    const t = { ...ifDefined("type", tr.type ? tr.type.toLowerCase() : void 0) };
    if ("direction" in tr) {
      t.direction = tr.direction.toLowerCase();
      t.matchLayers = tr.matchLayers;
    }
    t.duration = tr.duration;
    const ez = tr.easing;
    if (ez && ez.type) {
      t.easing = ez.type.toLowerCase();
      Object.assign(t, easingCurve(ez));
    }
    return t;
  }
  async function simplifyVariableData(vd) {
    if (!vd || typeof vd !== "object") return vd;
    const v = "value" in vd ? vd.value : vd;
    if (isVariableAlias(v)) {
      return { token: await run().varName(v.id) || v.id };
    }
    return v;
  }
  var isAction = (a) => !!a;
  async function serializeAction(a) {
    if (!a) return null;
    const ao = { type: (a.type || "").toLowerCase() };
    if (a.type === "URL") {
      ao.url = a.url;
      if (a.openInNewTab === true) ao.openInNewTab = true;
    } else if (a.type === "UPDATE_MEDIA_RUNTIME") {
      if (a.destinationId) {
        ao.destinationId = a.destinationId;
        const dn = await run().nodeName(a.destinationId);
        if (dn) ao.destination = dn;
      }
      ao.mediaAction = String(a.mediaAction).toLowerCase();
      if (a.mediaAction === "SKIP_FORWARD" || a.mediaAction === "SKIP_BACKWARD") ao.amountToSkip = a.amountToSkip;
      if (a.mediaAction === "SKIP_TO") ao.newTimestamp = a.newTimestamp;
    } else if (a.type === "SET_VARIABLE") {
      if (a.variableId) ao.variable = await run().varName(a.variableId) || a.variableId;
      if (a.variableValue != null) ao.value = await simplifyVariableData(a.variableValue);
    } else if (a.type === "SET_VARIABLE_MODE") {
      if (a.variableCollectionId) {
        const c = await run().collection(a.variableCollectionId);
        ao.collection = c ? c.name : a.variableCollectionId;
        if (a.variableModeId) {
          const m = c && Array.isArray(c.modes) ? c.modes.find((x) => x.modeId === a.variableModeId) : null;
          ao.mode = m ? m.name : a.variableModeId;
        }
      }
    } else if (a.type === "CONDITIONAL") {
      ao.conditionalBlocks = await Promise.all(
        a.conditionalBlocks.map(async (blk) => {
          const b = {};
          if (blk.condition) b.condition = await simplifyVariableData(blk.condition);
          if (Array.isArray(blk.actions)) b.actions = (await Promise.all(blk.actions.map(serializeAction))).filter(isAction);
          return b;
        })
      );
    } else if (a.type === "NODE") {
      if (a.destinationId) {
        ao.destinationId = a.destinationId;
        const dn = await run().nodeName(a.destinationId);
        if (dn) ao.destination = dn;
      }
      if (a.navigation) ao.navigation = a.navigation.toLowerCase();
      if (a.preserveScrollPosition === true) ao.preserveScroll = true;
      if (a.resetScrollPosition === true) ao.resetScroll = true;
      if (a.resetVideoPosition === true) ao.resetVideo = true;
      if (a.resetInteractiveComponents === true) ao.resetInteractive = true;
      if (a.overlayRelativePosition) ao.overlayOffset = xy(a.overlayRelativePosition);
      if (a.transition) ao.transition = simplifyTransition(a.transition);
    }
    return ao;
  }
  async function simplifyReactions(node) {
    if (!("reactions" in node)) return void 0;
    const reactions = node.reactions;
    if (!isList(reactions) || !reactions.length) return void 0;
    const out = [];
    for (const r of reactions) {
      const o = {};
      if (r.trigger) {
        const tg = r.trigger;
        o.trigger = tg.type ? tg.type.toLowerCase() : "unknown";
        if (tg.type === "AFTER_TIMEOUT") o.timeout = tg.timeout;
        if (tg.type === "MOUSE_UP" || tg.type === "MOUSE_DOWN" || tg.type === "MOUSE_ENTER" || tg.type === "MOUSE_LEAVE") o.delay = tg.delay;
        if (tg.type === "ON_KEY_DOWN") {
          if (tg.keyCodes.length) o.keyCodes = [...tg.keyCodes];
          o.device = String(tg.device).toLowerCase();
        }
        if (tg.type === "ON_MEDIA_HIT") o.mediaHitTime = tg.mediaHitTime;
      }
      const actions = isList(r.actions) ? r.actions : r.action ? [r.action] : [];
      const acts = (await Promise.all(actions.map(serializeAction))).filter(isAction);
      if (acts.length) o.actions = acts;
      if (o.trigger || o.actions) out.push(o);
    }
    return out.length ? out : void 0;
  }

  // ../bridge/src/instance-overrides.ts
  var OVERRIDE_CAP = 100;

  // src/libraries.ts
  var UNKNOWN_LIBRARY = "unknown-library";
  function readRegistry(sink) {
    try {
      const root = figma.root;
      const raw = typeof root.getPluginData === "function" && root.getPluginData("libraryRegistry");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out = {};
      for (const k of Object.keys(parsed)) {
        const v = parsed[k];
        if (typeof v === "string" && v) out[k] = v;
      }
      return out;
    } catch (e) {
      sink("library registry (document pluginData 'libraryRegistry') is unreadable (" + errMsg(e) + ") \u2014 remote components stay unattributed");
      return {};
    }
  }
  async function allInstances(sink) {
    await loadAllPages("library component scan may be incomplete", sink);
    const out = [];
    const prevSkip = figma.skipInvisibleInstanceChildren;
    try {
      try {
        figma.skipInvisibleInstanceChildren = true;
      } catch (e) {
      }
      for (const page of figma.root.children) {
        try {
          out.push(...page.findAllWithCriteria({ types: ["INSTANCE"] }));
        } catch (e) {
          sink("library scan: page '" + page.name + "' could not be traversed (" + errMsg(e) + ") \u2014 its library components are missing");
        }
      }
    } finally {
      try {
        figma.skipInvisibleInstanceChildren = prevSkip;
      } catch (e) {
      }
    }
    return out;
  }
  async function mainOf(inst) {
    try {
      return await inst.getMainComponentAsync();
    } catch (e) {
      return null;
    }
  }
  function mainNames(main) {
    const parent = main.parent || null;
    if (parent && parent.type === "COMPONENT_SET") return { name: parent.name, variantOf: main.name };
    return { name: main.name };
  }
  function tryDefinitions(main) {
    try {
      const defs = main.componentPropertyDefinitions;
      if (!defs || !Object.keys(defs).length) return void 0;
      const props = {};
      for (const [k, d] of Object.entries(defs)) {
        const p = { key: k, type: propType(d.type) };
        if (d.type === "VARIANT" && Array.isArray(d.variantOptions)) p.options = d.variantOptions;
        if (d.defaultValue !== void 0) p.default = d.defaultValue;
        if (d.type === "INSTANCE_SWAP" && Array.isArray(d.preferredValues) && d.preferredValues.length) {
          p.preferredValues = d.preferredValues.map((v) => ({ type: v.type, key: v.key }));
        }
        if (d.description) p.description = d.description;
        props[propName(k)] = p;
      }
      return nonEmpty(props);
    } catch (e) {
      return void 0;
    }
  }
  function aggregateFromInstances(instances) {
    const props = {};
    for (const inst of instances) {
      let cp;
      try {
        cp = inst.componentProperties;
      } catch (e) {
        continue;
      }
      if (!cp) continue;
      for (const k of Object.keys(cp)) {
        const v = cp[k];
        if (!v) continue;
        const name = propName(k);
        const p = props[name] || (props[name] = { key: k, type: propType(v.type), observed: [] });
        if (v.value !== void 0 && p.observed.indexOf(v.value) === -1) p.observed.push(v.value);
      }
    }
    return nonEmpty(props);
  }
  async function collectLibraryComponents(sinkIn) {
    const sink = sinkIn || ((m) => run().warn(m));
    const registry = readRegistry(sink);
    const instances = await allInstances(sink);
    const mains = await Promise.all(instances.map((i) => mainOf(i)));
    const byKey = /* @__PURE__ */ new Map();
    let unkeyed = 0;
    for (const [i, inst] of instances.entries()) {
      const main = mains[i];
      if (!main) continue;
      if (!main.remote) continue;
      const key = main.key;
      if (!key) {
        unkeyed++;
        continue;
      }
      const bucket = byKey.get(key);
      if (bucket) bucket.instances.push(inst);
      else byKey.set(key, { main, instances: [inst] });
    }
    if (unkeyed) sink(unkeyed + " remote component instance(s) have a main component with no publish key \u2014 omitted from the library catalog");
    const out = [];
    for (const [key, bucket] of byKey) {
      const names = mainNames(bucket.main);
      const entry = {
        name: names.name,
        key,
        type: "COMPONENT",
        remote: true,
        source: registry[key] || UNKNOWN_LIBRARY,
        uses: bucket.instances.length
        // how many instances of it are in THIS file
      };
      if (names.variantOf) entry.variant = names.variantOf;
      if (bucket.main.description) entry.description = bucket.main.description;
      const defs = tryDefinitions(bucket.main);
      if (defs) {
        entry.props = defs;
        entry.derivedFrom = "definitions";
      } else {
        const observed = aggregateFromInstances(bucket.instances);
        if (observed) entry.props = observed;
        entry.derivedFrom = "instances";
      }
      out.push(entry);
    }
    return out;
  }
  async function libraryVariableCollections(sink) {
    const byLibrary = /* @__PURE__ */ new Map();
    let collections = [];
    try {
      collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    } catch (e) {
      sink(
        "team-library variables unavailable (" + errMsg(e) + ') \u2014 needs manifest permissions:["teamlibrary"] and a plan with shared libraries; library COMPONENTS below are unaffected'
      );
      return byLibrary;
    }
    if (!collections || !collections.length) {
      sink(
        "no team libraries are enabled for this file, so no library VARIABLE collections are listed \u2014 any rows below come from this file itself or from components it consumes. Enable libraries in Figma (Assets > Libraries) if you expected more; an empty list here is normal, not a failure"
      );
      return byLibrary;
    }
    const counts = await Promise.all(
      collections.map(async (c) => {
        try {
          const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
          return vars ? vars.length : 0;
        } catch (e) {
          sink("library collection '" + c.name + "': variables could not be listed (" + errMsg(e) + ") \u2014 count omitted");
          return void 0;
        }
      })
    );
    for (const [i, c] of collections.entries()) {
      const lib = c.libraryName || UNKNOWN_LIBRARY;
      const entry = { key: c.key, name: c.name };
      const count = counts[i];
      if (count !== void 0) entry.variableCount = count;
      const list = byLibrary.get(lib);
      if (list) list.push(entry);
      else byLibrary.set(lib, [entry]);
    }
    return byLibrary;
  }
  async function listLibraries() {
    const warnings = [];
    const sink = (m) => warnings.push(m);
    const [varsByLibrary, components] = await Promise.all([
      libraryVariableCollections(sink),
      collectLibraryComponents(sink).catch((e) => {
        sink("library component scan failed (" + errMsg(e) + ") \u2014 component counts are missing, variable collections below are unaffected");
        return [];
      })
    ]);
    const compBySource = /* @__PURE__ */ new Map();
    for (const c of components) {
      const src = c.source || UNKNOWN_LIBRARY;
      compBySource.set(src, (compBySource.get(src) || 0) + 1);
    }
    const libraries = [];
    const localCollections = [];
    try {
      const [colls, vars] = await Promise.all([
        figma.variables.getLocalVariableCollectionsAsync(),
        figma.variables.getLocalVariablesAsync()
      ]);
      const perColl = /* @__PURE__ */ new Map();
      for (const v of vars) perColl.set(v.variableCollectionId, (perColl.get(v.variableCollectionId) || 0) + 1);
      for (const c of colls) localCollections.push({ key: c.key || c.id, name: c.name, variableCount: perColl.get(c.id) || 0 });
    } catch (e) {
      sink("local variable collections could not be listed (" + errMsg(e) + ")");
    }
    libraries.push({
      key: figma.fileKey || "local",
      name: figma.root && figma.root.name || "(this file)",
      kind: "local",
      variableCollections: localCollections,
      // no componentCount: local components are enumerated properly by the design-system catalog
      note: "this file \u2014 its local components are listed in full by the design-system export, not counted here"
    });
    const seenSources = /* @__PURE__ */ new Set();
    for (const [libName, collections] of varsByLibrary) {
      seenSources.add(libName);
      const componentCount = compBySource.get(libName);
      const firstCollection = collections[0];
      libraries.push({
        key: firstCollection ? firstCollection.key : libName,
        // libraries themselves have no key — a collection key is the closest stable handle
        name: libName,
        kind: "library",
        variableCollections: collections,
        ...ifDefined("componentCount", componentCount),
        note: componentCount === void 0 ? "variable collections are complete; component attribution is impossible via the API \u2014 any components from this library are counted under '" + UNKNOWN_LIBRARY + "'" : "componentCount counts components USED IN THIS FILE (attributed by the local registry), not everything the library offers \u2014 library components cannot be enumerated"
      });
    }
    for (const [source, count] of compBySource) {
      if (seenSources.has(source)) continue;
      libraries.push({
        key: source,
        name: source,
        kind: "library",
        variableCollections: [],
        componentCount: count,
        note: source === UNKNOWN_LIBRARY ? "components consumed from published libraries that the API cannot attribute to a source (only VARIABLES carry a libraryName). componentCount counts DISTINCT components USED IN THIS FILE, not what any library offers." : "componentCount counts components USED IN THIS FILE (attributed by the local registry), not everything the library offers"
      });
    }
    return { exportedAt: exportedAt(), ...ifDefined("file", figma.root && figma.root.name || void 0), libraries, warnings };
  }

  // src/motion.ts
  function keyframeValue(kv) {
    if (!kv || typeof kv !== "object") return kv;
    switch (kv.type) {
      case "FLOAT":
        return round(kv.value);
      case "COLOR":
        return kv.value ? rgbaToHex(kv.value) : void 0;
      case "VECTOR":
        return kv.value ? { ...xy(kv.value) } : void 0;
      case "CIRCLE":
        return kv.value ? { ...xy(kv.value), radius: round(kv.value.radius) } : void 0;
      case "LINE":
        return kv.value ? { ...xy(kv.value), x2: round(kv.value.x2), y2: round(kv.value.y2) } : void 0;
      case "BOOL":
      case "TEXT_DATA":
      case "CIRCLE_POINT":
        return kv.value;
      // no transformation needed
      // RGBA is an interface (no index signature), so the colour is re-spread into a plain object literal —
      // same keys, same order, same JSON.
      case "COLOR_POINT": {
        const cp = kv.value;
        return cp ? { ...cp, color: { ...cp.color } } : asJson(cp);
      }
      default: {
        const unknownMember = kv;
        return asJson(unknownMember.value);
      }
    }
  }
  async function aliasValue2(id) {
    return { aliasOf: await run().varName(id) || id };
  }
  async function motionEasing(ez) {
    if (!ez || !ez.type) return void 0;
    if (ez.type === "VARIABLE_ALIAS") return aliasValue2(ez.id);
    return { type: String(ez.type).toLowerCase(), ...easingCurve(ez) };
  }
  async function keyframes(list) {
    if (!isList(list) || !list.length) return void 0;
    return Promise.all(list.map(async (k) => {
      const o = { t: round(k.timelinePosition), ...ifDefined("value", keyframeValue(k.value)) };
      const ez = await motionEasing(k.easing);
      if (ez) o.easing = ez;
      return o;
    }));
  }
  async function manualTrack(binding) {
    if (!binding || typeof binding !== "object") return void 0;
    const o = {};
    const base = keyframeValue(binding.baseValue);
    if (base !== void 0) o.base = base;
    const kf = await keyframes(binding.keyframes);
    if (kf) o.keyframes = kf;
    return o;
  }
  async function animationTrack(binding) {
    if (!binding || typeof binding !== "object") return void 0;
    const o = {};
    const base = keyframeValue(binding.baseValue);
    if (base !== void 0) o.base = base;
    if (typeof binding.timelineDuration === "number") o.duration = round(binding.timelineDuration);
    if (isList(binding.tracks) && binding.tracks.length) {
      o.tracks = await Promise.all(binding.tracks.map(async (t) => {
        const to = {};
        if (t.keyframeOperation === "OFFSET" || t.keyframeOperation === "SCALE") to.op = t.keyframeOperation === "OFFSET" ? "offset" : "scale";
        const kf = await keyframes(t.keyframes);
        if (kf) to.keyframes = kf;
        return to;
      }));
    }
    return o;
  }
  async function stylePropValue(v) {
    if (v === void 0 || v === null) return void 0;
    if (typeof v === "object") return motionEasing(v);
    return v;
  }
  function isPropertyBindings(t) {
    return "properties" in t;
  }
  async function bindingMap(map, conv) {
    if (!map || typeof map !== "object") return void 0;
    const entries = Object.entries(map);
    const converted = await Promise.all(entries.map(([, binding]) => conv(binding)));
    const out = {};
    entries.forEach(([key], i) => putNonEmpty(out, key, converted[i]));
    return nonEmpty(out);
  }
  async function paintMap(map, conv) {
    if (!map || typeof map !== "object") return void 0;
    const out = {};
    for (const [index, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== "object") continue;
      if (isPropertyBindings(entry)) {
        const properties = await bindingMap(entry.properties, conv);
        if (properties) out[index] = { properties };
      } else {
        putNonEmpty(out, index, await conv(entry));
      }
    }
    return nonEmpty(out);
  }
  async function effectMap(map, conv) {
    if (!map || typeof map !== "object") return void 0;
    const out = {};
    for (const [index, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== "object") continue;
      const { properties, ...fields } = entry;
      const extra = {};
      putNonEmpty(extra, "properties", await bindingMap(properties, conv));
      putNonEmpty(out, index, Object.assign(await bindingMap(fields, conv) || {}, extra));
    }
    return nonEmpty(out);
  }
  async function motionMap(map, conv) {
    if (!map || typeof map !== "object") return void 0;
    const { fills, strokes, effects, ...scalars } = map;
    const indexed = {};
    putNonEmpty(indexed, "fills", await paintMap(fills, conv));
    putNonEmpty(indexed, "strokes", await paintMap(strokes, conv));
    putNonEmpty(indexed, "effects", await effectMap(effects, conv));
    return nonEmpty(Object.assign(await bindingMap(scalars, conv) || {}, indexed));
  }
  async function collectMotion(node) {
    const out = {};
    if ("timelines" in node && isList(node.timelines) && node.timelines.length) {
      out.timelines = node.timelines.map((t) => ({ id: t.id, duration: round(t.duration) }));
    }
    if ("manualKeyframeTracks" in node) {
      const tracks = await motionMap(node.manualKeyframeTracks, manualTrack);
      if (tracks) out.manualTracks = tracks;
    }
    if ("animations" in node) {
      const anims = await motionMap(node.animations, animationTrack);
      if (anims) out.animations = anims;
    }
    if ("animationStyles" in node && isList(node.animationStyles) && node.animationStyles.length) {
      out.styles = await Promise.all(node.animationStyles.map(async (s) => {
        const kind = s.type;
        if (typeof kind === "string" && kind !== "" && kind !== "FIGMA" && kind !== "CUSTOM") return unknownKindStyle(s, kind);
        if (s.type === "CUSTOM") {
          const o = { id: s.id, name: s.name, styleId: s.styleId, custom: true };
          if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
          return Object.assign(o, await customStyleDetail(s.styleId));
        }
        return animationStyleEntry(s);
      }));
    }
    return nonEmpty(out);
  }
  function unknownKindStyle(s, kind) {
    const fields = s;
    const o = {};
    if (typeof fields.id === "string") o.id = fields.id;
    if (typeof fields.name === "string") o.name = fields.name;
    if (typeof fields.styleId === "string") o.styleId = fields.styleId;
    o.kind = kind.toLowerCase();
    if (typeof fields.timelineOffset === "number" && fields.timelineOffset) o.timelineOffset = round(fields.timelineOffset);
    return o;
  }
  async function animationStyleEntry(s) {
    const o = { id: s.id, name: s.name, styleId: s.styleId };
    if (typeof s.description === "string" && s.description) o.description = s.description;
    if (typeof s.duration === "number") o.duration = round(s.duration);
    if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
    if (s.props) {
      const entries = Object.entries(s.props);
      const converted = await Promise.all(entries.map(([, v]) => stylePropValue(v)));
      const props = {};
      entries.forEach(([key], i) => {
        const c = converted[i];
        if (c !== void 0) props[key] = c;
      });
      if (Object.keys(props).length) o.props = props;
    }
    return o;
  }
  async function customAnimationEntries(style) {
    try {
      const list = style.animationEntries;
      if (!isList(list)) return void 0;
      return await Promise.all(list.map(animationStyleEntry));
    } catch (e) {
      return void 0;
    }
  }
  async function customStyleDetail(styleId) {
    const style = await run().styleName.obj(styleId);
    if (!style || style.type !== "CUSTOM_ANIMATION") return {};
    try {
      const detail = {};
      if (typeof style.description === "string" && style.description) detail.description = style.description;
      const entries = await customAnimationEntries(style);
      if (entries) detail.entries = entries;
      return detail;
    } catch (e) {
      return {};
    }
  }

  // src/components.ts
  async function instanceComponentRef(node) {
    if (node.type !== "INSTANCE") return void 0;
    try {
      const main = await node.getMainComponentAsync();
      if (!main) return void 0;
      const ref = { name: main.name };
      if (main.id) ref.id = main.id;
      if (main.key) ref.key = main.key;
      if (main.remote) ref.remote = true;
      const parent = main.parent;
      if (parent && parent.type === "COMPONENT_SET") {
        ref.setId = parent.id;
        if (parent.key) ref.setKey = parent.key;
        ref.setName = parent.name;
        ref.variant = main.name;
      }
      return ref;
    } catch (e) {
      return void 0;
    }
  }
  var PROP_REF_KEYS = ["visible", "characters", "mainComponent"];
  function componentPropRefs(node) {
    if (!("componentPropertyReferences" in node)) return void 0;
    const refs = node.componentPropertyReferences;
    if (!refs) return void 0;
    const out = {};
    for (const k of PROP_REF_KEYS) {
      const ref = refs[k];
      if (ref) out[k] = propName(ref);
    }
    return nonEmpty(out);
  }
  function instanceOverrides(node) {
    if (node.type !== "INSTANCE") return void 0;
    const overrides = node.overrides;
    if (!Array.isArray(overrides) || !overrides.length) return void 0;
    const list = overrides.filter((o) => o && Array.isArray(o.overriddenFields) && o.overriddenFields.length).map((o) => ({ id: o.id, fields: o.overriddenFields }));
    if (!list.length) return void 0;
    if (list.length > OVERRIDE_CAP) {
      run().warn("instance '" + node.name + "' has " + list.length + " overrides \u2014 truncated to " + OVERRIDE_CAP);
      return list.slice(0, OVERRIDE_CAP);
    }
    return list;
  }
  var VISUAL_CORNER_KEYS = [
    ["topLeftRadius", "tl"],
    ["topRightRadius", "tr"],
    ["bottomRightRadius", "br"],
    ["bottomLeftRadius", "bl"]
  ];
  async function simplifyVisuals(node) {
    const out = {};
    const [fills, strokes, effects] = await Promise.all([
      simplifyFills("fills" in node ? node.fills : void 0),
      simplifyStrokes(node),
      simplifyEffects("effects" in node ? node.effects : void 0)
    ]);
    if (fills) out.fills = fills;
    if (strokes) out.strokes = strokes;
    if (effects) out.effects = effects;
    if ("cornerRadius" in node) {
      if (node.cornerRadius !== figma.mixed && node.cornerRadius) out.radius = node.cornerRadius;
      else if (node.cornerRadius === figma.mixed) {
        const corners = {};
        for (const [k, s] of VISUAL_CORNER_KEYS) {
          if (!(k in node)) continue;
          const r = node[k];
          if (typeof r === "number" && r) corners[s] = r;
        }
        putNonEmpty(out, "radius", corners);
      }
    }
    if ("opacity" in node && typeof node.opacity === "number" && node.opacity < 1) out.opacity = round(node.opacity);
    if ("blendMode" in node && node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") out.blendMode = String(node.blendMode).toLowerCase();
    return nonEmpty(out);
  }
  function variantValues(main) {
    try {
      if (main.variantProperties && Object.keys(main.variantProperties).length) return { ...main.variantProperties };
    } catch (e) {
    }
    const name = main.name || "";
    const out = {};
    for (const part of name.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k && v) out[k] = v;
    }
    return nonEmpty(out);
  }
  var VARIANT_WALK_DEPTH = 3;
  function serializeVariant(main, serialize2) {
    return serialize2(main, 60 - VARIANT_WALK_DEPTH, void 0, void 0, void 0, "none");
  }
  async function collectComponentCatalog(hygiene, asLibrary, serialize2) {
    const variantVisuals = run().reads.variantVisuals;
    const components = [];
    const pendingPublish = [];
    const seenNames = /* @__PURE__ */ new Set();
    const variantsBySet = /* @__PURE__ */ new Map();
    const entriesBySetId = /* @__PURE__ */ new Map();
    const standalone = [];
    const prevSkip = figma.skipInvisibleInstanceChildren;
    try {
      try {
        figma.skipInvisibleInstanceChildren = true;
      } catch (e) {
      }
      const catalogPages = figma.root.children;
      let catalogIndex = 0;
      for (const page of catalogPages) {
        checkCancelled();
        enterPage("design-system", ++catalogIndex, catalogPages.length, page.name, page.id, { components: components.length });
        let nodes = [];
        try {
          nodes = page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
        } catch (e) {
          run().warn("component catalog: page '" + page.name + "' could not be traversed (" + errMsg(e) + ") \u2014 its components are missing");
          continue;
        }
        for (const n of nodes) {
          if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") {
            if (variantVisuals) {
              const list = variantsBySet.get(n.parent.id);
              if (list) list.push(n);
              else variantsBySet.set(n.parent.id, [n]);
            }
            continue;
          }
          const entry = { name: n.name, id: n.id, type: n.type, page: page.name, pageId: page.id };
          if (n.description) entry.description = n.description;
          if (n.remote) entry.remote = true;
          if (n.key) entry.key = n.key;
          if (isList(n.documentationLinks) && n.documentationLinks.length) entry.docs = n.documentationLinks.map((d) => d.uri).filter(Boolean);
          try {
            const defs = n.componentPropertyDefinitions;
            if (defs && Object.keys(defs).length) {
              const props = {};
              entry.props = props;
              let variantCombos = 1;
              const defEntries = Object.entries(defs);
              const boundPerKey = await Promise.all(defEntries.map(([, d]) => resolveBoundMap(d.boundVariables)));
              for (const [i, [k, d]] of defEntries.entries()) {
                const p = { key: k, type: propType(d.type) };
                if (d.type === "VARIANT") {
                  if (d.variantOptions !== void 0) p.options = d.variantOptions;
                  variantCombos *= d.variantOptions ? d.variantOptions.length : 1;
                }
                if (d.defaultValue !== void 0) p.default = d.defaultValue;
                if ((d.type === "INSTANCE_SWAP" || d.type === "SLOT") && Array.isArray(d.preferredValues) && d.preferredValues.length) {
                  p.preferredValues = d.preferredValues.map((v) => ({ type: v.type, key: v.key }));
                }
                if (d.description) p.description = d.description;
                if (d.type === "SLOT" && d.slotSettings) {
                  const ss = d.slotSettings;
                  const slot = {};
                  if (typeof ss.stretchChildOnInsert === "boolean") slot.stretchChildOnInsert = ss.stretchChildOnInsert;
                  if (typeof ss.displayEmptyByDefault === "boolean") slot.displayEmptyByDefault = ss.displayEmptyByDefault;
                  if (typeof ss.minChildren === "number") slot.minChildren = ss.minChildren;
                  if (typeof ss.maxChildren === "number") slot.maxChildren = ss.maxChildren;
                  if (typeof ss.allowPreferredValuesOnly === "boolean") slot.allowPreferredValuesOnly = ss.allowPreferredValuesOnly;
                  putNonEmpty(p, "slotSettings", slot);
                }
                const dbv = boundPerKey[i];
                if (dbv) p.tokens = dbv;
                props[propName(k)] = p;
              }
              if (variantCombos > 30) hygiene.push("variant explosion: '" + n.name + "' has " + variantCombos + " combinations (>30 \u2014 consider boolean/instance-swap props)");
            }
          } catch (e) {
            run().warn("component '" + n.name + "': property definitions unreadable (" + errMsg(e) + ") \u2014 props omitted");
          }
          if (/^(Component|Frame)\s*\d+$/.test(n.name)) hygiene.push("unnamed component: '" + n.name + "'");
          if (seenNames.has(n.name)) hygiene.push("duplicate component name: '" + n.name + "'");
          seenNames.add(n.name);
          try {
            const visuals = await simplifyVisuals(n);
            if (visuals) entry.visuals = visuals;
          } catch (e) {
            run().warn("component '" + n.name + "': visuals unreadable (" + errMsg(e) + ") \u2014 visuals omitted");
          }
          if (asLibrary) pendingPublish.push({ entry, node: n });
          if (variantVisuals && n.type === "COMPONENT_SET") entriesBySetId.set(n.id, entry);
          if (variantVisuals && n.type === "COMPONENT") standalone.push({ entry, node: n });
          components.push(entry);
        }
      }
    } finally {
      try {
        figma.skipInvisibleInstanceChildren = prevSkip;
      } catch (e) {
      }
    }
    if (serialize2) {
      for (const { entry, node: n } of standalone) {
        try {
          const node = await serializeVariant(n, serialize2);
          if (node) entry.node = node;
        } catch (e) {
          run().warn("component '" + n.name + "': visuals unreadable (" + errMsg(e) + ") \u2014 node tree omitted");
        }
      }
    }
    if (variantVisuals && serialize2 && variantsBySet.size) {
      for (const [setId, variants] of variantsBySet) {
        const entry = entriesBySetId.get(setId);
        if (!entry) continue;
        const out = [];
        for (const v of variants) {
          try {
            const node = await serializeVariant(v, serialize2);
            const o = { id: v.id, name: v.name };
            if (v.key) o.key = v.key;
            const values = variantValues(v);
            if (values) o.values = values;
            if (node) o.node = node;
            out.push(o);
          } catch (e) {
            run().warn("component '" + v.name + "': variant visuals unreadable (" + errMsg(e) + ") \u2014 omitted");
          }
        }
        if (out.length) entry.variants = out;
      }
    }
    if (pendingPublish.length) {
      const statuses = await Promise.all(pendingPublish.map((p) => publishOf(p.node)));
      for (const [i, p] of pendingPublish.entries()) {
        const s = statuses[i];
        if (s) p.entry.publish = s;
      }
    }
    return components;
  }
  async function publishOf(o) {
    try {
      if (!o || typeof o.getPublishStatusAsync !== "function") return void 0;
      const s = await o.getPublishStatusAsync();
      return s ? String(s).toLowerCase() : void 0;
    } catch (e) {
      return void 0;
    }
  }
  async function buildDesignSystem(opts, serialize2) {
    const asLibrary = !!(opts && opts.asLibrary);
    const safeList = async (fn) => {
      try {
        return await fn();
      } catch (e) {
        return [];
      }
    };
    const [paint, text, effect, grid, animation] = await Promise.all([
      safeList(() => figma.getLocalPaintStylesAsync()),
      safeList(() => figma.getLocalTextStylesAsync()),
      safeList(() => figma.getLocalEffectStylesAsync()),
      safeList(() => figma.getLocalGridStylesAsync ? figma.getLocalGridStylesAsync() : Promise.resolve([])),
      safeList(() => figma.getLocalCustomAnimationStylesAsync ? figma.getLocalCustomAnimationStylesAsync() : Promise.resolve([]))
    ]);
    const hygiene = [];
    await loadAllPages("component catalog may be incomplete", (m) => run().warn(m));
    const components = await collectComponentCatalog(hygiene, asLibrary, serialize2);
    if (asLibrary) {
      hygiene.push(
        "library mode: this catalog is the COMPLETE set of components defined in this library file. Publish status is per-object (publish: current | changed | unpublished); Figma exposes no way to list what the last PUBLISHED snapshot contained, so a component deleted here but still live in the library is not visible."
      );
    } else try {
      const seenKeys = new Set(components.map((c) => c.key).filter(Boolean));
      const remote = await collectLibraryComponents((m) => run().warn(m));
      let added = 0;
      for (const entry of remote) {
        if (seenKeys.has(entry.key)) continue;
        seenKeys.add(entry.key);
        components.push(entry);
        added++;
      }
      if (added) {
        hygiene.push(
          added + ' component(s) in this catalog come from a published LIBRARY, not this file \u2014 flagged remote:true. Entries with derivedFrom:"instances" have props INFERRED from the instances present here (a sample, not the complete set).'
        );
      }
    } catch (e) {
      run().warn("library component catalog failed (" + errMsg(e) + ") \u2014 components consumed from published libraries are missing from the catalog");
    }
    let colorProfile;
    try {
      if (figma.root && figma.root.documentColorProfile) colorProfile = String(figma.root.documentColorProfile).toLowerCase();
    } catch (e) {
    }
    const styleMeta = async (s) => {
      const m = {};
      if (s.key) m.key = s.key;
      if (s.id) m.id = s.id;
      if (s.remote) m.remote = true;
      if (isList(s.documentationLinks) && s.documentationLinks.length) {
        m.docs = s.documentationLinks.map((d) => d.uri).filter(Boolean);
      }
      if (asLibrary) {
        const p = await publishOf(s);
        if (p) m.publish = p;
      }
      return m;
    };
    const [paintStyles, textStyles, effectStyles] = await Promise.all([
      // Paint styles carry their ACTUAL colors, not just a name.
      // `tokens` (boundVariables) was read for TEXT styles only, so a paint style bound to a color
      // variable silently lost that link — the binding is what makes it a token rather than a hex.
      Promise.all(paint.map(async (s) => ({ name: s.name, ...ifDefined("paints", await simplifyFills(s.paints)), ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)), ...ifDefined("description", s.description || void 0), ...await styleMeta(s) }))),
      Promise.all(
        text.map(async (s) => ({
          name: s.name,
          size: s.fontSize,
          font: s.fontName && s.fontName.family,
          weight: s.fontName && s.fontName.style,
          ...ifDefined("lineHeight", lineH(s.lineHeight)),
          ...ifDefined("letterSpacing", letterS(s.letterSpacing)),
          ...ifDefined("case", s.textCase && s.textCase !== "ORIGINAL" ? s.textCase.toLowerCase() : void 0),
          ...ifDefined("decoration", s.textDecoration && s.textDecoration !== "NONE" ? s.textDecoration.toLowerCase() : void 0),
          ...ifDefined("paragraphSpacing", s.paragraphSpacing || void 0),
          ...ifDefined("paragraphIndent", s.paragraphIndent || void 0),
          ...ifDefined("leadingTrim", s.leadingTrim && s.leadingTrim !== "NONE" ? String(s.leadingTrim).toLowerCase() : void 0),
          ...ifDefined("listSpacing", s.listSpacing || void 0),
          // TextStyle.textWrapStyle (Plugin API 2026-08-14) — AUTO | BALANCE | PRETTY; AUTO is the
          // default and is skipped. Maps 1:1 onto CSS `text-wrap`. Same read as text.ts's per-node
          // one, minus the mixed guard: a TextStyle is uniform by definition.
          ...ifDefined("textWrap", s.textWrapStyle && s.textWrapStyle !== "AUTO" ? String(s.textWrapStyle).toLowerCase() : void 0),
          ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)),
          ...ifDefined("description", s.description || void 0),
          ...await styleMeta(s)
        }))
      ),
      Promise.all(effect.map(async (s) => ({ name: s.name, ...ifDefined("effects", await simplifyEffects(s.effects)), ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)), ...ifDefined("description", s.description || void 0), ...await styleMeta(s) })))
    ]);
    const styles = {
      paint: paintStyles,
      text: textStyles,
      effect: effectStyles,
      // Layout-grid styles (column/row grids) — the responsive grid tokens. The grid VALUES are sync;
      // the shared catalog meta (key/publish) is not, so the map is fanned out like its three siblings.
      grid: await Promise.all(
        grid.map(async (s) => ({
          name: s.name,
          ...ifDefined("grids", Array.isArray(s.layoutGrids) ? s.layoutGrids.map(simplifyGrid).filter((g) => !!g) : void 0),
          ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)),
          ...ifDefined("description", s.description || void 0),
          ...await styleMeta(s)
        }))
      ),
      // Custom animation styles: the Figma animations each one contains (CustomAnimationStyle.
      // animationEntries), in the same compact form a node's applied animation style takes (motion.ts).
      // Their props can bind EASING variables, so they resolve before dumpVariables too.
      animation: await Promise.all(
        animation.map(async (s) => ({
          name: s.name,
          ...ifDefined("entries", await customAnimationEntries(s)),
          ...ifDefined("description", s.description || void 0),
          ...await styleMeta(s)
        }))
      )
    };
    const vars = await dumpVariables(opts);
    let source;
    if (asLibrary) {
      let fileKey;
      try {
        if (typeof figma.fileKey !== "undefined") fileKey = figma.fileKey || void 0;
      } catch (e) {
      }
      if (!fileKey) hygiene.push("figma.fileKey unavailable \u2014 the library output directory falls back to a name slug, so a RENAMED library will land in a new directory");
      source = {
        role: "library",
        ...ifDefined("libraryName", opts && opts.asLibrary || figma.root && figma.root.name || void 0),
        ...ifDefined("fileKey", fileKey),
        collectionKeys: vars.collections.map((c) => c.key).filter((k) => !!k)
      };
    }
    return {
      exportedAt: exportedAt(),
      ...ifDefined("file", figma.root && figma.root.name || void 0),
      ...ifDefined("source", source),
      ...ifDefined("colorProfile", colorProfile),
      // legacy | srgb | display_p3 — whether emitted colors should be sRGB or wide-gamut
      collections: vars.collections,
      variables: vars.variables,
      styles,
      components,
      hygiene: vars.hygiene.concat(hygiene)
      // variable hygiene first, then component hygiene
    };
  }

  // src/serialize.ts
  var MAX_DEPTH = 60;
  var SIZE_LIMIT_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
  var CORNER_KEYS = [
    ["topLeftRadius", "tl"],
    ["topRightRadius", "tr"],
    ["bottomRightRadius", "br"],
    ["bottomLeftRadius", "bl"]
  ];
  var RADIUS_SENTINEL = 1e4;
  function radiusOut(out, raw) {
    if (raw < RADIUS_SENTINEL) return round(raw);
    out.radiusFull = true;
    const box = out.box;
    const w = box && typeof box.w === "number" ? box.w : void 0;
    const h = box && typeof box.h === "number" ? box.h : void 0;
    if (w === void 0 && h === void 0) return round(raw);
    return round(Math.min(w === void 0 ? Infinity : w, h === void 0 ? Infinity : h) / 2);
  }
  function pluginData(node) {
    let keys = [];
    try {
      keys = node.getPluginDataKeys();
    } catch (e) {
      return void 0;
    }
    if (!keys || !keys.length) return void 0;
    const out = {};
    for (const k of keys) {
      try {
        const v = node.getPluginData(k);
        if (v) out[k] = v;
      } catch (e) {
      }
    }
    return nonEmpty(out);
  }
  var SHARED_NAMESPACES = ["tokens"];
  function sharedData(node) {
    const out = {};
    for (const ns of SHARED_NAMESPACES) {
      let keys = [];
      try {
        keys = node.getSharedPluginDataKeys(ns) || [];
      } catch (e) {
        continue;
      }
      const bucket = {};
      for (const k of keys) {
        try {
          const v = node.getSharedPluginData(ns, k);
          if (v) bucket[k] = v;
        } catch (e) {
        }
      }
      putNonEmpty(out, ns, bucket);
    }
    return nonEmpty(out);
  }
  async function nodeCss(node) {
    try {
      const css = await node.getCSSAsync();
      return css && Object.keys(css).length ? css : void 0;
    } catch (e) {
      return void 0;
    }
  }
  function leaf(out) {
    delete out.layout;
    return out;
  }
  function bakeTransform(out) {
    const st = {};
    if (out.rotation !== void 0) {
      st.rotation = out.rotation;
      delete out.rotation;
    }
    if (out.flipped) {
      st.flipped = true;
      delete out.flipped;
    }
    if (out.skew !== void 0) {
      st.skew = out.skew;
      delete out.skew;
    }
    putNonEmpty(out, "sourceTransform", st);
  }
  async function serialize(node, depth, parentControlsLayout, underHidden, inGrid, assets = "run") {
    checkCancelled();
    const r = run();
    const stats = r.stats;
    if (depth > MAX_DEPTH) {
      stats.truncated++;
      if (stats.truncated === 1) r.warn("depth limit " + MAX_DEPTH + " reached \u2014 deep subtrees truncated (first: " + node.name + ")");
      return null;
    }
    stats.nodes++;
    const out = { type: node.type, name: node.name, id: node.id };
    if ("visible" in node && node.visible === false) out.hidden = true;
    const hidden = !!out.hidden || !!underHidden;
    if (hidden) stats.hiddenNodes++;
    if (node.type === "INSTANCE" && node.componentProperties) {
      const props = {};
      const propTokens = {};
      const propEntries = Object.entries(node.componentProperties);
      const bound = await Promise.all(propEntries.map(([, cp]) => resolveBoundMap(cp.boundVariables)));
      propEntries.forEach(([k, cp], i) => {
        props[propName(k)] = cp.value;
        const bv = bound[i];
        if (bv && bv.value) propTokens[propName(k)] = bv.value;
      });
      putNonEmpty(out, "props", props);
      putNonEmpty(out, "propTokens", propTokens);
    }
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") out.component = node.name;
    const lay = layout(node);
    if (lay) out.layout = lay;
    const absoluteInParent = "layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE";
    if (absoluteInParent) out.absolute = true;
    if ("layoutGrow" in node && node.layoutGrow) out.grow = node.layoutGrow;
    if ("layoutAlign" in node && node.layoutAlign && node.layoutAlign !== "INHERIT") out.alignSelf = lower(node.layoutAlign);
    if ("layoutSizingHorizontal" in node && node.layoutSizingHorizontal && node.layoutSizingHorizontal !== "FIXED") out.widthMode = lower(node.layoutSizingHorizontal);
    if ("layoutSizingVertical" in node && node.layoutSizingVertical && node.layoutSizingVertical !== "FIXED") out.heightMode = lower(node.layoutSizingVertical);
    if ("overflowDirection" in node && node.overflowDirection && node.overflowDirection !== "NONE") out.scroll = lower(node.overflowDirection);
    if (inGrid && !absoluteInParent) {
      if ("gridColumnSpan" in node && typeof node.gridColumnSpan === "number" && node.gridColumnSpan !== 1) out.gridColumnSpan = node.gridColumnSpan;
      if ("gridRowSpan" in node && typeof node.gridRowSpan === "number" && node.gridRowSpan !== 1) out.gridRowSpan = node.gridRowSpan;
      if ("gridColumnAnchorIndex" in node && typeof node.gridColumnAnchorIndex === "number" && node.gridColumnAnchorIndex >= 0) out.gridColumnStart = node.gridColumnAnchorIndex;
      if ("gridRowAnchorIndex" in node && typeof node.gridRowAnchorIndex === "number" && node.gridRowAnchorIndex >= 0) out.gridRowStart = node.gridRowAnchorIndex;
      if ("gridChildHorizontalAlign" in node && node.gridChildHorizontalAlign && node.gridChildHorizontalAlign !== "AUTO") out.gridJustifySelf = GRID_SELF[node.gridChildHorizontalAlign];
      if ("gridChildVerticalAlign" in node && node.gridChildVerticalAlign && node.gridChildVerticalAlign !== "AUTO") out.gridAlignSelf = GRID_SELF[node.gridChildVerticalAlign];
    }
    if ((!parentControlsLayout || absoluteInParent) && "x" in node && typeof node.x === "number") {
      out.x = round(node.x);
      out.y = round(node.y);
    }
    if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
      const b = node.absoluteBoundingBox;
      const box = { w: round(b.width), h: round(b.height) };
      out.box = box;
      if (!parentControlsLayout || absoluteInParent) {
        box.x = round(b.x);
        box.y = round(b.y);
      }
      const rb = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null;
      if (rb && (rb.x !== b.x || rb.y !== b.y || rb.width !== b.width || rb.height !== b.height)) {
        out.renderBox = { ...xy(rb), w: round(rb.width), h: round(rb.height) };
      }
    }
    if ("layoutGrids" in node && Array.isArray(node.layoutGrids) && node.layoutGrids.length) {
      out.layoutGrids = node.layoutGrids.map(simplifyGrid).filter((g) => !!g);
    }
    if ("annotations" in node && isList(node.annotations) && node.annotations.length) {
      out.annotations = node.annotations.map((a) => {
        const o = {};
        if (a.label) o.label = a.label;
        if (a.labelMarkdown) o.markdown = a.labelMarkdown;
        if (a.categoryId) o.categoryId = a.categoryId;
        if (isList(a.properties) && a.properties.length) o.props = a.properties.map((p) => p.type);
        return o;
      });
    }
    if ("devStatus" in node && node.devStatus && node.devStatus.type) {
      out.devStatus = lower(node.devStatus.type);
      if (node.devStatus.description) out.devStatusNote = node.devStatus.description;
    }
    let sizeLimits;
    for (const k of SIZE_LIMIT_KEYS) {
      const v = numProp(node, k);
      if (k in node && typeof v === "number") (sizeLimits || (sizeLimits = {}))[k] = round(v);
    }
    if (sizeLimits) out.sizeLimits = sizeLimits;
    if ("constraints" in node && node.constraints && (node.constraints.horizontal !== "MIN" || node.constraints.vertical !== "MIN")) {
      out.pin = { h: lower(node.constraints.horizontal), v: lower(node.constraints.vertical) };
    }
    if ("numberOfFixedChildren" in node && typeof node.numberOfFixedChildren === "number" && node.numberOfFixedChildren > 0) {
      out.fixedChildren = node.numberOfFixedChildren;
    }
    if ("clipsContent" in node && node.clipsContent) out.clip = true;
    const [fills, strokes, effects] = await Promise.all([
      simplifyFills("fills" in node ? node.fills : void 0),
      simplifyStrokes(node),
      simplifyEffects("effects" in node ? node.effects : void 0)
    ]);
    if (fills) out.fills = fills;
    if (strokes) out.strokes = strokes;
    if ("strokesIncludedInLayout" in node && node.strokesIncludedInLayout) out.strokesInLayout = true;
    if (effects) out.effects = effects;
    if ("cornerRadius" in node) {
      if (node.cornerRadius !== figma.mixed && node.cornerRadius) out.radius = radiusOut(out, node.cornerRadius);
      else if (node.cornerRadius === figma.mixed) {
        const corners = {};
        for (const [k, s] of CORNER_KEYS) {
          const v = numProp(node, k);
          if (k in node && typeof v === "number" && v) corners[s] = radiusOut(out, v);
        }
        putNonEmpty(out, "radius", corners);
      }
    }
    if ("opacity" in node && node.opacity < 1) out.opacity = round(node.opacity);
    if ("rotation" in node && node.rotation) out.rotation = round(node.rotation);
    if ("relativeTransform" in node && Array.isArray(node.relativeTransform) && node.relativeTransform.length === 2) {
      const m = node.relativeTransform;
      const a = m[0][0], c = m[0][1], b = m[1][0], d = m[1][1];
      if (a * d - c * b < 0) out.flipped = true;
      const sx = Math.sqrt(a * a + b * b);
      if (sx > 1e-6) {
        const skewDeg = Math.atan2(a * c + b * d, sx * sx) * 180 / Math.PI;
        if (Math.abs(skewDeg) > 0.01) out.skew = round(skewDeg);
      }
    }
    if ("blendMode" in node && node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") out.blendMode = node.blendMode.toLowerCase();
    if ("isMask" in node && node.isMask) out.mask = true;
    if (out.mask && "maskType" in node && node.maskType && node.maskType !== "ALPHA") out.maskType = String(node.maskType).toLowerCase();
    if ("cornerSmoothing" in node && typeof node.cornerSmoothing === "number" && node.cornerSmoothing) out.cornerSmoothing = round(node.cornerSmoothing);
    if ("targetAspectRatio" in node && node.targetAspectRatio && node.targetAspectRatio.y) out.aspectRatio = round(node.targetAspectRatio.x / node.targetAspectRatio.y);
    if (node.type === "ELLIPSE" && node.arcData) {
      const a = node.arcData;
      const isFull = (!a.startingAngle || a.startingAngle === 0) && Math.abs((a.endingAngle || 0) - Math.PI * 2) < 1e-4 && !a.innerRadius;
      if (!isFull) {
        const arc = {};
        if (typeof a.startingAngle === "number") arc.start = round(a.startingAngle);
        if (typeof a.endingAngle === "number") arc.end = round(a.endingAngle);
        if (typeof a.innerRadius === "number" && a.innerRadius) arc.innerRadius = round(a.innerRadius);
        putNonEmpty(out, "arc", arc);
      }
    }
    if (node.type === "STAR") {
      const shape = {};
      if (typeof node.pointCount === "number") shape.points = node.pointCount;
      if (typeof node.innerRadius === "number") shape.innerRadius = round(node.innerRadius);
      putNonEmpty(out, "shape", shape);
    }
    if (node.type === "POLYGON" && typeof node.pointCount === "number") out.shape = { points: node.pointCount };
    if (node.type === "BOOLEAN_OPERATION" && node.booleanOperation) out.booleanOp = lower(node.booleanOperation);
    if ("exportSettings" in node && isList(node.exportSettings) && node.exportSettings.length) {
      out.exportSettings = node.exportSettings.map((es) => {
        const o = { format: String(es.format || "").toLowerCase() };
        if ("suffix" in es && es.suffix) o.suffix = es.suffix;
        const con = "constraint" in es ? es.constraint : void 0;
        if (con && typeof con.value === "number" && !(con.type === "SCALE" && con.value === 1)) {
          o.constraint = { type: String(con.type || "").toLowerCase(), value: round(con.value) };
        }
        return o;
      });
    }
    if ("detachedInfo" in node && node.detachedInfo) {
      out.detachedFrom = node.detachedInfo.type === "library" ? { key: node.detachedInfo.componentKey } : { componentId: node.detachedInfo.componentId };
    }
    if (node.type === "INSTANCE" && "exposedInstances" in node) {
      try {
        if (Array.isArray(node.exposedInstances) && node.exposedInstances.length) out.exposedInstances = node.exposedInstances.map((i) => i.id);
      } catch (e) {
      }
    }
    if ("overlayPositionType" in node) {
      const hasScrim = node.overlayBackground && node.overlayBackground.type === "SOLID_COLOR" && node.overlayBackground.color;
      const closeOutside = node.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE";
      const posSet = node.overlayPositionType && node.overlayPositionType !== "CENTER";
      if (hasScrim || closeOutside || posSet) {
        const ov = {};
        if (node.overlayPositionType) ov.position = node.overlayPositionType.toLowerCase();
        if (closeOutside) ov.closeOnClickOutside = true;
        if (hasScrim && node.overlayBackground.type === "SOLID_COLOR") ov.background = rgbaToHex(node.overlayBackground.color);
        out.overlay = ov;
      }
    }
    if (node.type === "TEXT" || node.type === "TEXT_PATH") Object.assign(out, await serializeText(node));
    const propRefs = componentPropRefs(node);
    if (propRefs) out.propRefs = propRefs;
    const overrides = instanceOverrides(node);
    if (overrides) out.overrides = overrides;
    if (r.reads.pluginData) {
      const pd = pluginData(node);
      if (pd) out.pluginData = pd;
    }
    if (r.reads.motion) {
      const m = await collectMotion(node);
      if (m) out.motion = m;
    }
    if (r.reads.sharedData) {
      const sd = sharedData(node);
      if (sd) out.sharedData = sd;
    }
    const [mainRef, tokens, styles, asset, reactions, varModes, css] = await Promise.all([
      instanceComponentRef(node),
      boundTokens(node),
      nodeStyles(node),
      collectAsset(node, hidden, assets),
      simplifyReactions(node),
      variableModes(node),
      r.reads.css ? nodeCss(node) : Promise.resolve(void 0)
    ]);
    if (mainRef) {
      out.component = mainRef.name;
      out.mainComponent = mainRef;
    }
    if (tokens) out.tokens = tokens;
    if (styles) out.styles = styles;
    if (reactions) out.reactions = reactions;
    if (varModes) out.variableModes = varModes;
    if (css) out.css = css;
    if (asset && "skipped" in asset) {
      out.assetSkipped = asset.skipped;
      return leaf(out);
    }
    if (asset && "geometry" in asset) {
      out.geometry = asset.geometry;
      return leaf(out);
    }
    if (asset) {
      out.asset = asset.path;
      bakeTransform(out);
      return leaf(out);
    }
    if (node.type === "TABLE" && typeof node.numRows === "number" && typeof node.numColumns === "number") {
      const grid = await Promise.all(
        Array.from({ length: node.numRows }, (_, r2) => Promise.all(
          Array.from({ length: node.numColumns }, async (__, cc) => {
            try {
              const cell = node.cellAt(r2, cc);
              if (!cell) return void 0;
              const co = { row: r2, col: cc };
              if (cell.text) Object.assign(co, await serializeText(cell.text));
              const cfills = await simplifyFills(cell.fills);
              if (cfills) co.fills = cfills;
              return co;
            } catch (e) {
              return void 0;
            }
          })
        ))
      );
      const rows = grid.map((row) => row.filter((c) => !!c)).filter((row) => row.length);
      if (rows.length) out.tableCells = rows;
    }
    const children = "children" in node ? node.children : void 0;
    if (children && children.length) {
      const controlsChildren = "layoutMode" in node && !!node.layoutMode && node.layoutMode !== "NONE";
      const grid = "layoutMode" in node && node.layoutMode === "GRID";
      const nFixed = "numberOfFixedChildren" in node && typeof node.numberOfFixedChildren === "number" ? node.numberOfFixedChildren : 0;
      const pinnedFrom = children.length - nFixed;
      const kids = [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (!c) continue;
        const s = await serialize(c, depth + 1, controlsChildren && !(nFixed > 0 && i >= pinnedFrom), hidden, grid, assets);
        if (s) kids.push(s);
      }
      if (kids.length) out.children = kids;
    }
    return out;
  }

  // src/collect.ts
  async function serializeWithRefs(node, underHidden) {
    const tree = await serialize(node, 0, void 0, underHidden);
    if (!tree) return { tree: null };
    const [ref, dev, modes] = await Promise.all([collectReference(node), devResources(node), resolvedModes(node)]);
    if (modes) tree.resolvedModes = modes;
    return { tree, ...ifDefined("ref", ref || void 0), ...ifDefined("dev", dev || void 0) };
  }
  function hiddenAncestor(node) {
    for (let p = node.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
      if ("visible" in p && p.visible === false) return true;
    }
    return false;
  }
  async function rootTree(r, node) {
    const self = "visible" in node && node.visible === false;
    const underHidden = hiddenAncestor(node);
    if (self || underHidden) {
      r.warn("'" + node.name + "' (" + node.id + ") is hidden " + (self ? "itself" : "under a hidden ancestor") + ' \u2014 its graphics are not exported (assetSkipped:"hidden") and its reference image may be blank');
    }
    const { tree, ref, dev } = await serializeWithRefs(node, underHidden);
    if (!tree) return null;
    if (ref) tree.reference = ref;
    if (dev) tree.devResources = dev;
    return tree;
  }
  async function screenResult(r, title, fileBase, nodes, origin) {
    const variables = await dumpVariables();
    const screen = { exportedAt: exportedAt(), screen: title, nodes, manifest: manifestOf(r) };
    const page = origin && origin.page;
    if (page) {
      screen.page = page.name;
      screen.pageId = page.id;
    }
    if (origin && origin.nodeId) screen.nodeId = origin.nodeId;
    const measurements = collectMeasurements(r);
    if (measurements) screen.measurements = measurements;
    const out = { screenName: safe(fileBase), screen, variables, assets: r.assets.slice() };
    if (page) {
      out.page = page.name;
      out.pageId = page.id;
    }
    if (origin && origin.nodeId) out.nodeId = origin.nodeId;
    return out;
  }
  function summarize(nd) {
    const o = { name: nd.name, id: nd.id, type: nd.type };
    if ("width" in nd) {
      o.w = Math.round(nd.width);
      o.h = Math.round(nd.height);
    }
    if ("visible" in nd && nd.visible === false) o.hidden = true;
    if ("children" in nd) {
      try {
        o.childCount = nd.children.length;
      } catch (e) {
      }
    }
    return o;
  }
  function collisionGroups(rows) {
    const by = /* @__PURE__ */ new Map();
    for (const r of rows) {
      if (typeof r.w !== "number") continue;
      const k = JSON.stringify([r.name, r.w, r.h]);
      const g = by.get(k);
      if (g) g.push(r);
      else by.set(k, [r]);
    }
    return Array.from(by.values()).filter((g) => g.length > 1);
  }
  function collisionNote(g, what, tellBy) {
    const first2 = g[0];
    const name = first2 ? first2.name : "";
    const size = first2 ? first2.w + "\xD7" + first2.h : "";
    return g.length + " " + what + " share name '" + name + "' and size " + size + " \u2014 told apart by " + tellBy + "; when those match too, `dtwin screenshot <id> --scale 0.25` each (" + g.map((r) => r.id).join(", ") + ")";
  }
  var TITLE_VISIT_CAP = 5e3;
  var TitleCapReached = class extends Error {
  };
  function spend(b, fresh) {
    if (b.listing && b.listing.spent) return false;
    if (++b.visits > b.cap) {
      if (!b.soft) throw new TitleCapReached();
      b.capped = true;
      return false;
    }
    if (fresh && b.listing && ++b.listing.reads > b.listing.cap) {
      b.listing.spent = true;
      return false;
    }
    return true;
  }
  function liveWalkNode(n, ref) {
    let src;
    const kids = [];
    const children = {
      [Symbol.iterator]: () => {
        let i = 0;
        return {
          next: () => {
            if (!src) src = "children" in n ? n.children : [];
            const c = src[i];
            if (!c || !spend(ref.budget, !kids[i])) return { done: true, value: void 0 };
            const w = kids[i] || (kids[i] = liveWalkNode(c, ref));
            i++;
            return { done: false, value: w };
          }
        };
      }
    };
    return {
      name: n.name,
      type: n.type,
      hidden: "visible" in n && n.visible === false,
      get text() {
        return n.type === "TEXT" ? n.characters : "";
      },
      // read only when a walker hits a TEXT
      children
    };
  }
  function rowWalk(node) {
    const ref = { budget: { visits: 0, cap: TITLE_VISIT_CAP } };
    return { root: liveWalkNode(node, ref), ref };
  }
  function titleOf(w) {
    w.ref.budget = { visits: 1, cap: TITLE_VISIT_CAP };
    try {
      return deriveTitle(w.root);
    } catch (e) {
      if (!(e instanceof TitleCapReached)) throw e;
    }
    w.ref.budget.visits = 1;
    return firstText(w.root) || void 0;
  }
  var DISTINCT_TEXTS = 3;
  var DISTINCT_TEXT_CHARS = 60;
  var DISTINCT_TEXT_SCAN = 200;
  var DISTINCT_TEXT_LISTING_READS = 2e4;
  var oneLine = (t) => t.replace(/\s+/g, " ").trim();
  function titlesTellApart(g) {
    const titles = g.map((r) => r.title);
    return titles.every((t) => !!t) && new Set(titles).size === g.length;
  }
  function addDistinctTexts(g, walks, listing, sink) {
    let skipped = 0;
    const textsOf = g.map((row) => {
      const w = walks.get(row.id);
      if (!w) return { texts: /* @__PURE__ */ new Set(), cut: false };
      if (listing.spent) {
        skipped++;
        return void 0;
      }
      const budget = { visits: 1, cap: TITLE_VISIT_CAP, soft: true, listing };
      w.ref.budget = budget;
      const texts = collectTexts(w.root, DISTINCT_TEXT_SCAN).map(oneLine).filter((t) => t && !PLACEHOLDER_TEXT.has(t.toLowerCase()));
      if (listing.spent) {
        skipped++;
        return { texts: new Set(texts), cut: true };
      }
      if (budget.capped) sink("`distinctTexts` for '" + row.name + "' (" + row.id + ") read only its first " + TITLE_VISIT_CAP + " nodes");
      return { texts: new Set(texts), cut: false };
    });
    if (skipped) return g.filter((row) => walks.has(row.id)).map((row) => row.id);
    g.forEach((row, i) => {
      const mine = textsOf[i];
      if (!mine || mine.cut) return;
      const others = textsOf.filter((o, j) => j !== i && !!o).map((o) => o.texts);
      const unique = [];
      const notCommon = [];
      for (const t of mine.texts) {
        if (others.every((o) => !o.has(t))) unique.push(t);
        else if (others.some((o) => !o.has(t))) notCommon.push(t);
      }
      const picked = unique.concat(notCommon).slice(0, DISTINCT_TEXTS).map((t) => Array.from(t).slice(0, DISTINCT_TEXT_CHARS).join(""));
      if (picked.length) row.distinctTexts = picked;
    });
    return [];
  }
  async function loadPageSafely(page, sink, what) {
    if (typeof page.loadAsync !== "function") return false;
    try {
      await page.loadAsync();
    } catch (e) {
      sink("page '" + page.name + "' failed to load" + (what ? " " + what : "") + ": " + errMsg(e));
      return false;
    }
    return true;
  }
  function pageChildren(page, sink, consequence) {
    try {
      return page.children;
    } catch (e) {
      sink("page '" + page.name + "' could not be read (not loaded) \u2014 " + consequence + ": " + errMsg(e));
      return null;
    }
  }
  async function findNodeById(nodeId, sink) {
    let node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      for (const page of figma.root.children) {
        if (!await loadPageSafely(page, sink, "during node lookup")) continue;
        node = await figma.getNodeByIdAsync(nodeId);
        if (node) break;
      }
    }
    if (!node) throw new Error("Node " + nodeId + " is not in the open file \u2014 open the Figma file this link points to, then retry.");
    return node;
  }
  function resolvePages(wanted, all) {
    const avail = () => all.map((p) => `${p.id} ${JSON.stringify(p.name)}`).join("\n  ");
    const pick = (sel, matches, how) => {
      if (matches.length > 1) {
        throw new Error(`page name ${JSON.stringify(sel)} is ambiguous (${matches.length} pages ${how}) \u2014 use its id. Available pages:
  ${avail()}`);
      }
      const only = matches[0];
      return only === void 0 ? null : only;
    };
    const resolveOne = (sel) => {
      const byId = all.find((p) => p.id === sel);
      if (byId) return byId;
      const exact = pick(sel, all.filter((p) => p.name === sel), "share it");
      if (exact) return exact;
      const ci = pick(sel, all.filter((p) => p.name.trim().toLowerCase() === sel.toLowerCase()), "match ignoring case");
      if (ci) return ci;
      throw new Error(`no page matches ${JSON.stringify(sel)}. Available pages:
  ${avail()}`);
    };
    const picked = [];
    for (const sel of wanted) {
      const p = resolveOne(sel);
      if (!picked.some((x) => x.id === p.id)) picked.push(p);
    }
    return picked;
  }
  var CSS_AUTO_NODE_CAP = 60;
  function subtreeIsSmall(node) {
    let count = 0;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (++count > CSS_AUTO_NODE_CAP) return false;
      if (n && "children" in n && isList(n.children)) {
        for (const c of n.children) stack.push(c);
      }
    }
    return true;
  }
  function autoCss(opts, node) {
    const o = { ...opts };
    if (o.css === void 0 && subtreeIsSmall(node)) o.css = true;
    return o;
  }
  var DEFAULT_PAGE_BG = ["#ffffff", "#f5f5f5", "#e5e5e5"];
  function isDefaultBg(f) {
    if (!f) return true;
    const only = f[0];
    return f.length === 1 && only !== void 0 && only.type === "solid" && DEFAULT_PAGE_BG.indexOf(only.color) !== -1;
  }
  async function pageBackground(page) {
    const out = {};
    const bg = await simplifyFills(page.backgrounds);
    if (bg && !isDefaultBg(bg)) out.background = bg;
    const proto = await simplifyFills(page.prototypeBackgrounds);
    if (proto && !isDefaultBg(proto)) out.prototypeBackground = proto;
    return nonEmpty(out);
  }
  function countNodes(tree) {
    let n = 1;
    const kids = tree.children;
    if (Array.isArray(kids)) for (const k of kids) n += countNodes(k);
    return n;
  }
  function collectMeasurements(r, pages) {
    if (!r.reads.measurements) return void 0;
    const targets = pages && pages.length ? pages : [figma.currentPage];
    const out = [];
    for (const page of targets) {
      if (typeof page.getMeasurements !== "function") continue;
      try {
        const ms = page.getMeasurements();
        if (!Array.isArray(ms) || !ms.length) continue;
        const side = (e) => e ? { nodeId: e.node && e.node.id, side: e.side } : void 0;
        for (const m of ms) {
          const o = { page: page.name, pageId: page.id, ...ifDefined("start", side(m.start)), ...ifDefined("end", side(m.end)) };
          if (m.freeText) o.text = m.freeText;
          if (m.offset != null) o.offset = m.offset;
          out.push(o);
        }
      } catch (e) {
        r.warn("measurements unavailable for page '" + page.name + "': " + errMsg(e));
      }
    }
    return out.length ? out : void 0;
  }
  async function withAllInstanceChildren(read) {
    const previous = figma.skipInvisibleInstanceChildren;
    try {
      figma.skipInvisibleInstanceChildren = false;
      return await read();
    } finally {
      figma.skipInvisibleInstanceChildren = previous;
    }
  }
  async function collectSelection(opts) {
    return withAllInstanceChildren(() => collectSelectionTree(opts));
  }
  async function collectSelectionTree(opts) {
    const r = claimRun();
    const sel = figma.currentPage.selection;
    const first2 = sel[0];
    if (!first2) throw new Error("Select at least one frame first.");
    r.useReads(sel.length === 1 ? autoCss(opts, first2) : opts);
    const nodes = [];
    for (const nd of sel) {
      const tree = await rootTree(r, nd);
      if (tree) nodes.push(tree);
    }
    return screenResult(r, sel.length === 1 ? first2.name : "selection", first2.name, nodes, { page: figma.currentPage, nodeId: first2.id });
  }
  function pageOf(node) {
    let n = node;
    while (n && n.type !== "PAGE") n = n.parent;
    return n && n.type === "PAGE" ? n : null;
  }
  async function collectNode(rawId, opts) {
    return withAllInstanceChildren(() => collectNodeTree(rawId, opts));
  }
  async function collectNodeTree(rawId, opts) {
    const r = claimRun();
    const nodeId = toNodeId(rawId);
    if (!nodeId) throw new Error(NO_NODE_ID);
    const node = await findNodeById(nodeId, r.warn);
    r.useReads(autoCss(opts, node));
    try {
      const page = pageOf(node);
      if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
      if ("visible" in node && node.parent) figma.currentPage.selection = [node];
      if (figma.viewport && "visible" in node) figma.viewport.scrollAndZoomIntoView([node]);
    } catch (e) {
    }
    const tree = await rootTree(r, node);
    if (!tree) throw new Error("Node " + nodeId + " is hidden or not exportable.");
    return screenResult(r, node.name, node.name, [tree], { page: pageOf(node), nodeId });
  }
  async function collectScreenshot(rawId, opts) {
    return withAllInstanceChildren(() => collectScreenshotOf(rawId, opts));
  }
  async function collectScreenshotOf(rawId, opts) {
    const r = claimRun();
    const nodeId = toNodeId(rawId);
    if (!nodeId) throw new Error(NO_NODE_ID);
    const node = await findNodeById(nodeId, r.warn);
    const reference = await collectReference(node, opts);
    if (!reference) {
      throw new Error("Node " + nodeId + " could not be rendered (hidden, zero-size, or the export failed \u2014 see warnings).");
    }
    const size = "width" in node && "height" in node ? { w: round(node.width), h: round(node.height) } : {};
    return { id: node.id, name: node.name, type: node.type, ...size, scale: referenceScale(node, opts), reference, manifest: manifestOf(r), assets: r.assets.slice() };
  }
  var TOP_LEVEL_TYPES = /* @__PURE__ */ new Set([
    "FRAME",
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
    "GROUP",
    "SECTION",
    "TEXT",
    "RECTANGLE",
    "ELLIPSE",
    "POLYGON",
    "STAR",
    "LINE",
    "VECTOR",
    "BOOLEAN_OPERATION",
    "TABLE"
  ]);
  async function listPages(opts) {
    return withAllInstanceChildren(() => listPagesTree(opts));
  }
  async function listPagesTree(opts) {
    const depth = opts && opts.depth === 1 ? 1 : 2;
    const localWarnings = [];
    const sink = (m) => localWarnings.push(m);
    const roots = figma.root.children;
    const currentId = figma.currentPage && figma.currentPage.id;
    const pages = [];
    let frameCount = 0;
    if (depth >= 2) {
      await Promise.all(roots.map((p) => loadPageSafely(p, sink, "\u2014 its frames may be missing")));
    }
    for (const page of roots) {
      const entry = { name: page.name, id: page.id };
      if (page.id === currentId) entry.current = true;
      if (depth >= 2) {
        const children = pageChildren(page, sink, "its frames are NOT listed");
        if (!children) {
          entry.unreadable = true;
          pages.push(entry);
          continue;
        }
        const frames = children.filter((nd) => TOP_LEVEL_TYPES.has(nd.type)).map(summarize);
        for (const g of collisionGroups(frames)) sink("page '" + page.name + "': " + collisionNote(g, "frames", "`childCount`"));
        frameCount += frames.length;
        entry.frames = frames;
      }
      pages.push(entry);
    }
    return {
      exportedAt: exportedAt(),
      file: figma.root.name,
      depth,
      pages,
      manifest: { pages: pages.length, ...ifDefined("frames", depth >= 2 ? frameCount : void 0), warnings: localWarnings }
    };
  }
  async function listChildren(rawId) {
    return withAllInstanceChildren(() => listChildrenTree(rawId));
  }
  async function listChildrenTree(rawId) {
    const nodeId = toNodeId(rawId);
    if (!nodeId) throw new Error(NO_NODE_ID);
    const localWarnings = [];
    const sink = (m) => localWarnings.push(m);
    const node = await findNodeById(nodeId, sink);
    if (!("children" in node)) throw new Error("Node " + nodeId + " (" + node.type + ") is a leaf \u2014 it has no children to list.");
    if (node.type === "PAGE") await loadPageSafely(node, sink, "before listing its children");
    let kids;
    try {
      kids = node.children;
    } catch (e) {
      throw new Error("Node " + nodeId + "'s children could not be read: " + errMsg(e));
    }
    const children = [];
    if (node.type === "DOCUMENT") {
      await Promise.all(kids.map((p) => loadPageSafely(p, sink, "\u2014 hasChildren omitted")));
    }
    for (const nd of kids) {
      const c = summarize(nd);
      if (c.childCount !== void 0) c.hasChildren = c.childCount > 0;
      children.push(c);
    }
    const listing = { reads: 0, cap: DISTINCT_TEXT_LISTING_READS };
    const noDistinct = [];
    for (const g of collisionGroups(children)) {
      const walks = /* @__PURE__ */ new Map();
      for (const row of g) {
        const nd = kids.find((k) => k.id === row.id);
        if (!nd) continue;
        const w = rowWalk(nd);
        walks.set(row.id, w);
        try {
          const t = titleOf(w);
          if (t) row.title = t;
        } catch (e) {
          if (!(e instanceof TitleCapReached)) throw e;
          sink("no title for '" + row.name + "' (" + row.id + "): more than " + TITLE_VISIT_CAP + " nodes to search");
        }
      }
      if (!titlesTellApart(g)) noDistinct.push(...addDistinctTexts(g, walks, listing, sink));
      sink(collisionNote(g, "children", "`title`/`childCount`/`distinctTexts`"));
    }
    if (noDistinct.length) sink("`distinctTexts` skipped for " + noDistinct.length + " row(s) (" + noDistinct.slice(0, 6).join(", ") + (noDistinct.length > 6 ? ", \u2026" : "") + "): the listing's budget of " + DISTINCT_TEXT_LISTING_READS + " node reads ran out, and a group with a row not read in full gets none");
    return {
      exportedAt: exportedAt(),
      id: node.id,
      name: node.name,
      type: node.type,
      children,
      manifest: { children: children.length, warnings: localWarnings }
    };
  }
  async function collectDesignSystemOnly(opts) {
    return withAllInstanceChildren(() => collectDesignSystemTree(opts));
  }
  async function collectDesignSystemTree(opts) {
    const r = claimRun({ sourceBytes: false });
    r.useReads(opts);
    const designSystem = await buildDesignSystem(void 0, serialize);
    checkCancelled();
    if ((designSystem.variables || []).some((v) => v && v.remote === true) || (designSystem.components || []).some((c) => c && c.remote === true)) {
      designSystem.hygiene = [
        'design-system pull of a file that consumes libraries: library (remote) variables are only the ones this file references \u2014 this is not the library\'s catalog; open the library file and run `dtwin pull --as-library "<name>"` for it.',
        ...Array.isArray(designSystem.hygiene) ? designSystem.hygiene : []
      ];
    }
    return { designSystem };
  }
  async function collectLibraryFile(opts) {
    return withAllInstanceChildren(() => collectLibraryTree(opts));
  }
  async function collectLibraryTree(opts) {
    const r = claimRun({ sourceBytes: false });
    r.useReads(opts);
    const asLibrary = opts && opts.asLibrary || figma.root && figma.root.name || "library";
    const designSystem = await buildDesignSystem({ asLibrary }, serialize);
    checkCancelled();
    designSystem.hygiene = [
      "library pull: this is the COMPLETE local catalog of '" + asLibrary + "' \u2014 variables, styles and components, with full per-mode values. It is a snapshot of the library file's CURRENT state, which is not necessarily what consumers see: `publish` reports each object's own status (current | changed | unpublished).",
      ...Array.isArray(designSystem.hygiene) ? designSystem.hygiene : []
    ];
    return { designSystem };
  }
  async function collectFull(opts) {
    return withAllInstanceChildren(() => collectFullTree(opts));
  }
  async function collectFullTree(opts) {
    const r = claimRun();
    r.useReads(opts);
    const allPages = !!(opts && opts.allPages);
    if (allPages) await loadAllPages("all-pages export may miss pages", r.warn);
    const rawWanted = opts && opts.page !== void 0 ? (Array.isArray(opts.page) ? opts.page : [opts.page]).map((s) => String(s).trim()) : [];
    if (rawWanted.length && rawWanted.every((s) => !s)) {
      r.warn("page selector was empty after trimming \u2014 ignored, exported " + (allPages ? "every page instead" : "the current page instead"));
    }
    const wanted = rawWanted.filter(Boolean);
    if (allPages && wanted.length) {
      throw new Error("allPages and page select different scopes \u2014 pass only one (page:[ids] for a bounded pull, allPages for the whole file).");
    }
    let pages;
    if (allPages) {
      pages = figma.root.children;
    } else if (wanted.length) {
      const picked = resolvePages(wanted, figma.root.children);
      await Promise.all(picked.map((p) => loadPageSafely(p, r.warn, "")));
      pages = picked;
    } else {
      pages = [figma.currentPage];
    }
    const layers = [];
    const index = [];
    const flows = [];
    const pageSettings = [];
    let pageIndex = 0;
    for (const page of pages) {
      checkCancelled();
      enterPage("pages", ++pageIndex, pages.length, page.name, page.id, { nodes: r.stats.nodes, assets: r.assets.length });
      const children = pageChildren(page, r.warn, "its frames are missing from this export");
      if (!children) continue;
      const bg = await pageBackground(page);
      if (bg) pageSettings.push({ page: page.name, pageId: page.id, ...bg });
      if (isList(page.flowStartingPoints)) {
        for (const fp of page.flowStartingPoints) flows.push({ page: page.name, pageId: page.id, nodeId: fp.nodeId, name: fp.name });
      }
      const frames = [];
      for (const nd of children) {
        if (TOP_LEVEL_TYPES.has(nd.type)) frames.push(nd);
        else if (nd.visible !== false) r.warn("top-level " + nd.type + " '" + nd.name + "' on page '" + page.name + "' not exported (unhandled top-level type)");
      }
      for (const f of frames) {
        checkCancelled();
        const { tree, ref, dev } = await serializeWithRefs(f);
        if (tree) {
          layers.push({ name: f.name, id: f.id, page: page.name, pageId: page.id, tree, ...ifDefined("reference", ref), ...ifDefined("devResources", dev) });
          index.push({
            name: f.name,
            id: f.id,
            type: f.type,
            page: page.name,
            pageId: page.id,
            nodes: countNodes(tree),
            bytes: JSON.stringify(tree).length
          });
        }
        progress("pages", { nodes: r.stats.nodes, assets: r.assets.length });
      }
    }
    checkCancelled();
    progress("design-system", { nodes: r.stats.nodes, assets: r.assets.length }, true);
    const designSystem = await buildDesignSystem(void 0, serialize);
    checkCancelled();
    const measurements = collectMeasurements(r, pages);
    const layersDoc = {
      exportedAt: exportedAt(),
      // Three cases, not two. Folding an explicit --page into "current-page" left the consumer unable
      // to tell whether it got the page it asked for, next to a `page` field naming a page that was
      // never exported (the named page is loaded, NOT made current — so figma.currentPage is still
      // whatever the user happens to be looking at).
      scope: allPages ? "all-pages" : wanted.length ? "page" : "current-page",
      // `pages.map(...)[0]` rather than `pages[0]?.name`: the plugin bundle is ES2019, which has no `?.`.
      ...ifDefined("page", allPages || pages.length !== 1 ? void 0 : pages.map((p) => p.name)[0]),
      ...ifDefined("pages", allPages || pages.length > 1 ? pages.map((p) => p.name) : void 0),
      ...ifDefined("flows", flows.length ? flows : void 0),
      ...ifDefined("pageSettings", pageSettings.length ? pageSettings : void 0),
      ...ifDefined("measurements", measurements || void 0),
      index,
      layers,
      manifest: manifestOf(r)
    };
    return { designSystem, layersDoc, assets: r.assets.slice() };
  }

  // src/edits.ts
  var KEY = "allowEdits";
  var allowed = false;
  var loaded = (async () => {
    try {
      allowed = await figma.clientStorage.getAsync(KEY) === true;
    } catch (e) {
      console.error("[export] could not read the Allow edits setting; edits stay off:", e);
      allowed = false;
    }
  })();
  async function editsAllowed() {
    await loaded;
    return allowed;
  }
  function editsAllowedNow() {
    return allowed;
  }
  async function setEditsAllowed(on) {
    await loaded;
    allowed = on;
    try {
      await figma.clientStorage.setAsync(KEY, on);
    } catch (e) {
      console.error("[export] could not save the Allow edits setting:", e);
    }
    return allowed;
  }

  // src/writes.ts
  function solidPaint(hex, what) {
    const c = parseHexColor(hex);
    if (!c) throw new Error(what + ": '" + String(hex) + "' is not a valid colour \u2014 expected " + HEX_COLOR_HINT);
    const p = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
    if (c.a !== void 0) p.opacity = c.a;
    return p;
  }
  async function loadNodeFonts(node) {
    const len = node.characters.length;
    const fonts = len > 0 ? node.getRangeAllFontNames(0, len) : node.fontName !== figma.mixed ? [node.fontName] : [];
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  }
  async function resolveParent(parentId) {
    if (!parentId) return figma.currentPage;
    const p = await figma.getNodeByIdAsync(parentId);
    if (!p) throw new Error("parent '" + parentId + "' not found (invalid or removed id)");
    if (!("appendChild" in p)) throw new Error("parent '" + p.name + "' (" + p.type + ") cannot have children");
    if (p.type === "PAGE") await p.loadAsync();
    return p;
  }
  var EditsRevoked = class extends Error {
  };
  function consent() {
    if (!editsAllowedNow()) throw new EditsRevoked("'Allow edits' was turned off in the Design Twin plugin partway through this batch \u2014 the ops before this one were applied. Tick 'Allow edits' in the plugin window, then retry the rest.");
  }
  async function applyWrite(op) {
    switch (op.op) {
      case "createFrame": {
        const parent = await resolveParent(op.parentId);
        const fill = op.fill ? solidPaint(op.fill, "createFrame fill") : null;
        consent();
        const f = figma.createFrame();
        if (op.name) f.name = op.name;
        if (op.width && op.height) f.resize(op.width, op.height);
        if (op.layoutMode) f.layoutMode = op.layoutMode;
        if (op.itemSpacing != null) f.itemSpacing = op.itemSpacing;
        if (op.padding) {
          f.paddingTop = op.padding[0];
          f.paddingRight = op.padding[1];
          f.paddingBottom = op.padding[2];
          f.paddingLeft = op.padding[3];
        }
        if (fill) f.fills = [fill];
        parent.appendChild(f);
        return { id: f.id };
      }
      case "createText": {
        const parent = await resolveParent(op.parentId);
        const fill = op.fill ? solidPaint(op.fill, "createText fill") : null;
        consent();
        const t = figma.createText();
        await figma.loadFontAsync(t.fontName);
        if (!editsAllowedNow()) {
          t.remove();
          consent();
        }
        t.characters = op.text || "";
        if (op.fontSize) t.fontSize = op.fontSize;
        if (fill) t.fills = [fill];
        parent.appendChild(t);
        return { id: t.id };
      }
      // setFill/setText THROW rather than no-op. getNodeByIdAsync resolves to null for an invalid or
      // removed id (and for invisible instance children when skipInvisibleInstanceChildren is on), and
      // not every node type carries fills/characters. Returning {id} in those cases reported a write
      // that never happened — over MCP the agent reads that as success and builds on a false premise.
      case "setFill": {
        const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
        if (!nd) throw new Error("setFill: no node with id '" + op.nodeId + "' (invalid or removed)");
        if (!("fills" in nd)) throw new Error("setFill: node '" + nd.name + "' (" + nd.type + ") has no fills");
        const paint = solidPaint(op.color, "setFill color");
        consent();
        nd.fills = [paint];
        return ifDefined("id", op.nodeId);
      }
      case "setText": {
        const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
        if (!nd) throw new Error("setText: no node with id '" + op.nodeId + "' (invalid or removed)");
        if (nd.type !== "TEXT") throw new Error("setText: node '" + nd.name + "' is a " + nd.type + ", not TEXT");
        await loadNodeFonts(nd);
        consent();
        nd.characters = op.text || "";
        return ifDefined("id", op.nodeId);
      }
      default:
        throw new Error("unknown write op: " + op.op);
    }
  }
  async function applyWrites(ops) {
    const r = await gatedWrites(Array.isArray(ops) ? ops : []);
    announce(r);
    return r;
  }
  function announce(r) {
    const n = r.applied.length;
    const edits = n + " edit" + (n === 1 ? "" : "s");
    let text = null;
    if (r.refused === "edits-off") text = n ? "Design Twin applied " + edits + ", then stopped \u2014 'Allow edits' was turned off." : "Design Twin refused an edit request \u2014 'Allow edits' is off.";
    else if (r.ok && n) text = "Design Twin applied " + edits + " to this file.";
    else if (!r.ok && n) text = "Design Twin applied " + edits + ", then one failed: " + (r.error || "unknown error");
    if (text === null) return;
    try {
      figma.notify(text, r.ok ? void 0 : { error: true });
    } catch (e) {
      console.error("[export] figma.notify failed:", e);
    }
    const m = { type: "writes", applied: n, ok: r.ok, text };
    figma.ui.postMessage(m);
  }
  async function gatedWrites(list) {
    const applied = [];
    if (list.length && !await editsAllowed()) {
      return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    }
    if (list.length && figma.editorType === "dev") {
      const first2 = list[0];
      return {
        ok: false,
        applied,
        failedAt: 0,
        ...ifDefined("failedOp", first2 && first2.op),
        error: "the file is open in Dev Mode, which is read-only for plugins \u2014 switch to Design mode (Shift+D) and re-run the plugin to write. Reads and exports work in Dev Mode."
      };
    }
    for (const [i, op] of list.entries()) {
      const bad = writeOpError(op, i);
      if (bad !== null) return { ok: false, applied, failedAt: i, ...ifDefined("failedOp", op && op.op), error: bad };
    }
    for (const [i, op] of list.entries()) {
      try {
        applied.push(await applyWrite(op));
      } catch (e) {
        return {
          ok: false,
          applied,
          failedAt: i,
          failedOp: op && op.op,
          error: errMsg(e),
          ...e instanceof EditsRevoked ? { refused: "edits-off" } : {}
        };
      }
    }
    return { ok: true, applied };
  }

  // src/bridge.ts
  var bridgeRun = (cmd, id) => ({ source: "bridge", label: cmd, ...ifDefined("requestId", id) });
  var INSTANCE_ID = "fig-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  var INSTANCE_STARTED_AT = Date.now();
  function readFileKey() {
    try {
      return typeof figma.fileKey === "string" ? figma.fileKey : void 0;
    } catch {
      return void 0;
    }
  }
  async function handleBridge(cmd, args, id) {
    const parsed = parseCommandRequest(cmd, args);
    if (!parsed.ok) throw new Error(parsed.error);
    const req = parsed.req;
    return scheduleRun(runKind(req.cmd), work(req), bridgeRun(req.cmd, id));
  }
  function work(req) {
    switch (req.cmd) {
      // The probe for the multi-file question: run it in two files at once and compare `instanceId`.
      // An identity read — it must stay answerable DURING a long export, since "is the other file's
      // connection still alive while this one works?" is half of what it exists to measure.
      //
      // It answers four things in one call:
      //   instanceId / startedAt / uptimeMs — two distinct ids => two instances really do coexist; a
      //     CHANGED id on a later call => Figma tore the plugin runtime down and re-ran it (the
      //     southleft/figma-console-mcp#67 failure), which a reconnect alone would not reveal.
      //   fileKey                          — undefined => `enablePrivatePluginApi` is not in effect for
      //     a locally-imported plugin, so routing must fall back to a server-minted connection id.
      //   file / page                      — human labels for a connection listing, never routing keys.
      case "whoami":
        return async () => {
          const fileKey = readFileKey();
          const r = {
            instanceId: INSTANCE_ID,
            startedAt: INSTANCE_STARTED_AT,
            uptimeMs: Date.now() - INSTANCE_STARTED_AT,
            file: figma.root.name,
            page: figma.currentPage.name,
            pageId: figma.currentPage.id,
            editorType: figma.editorType,
            // Baked in at build time (build.ts's esbuild `define`) from
            // figma-plugin/package.json — the one way to tell a stale plugin in Figma apart from a
            // freshly reloaded one, since neither startedAt nor code.js's mtime can. Reused verbatim by
            // the `hello` announcement below (main.ts's get-identity -> ui.html -> bridge), so `whoami`,
            // `dtwin list clients` and `dtwin doctor` can never disagree about which build is running.
            pluginVersion: "0.1.1",
            fileKey: fileKey === void 0 ? null : fileKey,
            fileKeyAvailable: typeof fileKey === "string" && fileKey.length > 0,
            // So figma_write's dry run can say a real write would be refused before anyone sends one.
            editsAllowed: await editsAllowed()
          };
          return r;
        };
      case "ping":
        return async () => {
          const r = { pong: true, page: figma.currentPage.name, file: figma.root.name };
          const fileKey = readFileKey();
          if (fileKey !== void 0) r.fileKey = fileKey;
          return r;
        };
      // The extraction/write commands mutate shared per-run state (and the document): exclusive runs, on the
      // same chain the UI's manual runs use, so a bridge pull and a manual export can never overlap.
      case "exportFull": {
        const a = req.args;
        return () => collectFull(a);
      }
      // The tokens/styles/components-only pull — no page/frame walk, no assets. See collect.ts's
      // collectDesignSystemOnly for the one tradeoff (library-variable completeness).
      case "exportDesignSystem": {
        const a = req.args;
        return () => collectDesignSystemOnly(a);
      }
      // The library-file pull: exclusive like its export siblings (listLibraries is only a scene read). It
      // runs the full catalog build and mutates the same per-run state they do.
      case "exportLibrary": {
        const a = req.args;
        return () => collectLibraryFile(a);
      }
      case "exportSelection": {
        const a = req.args;
        return () => collectSelection(a);
      }
      case "exportNode": {
        const a = req.args;
        return () => collectNode(a.nodeId, a);
      }
      // The on-demand single-node screenshot — deliberately its own op rather than a mode of exportNode:
      // it skips serialize() and the recursive asset walk entirely (see collectScreenshot's comment), so
      // routing it through exportNode's shape would mislead a caller into thinking it got a tree back.
      case "screenshot": {
        const a = req.args;
        return () => collectScreenshot(a.nodeId, ifDefined("scale", a.scale));
      }
      case "getSelection":
        return async () => figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
      // Scene reads, these three and getSelection: the cheap maps you consult to decide WHICH deep pull to run.
      // They mutate none of the per-run state an exclusive run owns, but they wait for the run ahead of them (it
      // may hold skipInvisibleInstanceChildren on — commands.ts RunKind), unbracketed: a listing behind a long
      // export waits for it, and a listing in an idle file answers at once.
      case "listPages": {
        const a = req.args;
        return () => listPages(a);
      }
      case "listChildren": {
        const nodeId = req.args.nodeId;
        return () => listChildren(nodeId);
      }
      // Its document walk is one findAllWithCriteria per page with skipInvisibleInstanceChildren on — the same
      // cost class as listPages depth 2, not that of an export.
      case "listLibraries":
        return () => listLibraries();
      // applyWrites refuses the batch whole while "Allow edits" is off (edits.ts) — the gate lives there, not
      // here, so no caller of it can skip it.
      case "write": {
        const ops = req.args.ops;
        return () => applyWrites(ops);
      }
      default: {
        const exhaustive = req;
        throw new Error("unknown cmd: " + String(exhaustive));
      }
    }
  }

  // src/messages.ts
  var UI_TO_MAIN_TYPES = /* @__PURE__ */ new Set([
    "get-token",
    "set-token",
    "get-identity",
    "run-selection",
    "run-full",
    "get-allow-edits",
    "set-allow-edits",
    "cancel",
    "bridge"
  ]);
  function isUIToMain(x) {
    if (!x || typeof x !== "object") return false;
    const t = x.type;
    return typeof t === "string" && UI_TO_MAIN_TYPES.has(t);
  }

  // src/main.ts
  globalThis.__designExport = { serialize, collectSelection, collectNode, collectScreenshot, collectFull, collectDesignSystemOnly, collectLibraryFile, listPages, listChildren, buildDesignSystem, applyWrites, listLibraries, collectLibraryComponents, serializeRun, requestCancel, assetRetention };
  figma.showUI(__html__, { width: 360, height: 380, themeColors: true });
  console.log("[export] main.ts loaded (main thread)");
  var post2 = (m) => figma.ui.postMessage(m);
  async function runExport(label, collect, toFiles) {
    let r;
    try {
      r = await serializeRun(collect, { source: "ui", label });
    } catch (e) {
      post2({ type: "error", message: errMsg(e) });
      return;
    }
    const { files, layerFiles, summary, warnings } = toFiles(r);
    post2({ type: "files", files, ...ifDefined("layerFiles", layerFiles), assets: r.assets, summary, warnings: warnings ? warnings.length : 0 });
  }
  var runSelection = () => runExport("current selection", () => collectSelection(), (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: JSON.stringify(r.screen, null, 2), copyable: true },
      { name: "variables.json", content: JSON.stringify(r.variables, null, 2) }
    ],
    summary: `${r.screenName} \u2014 ${r.assets.length} asset(s)`,
    warnings: r.screen.manifest && r.screen.manifest.warnings
  }));
  var SEP = "__";
  var runFull = () => runExport("design system + page frames", () => collectFull(), (r) => {
    const { meta, layerFiles, indexFiles, rootIndex } = buildPageLayout(r.layersDoc, SEP);
    const ds = buildDesignSystemLayout(r.designSystem, SEP);
    const dsParts = ds.files.filter((f) => f.path !== "design-system.json");
    const batch = [...layerFiles, ...indexFiles, ...dsParts].map((f) => ({ name: f.path, content: JSON.stringify(f.data, null, 2) }));
    return {
      files: [
        { name: "design-system.json", content: JSON.stringify(ds.manifest, null, 2) },
        { name: rootIndex, content: JSON.stringify(meta, null, 2) }
      ],
      layerFiles: batch,
      summary: `${layerFiles.length} layer(s) across ${meta.pageDirs.length} page(s), ${(r.designSystem.variables || []).length} vars, ${(r.designSystem.components || []).length} components, ${r.assets.length} asset(s)`,
      ...ifDefined("warnings", r.layersDoc.manifest && r.layersDoc.manifest.warnings)
    };
  });
  function notifySelection() {
    const sel = figma.currentPage.selection;
    const first2 = sel[0];
    post2({ type: "selection", count: sel.length, name: first2 ? first2.name : null });
  }
  figma.ui.onmessage = async (raw) => {
    if (!isUIToMain(raw)) return;
    switch (raw.type) {
      case "get-token": {
        const token = await figma.clientStorage.getAsync("bridgeToken");
        post2({ type: "token", token: typeof token === "string" ? token : "" });
        break;
      }
      case "set-token": {
        await figma.clientStorage.setAsync("bridgeToken", raw.token || "");
        break;
      }
      case "get-identity": {
        let identity = {};
        try {
          identity = await handleBridge("whoami", {});
        } catch (e) {
          identity = { error: errMsg(e) };
        }
        post2({ type: "identity", identity });
        break;
      }
      case "get-allow-edits": {
        post2({ type: "allow-edits", allowed: await editsAllowed() });
        break;
      }
      case "set-allow-edits": {
        post2({ type: "allow-edits", allowed: await setEditsAllowed(raw.allowed === true) });
        break;
      }
      case "run-selection": {
        await runSelection();
        break;
      }
      case "run-full": {
        await runFull();
        break;
      }
      case "cancel": {
        if (raw.id !== void 0) {
          cancelBridgeRequest(raw.id);
          break;
        }
        if (raw.scope === "bridge") {
          cancelBridgeRuns();
          break;
        }
        const hit = requestCancel();
        post2({ type: "cancel-ack", accepted: !!hit, label: hit ? hit.label : null });
        break;
      }
      case "bridge": {
        let result;
        let error;
        try {
          result = await handleBridge(raw.cmd, raw.args, raw.id);
        } catch (e) {
          error = errMsg(e);
        }
        post2({ type: "bridge-result", ...ifDefined("id", raw.id), ok: !error, result, ...ifDefined("error", error) });
        break;
      }
      default: {
        const _exhaustive = raw;
        void _exhaustive;
      }
    }
  };
  figma.on("selectionchange", notifySelection);
  try {
    notifySelection();
  } catch (e) {
    console.error("[export] notifySelection failed:", e);
  }
  console.log("[export] main thread ready \u2014 onmessage registered");
})();
