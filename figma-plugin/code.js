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

  // ../bridge/src/json-size.ts
  var isRow = (v) => typeof v === "object" && v !== null;
  function spell(v, key, depth) {
    if (!isRow(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      const items = Array.from(v, (x) => {
        const t = spell(x, null, depth + 1);
        return t === void 0 ? "null" : t;
      });
      return (depth <= 1 || key === "children") && v.some(isRow) ? "[\n" + items.join(",\n") + "\n]" : "[" + items.join(",") + "]";
    }
    const proto = Object.getPrototypeOf(v);
    const rec = v;
    if (proto !== Object.prototype && proto !== null || typeof rec["toJSON"] === "function") return JSON.stringify(v);
    const members = [];
    for (const k of Object.keys(rec)) {
      const text = spell(rec[k], k, depth + 1);
      if (text !== void 0) members.push(JSON.stringify(k) + ":" + text);
    }
    return "{" + members.join(",") + "}";
  }
  function exportJsonText(doc) {
    const text = spell(doc, null, 0);
    return text === void 0 ? "null" : text;
  }

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
      this.collections = memoName((id) => figma.variables && figma.variables.getVariableCollectionByIdAsync ? figma.variables.getVariableCollectionByIdAsync(id) : Promise.resolve(null), (id) => {
        if (figma.variables && typeof figma.variables.getVariableCollectionByIdAsync === "function") {
          this.warn("collection metadata unavailable for '" + id + "' \u2014 collection/mode names unavailable; raw mode IDs retained where supported");
        }
      });
      this.collection = this.collections.obj;
      /** Every collection id this run looked up — how dumpVariables finds a library EXTENDED collection a frame pins. */
      this.collectionIds = () => this.collections.ids();
      /** Who asked this run to stop, if anyone: the designer's Cancel button, or the bridge giving up on the request
       *  (progress.ts requestAbandon). One field rather than two flags so the run fails with exactly one, truthful
       *  message. Starts null with the run, so a cancel that landed while nothing was running — or after the run it
       *  was meant for had already finished — cannot kill the next one. */
      this.cancel = null;
      /** Called once when `cancel` is set (progress.ts requestCancel / requestAbandon): how a run that is WAITING rather
       *  than walking — a write held for the designer's review (review.ts) — learns at once that it was stopped, where a
       *  walk only notices at its next safe point. */
      this.onCancel = null;
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
      this.warnKind = (kind, ref2) => {
        let g = this.grouped.get(kind);
        if (!g) {
          g = { count: 0, examples: [] };
          this.grouped.set(kind, g);
        }
        g.count++;
        if (ref2 && g.examples.length < WARN_EXAMPLES) g.examples.push(ref2);
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
    /** The label of an annotation category, or undefined when the file has no such id. */
    async annotationCategory(id) {
      if (!this.annotationCategories) this.annotationCategories = this.readAnnotationCategories();
      return (await this.annotationCategories).get(id);
    }
    async readAnnotationCategories() {
      if (!figma.annotations || typeof figma.annotations.getAnnotationCategoriesAsync !== "function") return /* @__PURE__ */ new Map();
      try {
        return new Map((await figma.annotations.getAnnotationCategoriesAsync()).map((c) => [c.id, c.label]));
      } catch (e) {
        this.warn("annotation categories unavailable \u2014 category labels omitted; raw categoryId retained");
        return /* @__PURE__ */ new Map();
      }
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
    wake(r);
    return r.info;
  }
  function requestAbandon(matches) {
    const r = activeRun();
    if (!r || !r.info || !matches(r.info)) return null;
    if (r.cancel === null) r.cancel = "abandoned";
    wake(r);
    return r.info;
  }
  function wake(r) {
    const f = r.onCancel;
    r.onCancel = null;
    if (f) f();
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

  // ../bridge/src/name-match.ts
  function distance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    let last2 = b.length;
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      let diag = i - 1;
      let left = i;
      for (const [k, up] of row.slice(1).entries()) {
        const cur = Math.min(up + 1, left + 1, diag + (a[i - 1] === b[k] ? 0 : 1));
        next.push(cur);
        diag = up;
        left = cur;
      }
      row = next;
      last2 = left;
    }
    return last2;
  }
  var MAX_CANDIDATES = 3;
  function nearestNames(ref2, names, max = MAX_CANDIDATES) {
    const r = ref2.toLowerCase();
    const scored = [...new Set(names)].map((n, i) => {
      const l = n.toLowerCase();
      return { n, i, contains: l.includes(r) || r.includes(l) ? 0 : 1, d: distance(r, l) };
    });
    scored.sort((a, b) => a.contains - b.contains || a.d - b.d || a.i - b.i);
    return scored.slice(0, max).map((s) => s.n);
  }
  function matchByName(ref2, items, name, exact = () => []) {
    const byId = items.filter((t) => exact(t).includes(ref2));
    if (byId.length === 1 && byId[0] !== void 0) return { kind: "one", item: byId[0] };
    const byName = items.filter((t) => name(t) === ref2);
    if (byName.length === 1 && byName[0] !== void 0) return { kind: "one", item: byName[0] };
    if (byName.length > 1) return { kind: "many", matches: byName };
    return { kind: "none", candidates: nearestNames(ref2, items.map(name)) };
  }
  function quoteList(names) {
    return names.map((n) => "'" + n + "'").join(", ");
  }

  // ../bridge/src/tree-spec.ts
  var NUMBER_TOKEN_FIELDS = [
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "topLeftRadius",
    "topRightRadius",
    "bottomRightRadius",
    "bottomLeftRadius",
    "width",
    "height",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "strokeWeight",
    "strokeTopWeight",
    "strokeRightWeight",
    "strokeBottomWeight",
    "strokeLeftWeight",
    "opacity"
  ];
  var MAX_TREE_NODES = 500;
  var MAX_TREE_DEPTH = 40;
  var MAX_KEY_LENGTH = 200;
  var DEFAULT_FONT = { family: "Inter", weight: "Regular" };
  var NOT_YET = { refuse: "" };
  var refuse = (why) => ({ refuse: why });
  var isRefuse = (r) => typeof r !== "function";
  var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var isNum = (v) => typeof v === "number" && Number.isFinite(v);
  var str = (v) => typeof v === "string" ? null : "must be a string";
  var num = (v) => isNum(v) ? null : "must be a number";
  var nonNeg = (v) => isNum(v) && v >= 0 ? null : "must be a number \u2265 0";
  var MIN_SIZE = 0.01;
  var size = (v) => isNum(v) && v >= MIN_SIZE ? null : "must be a number \u2265 " + MIN_SIZE;
  var nonEmpty2 = (v) => typeof v === "string" && v.trim().length > 0 ? null : "must be a non-empty string";
  var count = (v) => isNum(v) && Number.isInteger(v) && v >= 1 ? null : "must be a whole number \u2265 1";
  var positive = (v) => isNum(v) && v > 0 ? null : "must be a number > 0 (leave it out for no limit)";
  var unit = (v) => isNum(v) && v >= 0 && v <= 1 ? null : "must be a number from 0 to 1";
  var trueOnly = (v) => v === true ? null : "must be true (omit it for false)";
  var oneOf = (...vals) => (v) => typeof v === "string" && vals.includes(v) ? null : "must be one of " + vals.join(" | ");
  var hex = (v) => parseHexColor(v) ? null : "is not " + HEX_COLOR_HINT;
  var fourNums = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => isNum(n) && n >= 0) ? null : "must be four numbers \u2265 0 [top, right, bottom, left]";
  var firstOr = (list) => {
    for (const e of list) if (e !== null) return e;
    return null;
  };
  var objOf = (rules) => (v) => isObj(v) ? firstOr(objectProblems(v, rules, "")) : "must be an object";
  var LAYOUT_RULES = {
    display: (v) => v === "flex" ? null : v === "grid" ? "'grid' cannot be written yet (flex can)" : 'must be "flex"',
    mode: oneOf("absolute"),
    width: size,
    height: size,
    flexDirection: oneOf("row", "column"),
    gap: num,
    padding: fourNums,
    justifyContent: oneOf("flex-start", "center", "flex-end", "space-between", "space-evenly", "space-around"),
    alignItems: oneOf("flex-start", "center", "flex-end", "baseline"),
    flexWrap: oneOf("wrap"),
    rowGap: nonNeg,
    columnGap: nonNeg,
    alignContent: oneOf("space-between"),
    reverseZ: trueOnly,
    inferred: refuse("it says the read guessed the auto-layout; a write sets a real one"),
    columns: refuse("grid layout cannot be written yet"),
    rows: refuse("grid layout cannot be written yet"),
    columnSizes: refuse("grid layout cannot be written yet"),
    rowSizes: refuse("grid layout cannot be written yet"),
    autoFlow: refuse("grid layout cannot be written yet"),
    autoTracks: refuse("grid layout cannot be written yet")
  };
  var LENGTH = (units, value = num) => (v) => {
    if (!isObj(v)) return "must be an object {unit, value}";
    const bad = objOf({ unit: oneOf(...units), value })(v);
    if (bad !== null) return bad;
    return v.unit === void 0 ? "is missing unit" : v.value === void 0 ? "is missing value" : null;
  };
  var FONT_RULES = {
    size: (v) => v === "mixed" ? "'mixed' cannot be written (one size per text node)" : isNum(v) && v >= 1 ? null : "must be a number \u2265 1",
    family: nonEmpty2,
    weight: nonEmpty2,
    color: hex,
    align: oneOf("left", "center", "right", "justified"),
    valign: oneOf("center", "bottom"),
    lineHeight: (v) => {
      if (!isObj(v) || v.unit !== "auto") return LENGTH(["px", "percent"], nonNeg)(v);
      const extra = Object.keys(v).filter((k) => k !== "unit" && v[k] !== void 0);
      return extra.length ? "." + extra[0] + ': not a field of an `auto` line height (it is `{unit:"auto"}` alone)' : null;
    },
    letterSpacing: LENGTH(["px", "percent"]),
    case: oneOf("upper", "lower", "title", "small_caps", "small_caps_forced"),
    decoration: oneOf("underline", "strikethrough"),
    // The read writes it on every text; it follows the style named in `weight`, so it is accepted and sets nothing.
    // No upper bound: Figma takes a `wght` axis past 1000 (seen live: 5000) and the read then writes that weight.
    weightValue: (v) => isNum(v) && v > 0 ? null : "must be a number > 0 (it follows `weight`, and sets nothing)",
    variationSettings: (v) => {
      if (!isObj(v)) return 'must be an object of axis tag \u2192 number, e.g. {"wght": 560}';
      for (const [k, x] of Object.entries(v)) if (!isNum(x)) return "." + k + " must be a number";
      return null;
    },
    fontStyle: refuse('italic is part of the style name in `weight`, e.g. "Italic"'),
    decorationStyle: NOT_YET,
    decorationColor: NOT_YET,
    decorationThickness: NOT_YET,
    decorationOffset: NOT_YET,
    decorationSkipInk: NOT_YET,
    openType: NOT_YET,
    openTypeOff: NOT_YET,
    paragraphSpacing: NOT_YET,
    paragraphIndent: NOT_YET,
    listSpacing: NOT_YET,
    leadingTrim: NOT_YET,
    textWrap: NOT_YET,
    hangingList: NOT_YET,
    hangingPunctuation: NOT_YET
  };
  var SIDES = { top: nonNeg, right: nonNeg, bottom: nonNeg, left: nonNeg };
  var STROKE_RULES = {
    colors: (v) => Array.isArray(v) && v.length > 0 ? firstOr(v.map(hex)) : "must be a non-empty list of hex colours",
    weight: nonNeg,
    weights: objOf(SIDES),
    align: oneOf("inside", "outside", "center"),
    paints: refuse("only solid stroke `colors` can be written yet"),
    // The read writes `{profile:"uniform"}` on an ordinary stroke: that default is accepted (it sets nothing); a taper is not yet.
    variableWidth: (v) => isObj(v) && v.profile === "uniform" && Object.keys(v).every((k) => k === "profile") ? null : 'only the default {profile:"uniform"} can be written yet (a tapered or custom-width stroke cannot)',
    dash: NOT_YET,
    cap: NOT_YET,
    join: NOT_YET,
    miter: NOT_YET,
    complex: NOT_YET
  };
  var BOX_RULES = {
    w: size,
    h: size,
    // The read's page coordinates of the node's own `x`/`y` (written alongside them): accepted, and they set nothing.
    x: num,
    y: num
  };
  var RADIUS_RULES = { tl: nonNeg, tr: nonNeg, br: nonNeg, bl: nonNeg };
  var LIMIT_RULES = { minWidth: positive, maxWidth: positive, minHeight: positive, maxHeight: positive };
  var RENDER_BOX_RULES = { x: num, y: num, w: nonNeg, h: nonNeg };
  var FILL_RULES = {
    type: (v) => v === "solid" ? null : typeof v === "string" ? "'" + v + "' cannot be written yet (solid can)" : 'must be "solid"',
    color: hex,
    opacity: unit,
    tokens: (v) => {
      if (!isObj(v)) return "must be an object {color: variable}";
      const bad = firstOr(objectProblems(v, PAINT_TOKEN_RULES, ""));
      return bad !== null ? bad : v.color === void 0 ? "is missing color (the colour variable's name, key or id)" : null;
    },
    blend: NOT_YET,
    visible: refuse("an invisible paint is never written; leave it out")
  };
  var fillsCheck = (v) => {
    if (!Array.isArray(v)) return 'must be a list of paints ({type:"solid", color})';
    for (const [i, p] of v.entries()) {
      if (!isObj(p)) return "[" + i + "] must be a paint object";
      const bad = objectProblems(p, FILL_RULES, "")[0];
      if (bad) return "[" + i + "]" + (bad.startsWith(".") ? "" : " ") + bad;
      if (p.color === void 0 && p.tokens === void 0) return "[" + i + "] is missing color (a hex colour, or a colour variable in `tokens.color`)";
    }
    return null;
  };
  var ref = nonEmpty2;
  var refs = (v) => typeof v === "string" ? ref(v) : Array.isArray(v) && v.length > 0 ? firstOr(v.map((x, i) => {
    const bad = ref(x);
    return bad === null ? null : "[" + i + "] " + bad;
  })) : "must be a variable's name, key or id, or a non-empty list of them";
  var PAINT_TOKEN_RULES = { color: ref };
  var TOKEN_RULES = {
    ...Object.fromEntries(NUMBER_TOKEN_FIELDS.map((k) => [k, ref])),
    fills: refs,
    strokes: refs,
    characters: refuse("a text's content cannot be bound to a variable yet; give `text`"),
    visible: refuse("visibility cannot be bound to a variable yet; give `hidden`"),
    cornerRadius: refuse("bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius")
  };
  var FRAME_TOKENS = [...NUMBER_TOKEN_FIELDS, "fills", "strokes"];
  var TEXT_TOKENS = ["width", "height", "opacity", "strokeWeight", "fills", "strokes"];
  var INSTANCE_TOKENS = ["width", "height", "opacity"];
  var STYLE_RULES = {
    text: ref,
    fill: refuse("bind the paint to a colour variable instead: `fills[].tokens.color`"),
    stroke: refuse("bind the strokes to colour variables instead: `tokens.strokes`"),
    effect: refuse("effects cannot be written yet"),
    grid: refuse("layout grids cannot be written yet")
  };
  var propsCheck = (v) => {
    if (!isObj(v)) return "must be an object of property name \u2192 value";
    for (const [k, x] of Object.entries(v)) {
      if (!k.trim()) return "has an empty property name";
      if (x !== void 0 && typeof x !== "string" && typeof x !== "boolean") return "." + k + " must be a string (a variant's value, a text) or a boolean";
    }
    return null;
  };
  var DS_REF = "binding a text field to a variable cannot be written yet; name a text style in `styles.text`";
  var NODE_RULES = {
    type: str,
    children: (v) => Array.isArray(v) ? null : "must be a list of nodes",
    name: str,
    // "__proto__" is refused: Figma's own main-thread → UI message copy drops a key of that name (seen live), so the
    // reply could not carry it back however the plugin builds it.
    handle: (v) => typeof v !== "string" || v.length === 0 ? "must be a non-empty string" : v === "__proto__" ? "'__proto__' cannot be a handle (Figma's message passing drops that key); pick another name" : null,
    // Stored on the node as plugin data (an entry is capped at 100 kB by Figma; a key is far below it).
    key: (v) => typeof v !== "string" || !v.trim() ? "must be a non-empty string" : v.length > MAX_KEY_LENGTH ? "must be at most " + MAX_KEY_LENGTH + " characters" : null,
    id: refuse("a new node gets its id from Figma; give it a `handle` to get the id back"),
    hidden: trueOnly,
    x: num,
    y: num,
    box: objOf(BOX_RULES),
    layout: objOf(LAYOUT_RULES),
    absolute: trueOnly,
    grow: (v) => v === 0 || v === 1 ? null : "must be 0 or 1",
    alignSelf: oneOf("min", "center", "max", "stretch"),
    widthMode: oneOf("fill", "hug"),
    heightMode: oneOf("fill", "hug"),
    sizeLimits: objOf(LIMIT_RULES),
    clip: trueOnly,
    fills: fillsCheck,
    strokes: objOf(STROKE_RULES),
    radius: (v) => isNum(v) ? nonNeg(v) : objOf(RADIUS_RULES)(v),
    opacity: unit,
    text: str,
    font: objOf(FONT_RULES),
    autoResize: oneOf("width_and_height", "height", "truncate"),
    truncate: trueOnly,
    maxLines: count,
    component: ref,
    props: propsCheck,
    tokens: objOf(TOKEN_RULES),
    styles: objOf(STYLE_RULES),
    // Read fields a write does not set (yet). Each is refused by name.
    propTokens: refuse("a property bound to a variable cannot be written yet; give its value in `props`"),
    mainComponent: refuse("name the component in `component` (its name, key or id)"),
    propRefs: NOT_YET,
    overrides: NOT_YET,
    exposedInstances: NOT_YET,
    detachedFrom: NOT_YET,
    renderBox: objOf(RENDER_BOX_RULES),
    // it follows `box`: accepted, sets nothing
    layoutGrids: NOT_YET,
    scroll: NOT_YET,
    gridColumnSpan: NOT_YET,
    gridRowSpan: NOT_YET,
    gridColumnStart: NOT_YET,
    gridRowStart: NOT_YET,
    gridJustifySelf: NOT_YET,
    gridAlignSelf: NOT_YET,
    pin: NOT_YET,
    fixedChildren: NOT_YET,
    strokesInLayout: trueOnly,
    effects: NOT_YET,
    radiusFull: refuse("set `radius` to the size it should render at"),
    rotation: NOT_YET,
    flipped: NOT_YET,
    skew: NOT_YET,
    blendMode: NOT_YET,
    mask: NOT_YET,
    maskType: NOT_YET,
    cornerSmoothing: NOT_YET,
    aspectRatio: NOT_YET,
    arc: NOT_YET,
    shape: NOT_YET,
    booleanOp: NOT_YET,
    exportSettings: NOT_YET,
    overlay: NOT_YET,
    textTokens: refuse(DS_REF),
    reactions: NOT_YET,
    variableModes: refuse("set a frame's mode with a setVariableMode op after the tree lands"),
    resolvedModes: refuse("it is read-only (what the frame inherits)"),
    annotations: NOT_YET,
    devStatus: NOT_YET,
    devStatusNote: NOT_YET,
    css: refuse("it is read-only"),
    pluginData: NOT_YET,
    sharedData: NOT_YET,
    motion: NOT_YET,
    asset: refuse("images come in a later write step"),
    assetSkipped: refuse("it is read-only"),
    assetFrom: refuse("it is read-only"),
    sourceTransform: refuse("it is read-only"),
    geometry: NOT_YET,
    tableCells: NOT_YET,
    reference: str,
    // the read's path to its reference PNG: accepted, sets nothing
    devResources: NOT_YET,
    runs: refuse("mixed-format text comes in a later write step; give one `font`"),
    href: NOT_YET,
    linkNode: NOT_YET,
    list: NOT_YET,
    indent: NOT_YET,
    textStyleOverrides: refuse("it is read-only (which fields differ from the text style)"),
    missingFont: refuse("it is read-only")
  };
  var settable = (rules, k) => {
    const r = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : void 0;
    return r !== void 0 && !isRefuse(r);
  };
  function objectProblems(o, rules, path) {
    const out = [];
    for (const [k, v] of Object.entries(o)) {
      if (v === void 0) continue;
      const at = path + "." + k;
      const rule = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : void 0;
      if (rule === void 0) {
        const near = nearestNames(k, Object.keys(rules).filter((r) => {
          const x = rules[r];
          return x !== void 0 && !isRefuse(x);
        }));
        out.push(at + ": not a field the write accepts" + (near.length ? "; closest: " + quoteList(near) : ""));
      } else if (isRefuse(rule)) {
        out.push(at + ": a read field a write cannot set yet" + (rule.refuse ? " \u2014 " + rule.refuse : ""));
      } else {
        const bad = rule(v);
        if (bad !== null) out.push(at + (bad.startsWith(".") || bad.startsWith("[") ? "" : " ") + bad);
      }
    }
    return out;
  }
  function nodeKind(n) {
    if (n.type === void 0) return n.component !== void 0 ? "INSTANCE" : n.text !== void 0 ? "TEXT" : "FRAME";
    return n.type === "FRAME" || n.type === "TEXT" || n.type === "INSTANCE" ? n.type : null;
  }
  var INSTANCE_FIELDS = /* @__PURE__ */ new Set([
    "type",
    "component",
    "props",
    "name",
    "handle",
    "hidden",
    "x",
    "y",
    "box",
    "renderBox",
    "reference",
    "absolute",
    "grow",
    "alignSelf",
    "widthMode",
    "heightMode",
    "opacity",
    "tokens"
  ]);
  var STYLE_FONT_FIELDS = ["family", "weight", "size", "lineHeight", "letterSpacing", "case", "decoration", "variationSettings"];
  var SIDE_PAD = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
  var CORNERS = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]];
  var STROKE_SIDES = [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]];
  var nameList = (v) => typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  function unboundOf(n, kind) {
    const t = isObj(n.tokens) ? n.tokens : {};
    const has2 = (k) => t[k] !== void 0;
    let c = 0;
    if (Array.isArray(n.fills)) {
      for (const p of n.fills) if (isObj(p) && p.tokens === void 0) c++;
    }
    if (kind === "TEXT") {
      const styled = isObj(n.styles) && n.styles.text !== void 0;
      if (!styled) c++;
      if (n.fills === void 0 && !has2("fills") && isObj(n.font) && n.font.color !== void 0) c++;
    }
    const st = isObj(n.strokes) ? n.strokes : null;
    if (st) {
      if (Array.isArray(st.colors) && !has2("strokes")) c += st.colors.length;
      if (st.weight !== void 0 && !has2("strokeWeight")) c++;
      if (isObj(st.weights)) {
        for (const [side, field] of STROKE_SIDES) if (st.weights[side] !== void 0 && !has2(field)) c++;
      }
    }
    const l = isObj(n.layout) ? n.layout : null;
    if (l && l.display === "flex") {
      if (l.gap !== void 0 && !has2("itemSpacing")) c++;
      if (Array.isArray(l.padding)) SIDE_PAD.forEach((f) => {
        if (!has2(f)) c++;
      });
      const track = l.flexDirection === "column" ? l.columnGap : l.rowGap;
      if (l.flexWrap !== void 0 && track !== void 0 && !has2("counterAxisSpacing")) c++;
    }
    if (typeof n.radius === "number") {
      if (!CORNERS.every(([, f]) => has2(f))) c++;
    } else if (isObj(n.radius)) {
      for (const [k, f] of CORNERS) if (n.radius[k] !== void 0 && !has2(f)) c++;
    }
    return c;
  }
  var isFlex = (n) => isObj(n.layout) && n.layout.display === "flex";
  function fontOf(font) {
    return { family: font && font.family !== void 0 ? font.family : DEFAULT_FONT.family, weight: font && font.weight !== void 0 ? font.weight : DEFAULT_FONT.weight };
  }
  function tokenProblems(n, t, kind, flex, inFlex, say) {
    const fits = kind === "FRAME" ? FRAME_TOKENS : kind === "TEXT" ? TEXT_TOKENS : INSTANCE_TOKENS;
    const l = isObj(n.layout) ? n.layout : {};
    for (const k of Object.keys(t)) {
      if (t[k] === void 0 || !settable(TOKEN_RULES, k)) continue;
      const at = "`tokens." + k + "`";
      if (fits.indexOf(k) < 0) {
        say(at + " is not on a" + (kind === "INSTANCE" ? "n " : " ") + kind + " node" + (kind === "INSTANCE" ? " (its content comes from its component)" : ""));
        continue;
      }
      if ((k === "itemSpacing" || k.startsWith("padding")) && !flex) say(at + ' needs auto-layout on the node (layout.display "flex")');
      if (k === "counterAxisSpacing" && (!flex || l.flexWrap === void 0)) say(at + ' is the gap between wrapped tracks: it needs `layout.flexWrap: "wrap"`');
      if (k === "width" && n.widthMode !== void 0) say(at + " sizes the node, which `widthMode` already does; leave one out");
      if (k === "height" && n.heightMode !== void 0) say(at + " sizes the node, which `heightMode` already does; leave one out");
      if ((k === "minWidth" || k === "maxWidth" || k === "minHeight" || k === "maxHeight") && !flex && !inFlex) say(at + " needs auto-layout on the node or its parent");
    }
    const fills = nameList(t.fills);
    if (t.fills !== void 0 && Array.isArray(n.fills)) {
      const onPaints = n.fills.map((p) => isObj(p) && isObj(p.tokens) ? p.tokens.color : void 0);
      for (const name of fills) if (onPaints.indexOf(name) < 0) say("`tokens.fills` names '" + name + "', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`");
    }
    const strokes = nameList(t.strokes);
    const colors = isObj(n.strokes) && Array.isArray(n.strokes.colors) ? n.strokes.colors : null;
    if (t.strokes !== void 0 && colors && colors.length !== strokes.length) say("`tokens.strokes` names " + strokes.length + " variable" + (strokes.length === 1 ? "" : "s") + " for " + colors.length + " stroke colour" + (colors.length === 1 ? "" : "s") + "; give one per colour, in order (or leave `strokes.colors` out)");
  }
  function checkTree(spec) {
    const problems = [];
    const summary = { frames: 0, texts: 0, instances: 0, refs: { components: [], variables: [], textStyles: [] }, unbound: 0, handles: [], fonts: [], warnings: [] };
    const seenHandles = /* @__PURE__ */ new Set();
    const seenFonts = /* @__PURE__ */ new Set();
    let count2 = 0;
    let tooMany = false;
    const walk = (n, path, depth, parentFlex) => {
      if (++count2 > MAX_TREE_NODES) {
        tooMany = true;
        return;
      }
      if (!isObj(n)) {
        problems.push(path + ": must be a node object");
        return;
      }
      if (depth > MAX_TREE_DEPTH) {
        problems.push(path + ": nested deeper than " + MAX_TREE_DEPTH + " levels");
        return;
      }
      const before = problems.length;
      problems.push(...objectProblems(n, NODE_RULES, path));
      const kind = nodeKind(n);
      if (kind === null) problems.push(path + ".type: '" + String(n.type) + "' cannot be written yet (FRAME, TEXT and INSTANCE can)");
      const isRoot = parentFlex === null;
      const flex = isFlex(n);
      const say = (msg) => {
        problems.push(path + ": " + msg);
      };
      if (!isRoot && n.key !== void 0) say("`key` names a whole result, so only the root carries it");
      if (kind === "TEXT") {
        if (typeof n.text !== "string") say("a TEXT node needs `text`");
        for (const k of ["children", "layout", "clip", "radius", "sizeLimits", "strokesInLayout"]) if (n[k] !== void 0) say("`" + k + "` is not on a TEXT node");
        if (n.maxLines !== void 0 && n.truncate !== true) summary.warnings.push(path + ": `maxLines` has no effect without `truncate: true`, so it is not set");
      } else if (kind === "FRAME") {
        for (const k of ["text", "font", "autoResize", "truncate", "maxLines"]) if (n[k] !== void 0) say("`" + k + "` is only on a TEXT node (give the node `text`)");
      } else if (kind === "INSTANCE") {
        if (n.component === void 0) say("an INSTANCE node needs `component` (a component's name, key or id)");
        for (const k of Object.keys(n)) if (n[k] !== void 0 && !INSTANCE_FIELDS.has(k) && settable(NODE_RULES, k)) say("`" + k + "` is not on an INSTANCE node (its content comes from its component; set its `props`)");
      }
      if (kind !== "INSTANCE") {
        for (const k of ["component", "props"]) if (n[k] !== void 0) say("`" + k + "` is only on an INSTANCE node");
      }
      if (isObj(n.styles) && n.styles.text !== void 0 && kind !== "TEXT") say("`styles.text` is only on a TEXT node");
      for (const axis of ["widthMode", "heightMode"]) {
        const m = n[axis];
        if (m === "fill" && parentFlex !== true) say("`" + axis + ': "fill"` needs a parent with auto-layout' + (isRoot ? " (this is the root)" : ""));
        if (m === "hug" && !flex && kind === "FRAME") say("`" + axis + ': "hug"` needs the node itself to have auto-layout (layout.display "flex") or be TEXT');
      }
      if (isObj(n.tokens) && kind !== null) tokenProblems(n, n.tokens, kind, flex, parentFlex === true, say);
      if (parentFlex !== true) {
        for (const k of ["absolute", "grow", "alignSelf"]) if (n[k] !== void 0) say("`" + k + "` needs a parent with auto-layout");
      }
      if (n.sizeLimits !== void 0 && !flex && parentFlex !== true) say("`sizeLimits` needs auto-layout on the node or its parent");
      if (n.absolute === true && parentFlex === true) {
        for (const axis of ["widthMode", "heightMode"]) if (n[axis] === "fill") say("`" + axis + ': "fill"` is not on an `absolute` child (it is out of the auto-layout flow)');
        if (n.grow === 1) say("`grow: 1` is not on an `absolute` child (it is out of the auto-layout flow)");
        if (n.alignSelf === "stretch") say('`alignSelf: "stretch"` is not on an `absolute` child (it is out of the auto-layout flow)');
      }
      if (kind === "FRAME" && n.strokesInLayout === true && !flex) summary.warnings.push(path + ": `strokesInLayout` has no effect without auto-layout on the frame, so it is not set");
      if (parentFlex === true && n.absolute !== true && (n.x !== void 0 || n.y !== void 0)) {
        summary.warnings.push(path + ": `x`/`y` have no effect inside auto-layout (add `absolute: true` to place it)");
      }
      if (isObj(n.layout) && n.layout.display === "flex") {
        const l = n.layout;
        const column = l.flexDirection === "column";
        if (l.alignItems === "baseline" && column) say('`layout.alignItems: "baseline"` works only in a row (Figma refuses it in a column)');
        if (l.flexWrap === void 0) {
          for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== void 0) say("`layout." + k + '` needs `flexWrap: "wrap"`');
        }
        if (l.flexWrap !== void 0 && (column ? l.rowGap : l.columnGap) !== void 0) {
          say("`layout." + (column ? "rowGap" : "columnGap") + "` is the main-axis gap in a wrapping " + (column ? "column" : "row") + "; use `gap`, and `" + (column ? "columnGap" : "rowGap") + "` between the wrapped tracks");
        }
      }
      if (kind === "TEXT" && isObj(n.strokes) && n.strokes.weights !== void 0) say("`strokes.weights` (per side) is not on a TEXT node; use `strokes.weight`");
      if (isObj(n.sizeLimits)) {
        const m = n.sizeLimits;
        if (isNum(m.minWidth) && isNum(m.maxWidth) && m.minWidth > m.maxWidth) say("`sizeLimits.minWidth` is above `maxWidth`");
        if (isNum(m.minHeight) && isNum(m.maxHeight) && m.minHeight > m.maxHeight) say("`sizeLimits.minHeight` is above `maxHeight`");
      }
      if (isObj(n.layout) && n.layout.mode === "absolute") {
        const l = n.layout;
        if (l.display !== void 0) say('`layout` is either `display: "flex"` or `mode: "absolute"`, not both');
        else for (const k of Object.keys(l)) if (l[k] !== void 0 && k !== "mode" && k !== "width" && k !== "height" && settable(LAYOUT_RULES, k)) say("`layout." + k + '` is an auto-layout field; `mode: "absolute"` has none (use `display: "flex"`)');
      }
      if (isObj(n.layout) && n.layout.display === void 0 && n.layout.mode === void 0) say('`layout` needs `display: "flex"` (or `mode: "absolute"` for none)');
      if (typeof n.handle === "string" && n.handle) {
        if (seenHandles.has(n.handle)) say("handle '" + n.handle + "' is used twice; a handle names one node");
        seenHandles.add(n.handle);
      }
      if (problems.length === before && kind !== null) {
        const styled = isObj(n.styles) && typeof n.styles.text === "string";
        if (kind === "TEXT") {
          summary.texts++;
          if (styled) {
            const set = isObj(n.font) ? STYLE_FONT_FIELDS.filter((k) => isObj(n.font) && n.font[k] !== void 0) : [];
            if (set.length) summary.warnings.push(path + ": " + set.map((k) => "`font." + k + "`").join(", ") + " " + (set.length === 1 ? "is" : "are") + " set by the text style, so " + (set.length === 1 ? "it is" : "they are") + " not set");
          } else {
            const f = fontOf(isObj(n.font) ? n.font : void 0);
            const key = f.family + "|" + f.weight;
            if (!seenFonts.has(key)) {
              seenFonts.add(key);
              summary.fonts.push(f);
            }
          }
        } else if (kind === "INSTANCE") summary.instances++;
        else summary.frames++;
        if (typeof n.handle === "string" && n.handle) summary.handles.push(n.handle);
        const addRef = (list, name) => {
          if (typeof name === "string" && list.indexOf(name) < 0) list.push(name);
        };
        if (kind === "INSTANCE") addRef(summary.refs.components, n.component);
        if (styled && isObj(n.styles)) addRef(summary.refs.textStyles, n.styles.text);
        if (Array.isArray(n.fills)) {
          for (const p of n.fills) if (isObj(p) && isObj(p.tokens)) addRef(summary.refs.variables, p.tokens.color);
        }
        if (isObj(n.tokens)) for (const v of Object.values(n.tokens)) for (const name of nameList(v)) addRef(summary.refs.variables, name);
        summary.unbound += unboundOf(n, kind);
      }
      if (Array.isArray(n.children)) n.children.forEach((c, i) => walk(c, path + ".children[" + i + "]", depth + 1, flex));
    };
    if (!isObj(spec)) problems.push("tree: must be a node object (the root frame)");
    else {
      walk(spec, "tree", 0, null);
      if (nodeKind(spec) !== "FRAME") problems.push("tree: the root must be a FRAME (a screen); put the " + (nodeKind(spec) === "INSTANCE" ? "instance" : "text") + " inside one");
      if (tooMany) problems.push("tree: more than " + MAX_TREE_NODES + " nodes \u2014 send a large screen as several trees");
    }
    return { problems, summary };
  }
  function isTreeSpec(v) {
    return checkTree(v).problems.length === 0;
  }
  function treeRefusal(problems) {
    const first2 = problems[0];
    if (problems.length === 1 && first2 !== void 0) return first2 + ". Nothing was changed.";
    return problems.length + " problems in the tree spec \u2014 nothing was changed:\n" + problems.join("\n");
  }
  function describeTree(spec, page, s) {
    const size2 = spec.box ? " " + spec.box.w + "\xD7" + spec.box.h : spec.layout && spec.layout.width && spec.layout.height ? " " + spec.layout.width + "\xD7" + spec.layout.height : "";
    const al = spec.layout && spec.layout.display === "flex" ? ", " + (spec.layout.flexDirection === "column" ? "vertical" : "horizontal") + " auto-layout" : "";
    const nodes = s.frames + s.texts + s.instances;
    const plural = (n, one) => n + " " + one + (n === 1 ? "" : "s");
    const where = (page ? "on page '" + page + "'" : "on the current page") + (spec.x !== void 0 || spec.y !== void 0 ? " at " + (spec.x !== void 0 ? spec.x : "auto") + "," + (spec.y !== void 0 ? spec.y : "auto") : ", placed beside the existing frames");
    const parts = [
      "creates frame '" + (spec.name || "Frame") + "'" + size2 + al + " with " + nodes + " node" + (nodes === 1 ? "" : "s") + " (" + plural(s.frames, "frame") + ", " + plural(s.texts, "text") + (s.instances ? ", " + plural(s.instances, "instance") : "") + ") " + where
    ];
    if (spec.key !== void 0) parts.push("key '" + spec.key + "': when the file already holds this key's earlier result, that result is updated in place instead (same ids, only the fields that differ from the spec sent last time) and the reply lists only what changed");
    if (s.handles.length) parts.push("ids come back for " + quoteList(s.handles));
    if (s.fonts.length) parts.push("fonts " + quoteList(s.fonts.map((f) => f.family + " " + f.weight)));
    const { components, variables, textStyles } = s.refs;
    if (components.length) parts.push("components " + quoteList(components));
    if (variables.length) parts.push("variables " + quoteList(variables));
    if (textStyles.length) parts.push("text styles " + quoteList(textStyles));
    if (s.unbound) parts.push(plural(s.unbound, "raw value") + " left unbound");
    const checked = components.length + variables.length + textStyles.length ? "the page, fonts and names are checked against the file when applied (a library item is imported only then)" : "the page and fonts are checked against the file when applied";
    return parts.join("; ") + " \u2014 " + checked + ", and nothing lands unless all of it does";
  }

  // ../bridge/src/patch-spec.ts
  var bool = (v) => typeof v === "boolean" ? null : "must be true or false";
  var PATCH_LAYOUT_RULES = {
    ...LAYOUT_RULES,
    width: refuse("set the size with `box`"),
    height: refuse("set the size with `box`"),
    flexWrap: oneOf("wrap", "nowrap"),
    alignContent: oneOf("space-between", "auto"),
    reverseZ: bool
  };
  var PATCH_STROKE_RULES = {
    colors: (v) => Array.isArray(v) ? (() => {
      for (const [i, c] of v.entries()) {
        const bad = hex(c);
        if (bad !== null) return "[" + i + "] " + bad;
      }
      return null;
    })() : "must be a list of hex colours ([] removes the strokes)",
    weight: nonNeg,
    weights: objOf(SIDES),
    align: oneOf("inside", "outside", "center"),
    paints: refuse("only solid stroke `colors` can be written yet")
  };
  var tokenValue = (v) => v === null ? null : ref(v);
  var tokenList = (v) => v === null ? null : typeof v === "string" ? ref(v) : Array.isArray(v) && v.length > 0 ? (() => {
    for (const [i, x] of v.entries()) {
      const bad = ref(x);
      if (bad !== null) return "[" + i + "] " + bad;
    }
    return null;
  })() : "must be a variable's name, key or id, a non-empty list of them, or null to unbind";
  var PATCH_TOKEN_RULES = {
    ...Object.fromEntries(NUMBER_TOKEN_FIELDS.map((k) => [k, tokenValue])),
    fills: tokenList,
    strokes: tokenList,
    characters: refuse("a text's content cannot be bound to a variable yet; give `text`"),
    visible: refuse("visibility cannot be bound to a variable yet; give `hidden`"),
    cornerRadius: refuse("bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius")
  };
  var BOX_RULES2 = {
    w: size,
    h: size,
    x: refuse("a patch does not move a node; `move` changes its parent"),
    y: refuse("a patch does not move a node; `move` changes its parent")
  };
  var PATCH_FIELDS = {
    props: propsCheck,
    name: str,
    hidden: bool,
    opacity: unit,
    layout: objOf(PATCH_LAYOUT_RULES),
    box: (v) => {
      if (!isObj(v)) return "must be an object {w, h}";
      const bad = objOf(BOX_RULES2)(v);
      return bad !== null ? bad : v.w === void 0 && v.h === void 0 ? "needs `w`, `h` or both" : null;
    },
    widthMode: oneOf("fill", "hug", "fixed"),
    heightMode: oneOf("fill", "hug", "fixed"),
    radius: NODE_RULES.radius,
    fills: fillsCheck,
    strokes: (v) => {
      if (!isObj(v)) return "must be an object";
      const bad = objOf(PATCH_STROKE_RULES)(v);
      return bad !== null ? bad : Object.keys(v).every((k) => v[k] === void 0) ? "is empty" : null;
    },
    styles: objOf(STYLE_RULES),
    text: str,
    autoResize: oneOf("width_and_height", "height", "truncate", "none"),
    tokens: objOf(PATCH_TOKEN_RULES)
  };
  var PATCH_FIELD_NAMES = Object.keys(PATCH_FIELDS);
  var NOT_PATCHED = {
    type: "a node's type cannot change",
    children: "a patch changes one node; change each child by its own id (or `move` a node this session created)",
    handle: "a handle names a node a createTree op creates",
    key: "a key names a createTree result; send its spec again to update it",
    id: "the node is named by the op's `nodeId`",
    component: "swapping an instance's component cannot be written yet; set its `props`",
    x: "a patch does not move a node; `move` changes its parent",
    y: "a patch does not move a node; `move` changes its parent",
    font: "a text's font cannot be patched yet; name a text style in `styles.text`"
  };
  var settableIn = (rules) => Object.keys(rules).filter((k) => {
    const r = rules[k];
    return r !== void 0 && !isRefuse(r);
  });
  function checkPatch(set, path = "set") {
    const summary = { fields: [], refs: { variables: [], textStyles: [] }, unbound: 0 };
    if (!isObj(set)) return { problems: [path + ': must be an object of the fields to change, e.g. {text: "\u2026"}'], summary };
    const problems = [];
    const say = (m) => {
      problems.push(path + ": " + m);
    };
    for (const [k, v] of Object.entries(set)) {
      if (v === void 0) continue;
      const at = path + "." + k;
      if (Object.prototype.hasOwnProperty.call(PATCH_FIELDS, k)) continue;
      const why = Object.prototype.hasOwnProperty.call(NOT_PATCHED, k) ? NOT_PATCHED[k] : void 0;
      const tree = Object.prototype.hasOwnProperty.call(NODE_RULES, k) ? NODE_RULES[k] : void 0;
      if (why !== void 0) problems.push(at + ": a patch cannot set it \u2014 " + why);
      else if (tree !== void 0) problems.push(at + ": a read field a patch cannot set yet" + (isRefuse(tree) && tree.refuse ? " \u2014 " + tree.refuse : ""));
      else {
        const near = nearestNames(k, PATCH_FIELD_NAMES);
        problems.push(at + ": not a field a patch sets" + (near.length ? "; closest: " + quoteList(near) : ""));
      }
    }
    problems.push(...objectProblems(Object.fromEntries(Object.entries(set).filter(([k]) => Object.prototype.hasOwnProperty.call(PATCH_FIELDS, k))), PATCH_FIELDS, path));
    const fields = PATCH_FIELD_NAMES.filter((k) => set[k] !== void 0);
    if (!fields.length && !problems.length) say("sets nothing; give at least one of " + PATCH_FIELD_NAMES.join(", "));
    if (problems.length) return { problems, summary };
    const l = isObj(set.layout) ? set.layout : null;
    if (l) {
      if (l.mode !== void 0 && l.display !== void 0) say('`layout` is either `display: "flex"` or `mode: "absolute"`, not both');
      else if (l.mode !== void 0) {
        for (const k of Object.keys(l)) if (l[k] !== void 0 && k !== "mode" && settableIn(PATCH_LAYOUT_RULES).indexOf(k) >= 0) say("`layout." + k + '` is an auto-layout field; `mode: "absolute"` removes auto-layout');
      }
      if (l.alignItems === "baseline" && l.flexDirection === "column") say('`layout.alignItems: "baseline"` works only in a row (Figma refuses it in a column)');
      if (l.flexWrap === "nowrap") {
        for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== void 0) say("`layout." + k + '` needs wrapping; `flexWrap: "nowrap"` turns it off');
      }
    }
    const box = isObj(set.box) ? set.box : null;
    if (box && box.w !== void 0 && set.widthMode !== void 0 && set.widthMode !== "fixed") say('`box.w` gives a fixed width, which `widthMode: "' + String(set.widthMode) + '"` contradicts; leave one out');
    if (box && box.h !== void 0 && set.heightMode !== void 0 && set.heightMode !== "fixed") say('`box.h` gives a fixed height, which `heightMode: "' + String(set.heightMode) + '"` contradicts; leave one out');
    const t = isObj(set.tokens) ? set.tokens : {};
    if (t.width !== void 0 && t.width !== null && set.widthMode !== void 0 && set.widthMode !== "fixed") say("`tokens.width` sizes the node, which `widthMode` already does; leave one out");
    if (t.height !== void 0 && t.height !== null && set.heightMode !== void 0 && set.heightMode !== "fixed") say("`tokens.height` sizes the node, which `heightMode` already does; leave one out");
    if (Array.isArray(set.fills) && t.fills !== void 0) {
      const onPaints = set.fills.map((p) => isObj(p) && isObj(p.tokens) ? p.tokens.color : void 0);
      if (t.fills === null) say("`tokens.fills: null` unbinds the node's paints, and `fills` replaces them; give one");
      else for (const name of typeof t.fills === "string" ? [t.fills] : Array.isArray(t.fills) ? t.fills : []) if (onPaints.indexOf(name) < 0) say("`tokens.fills` names '" + String(name) + "', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`");
    }
    const st = isObj(set.strokes) ? set.strokes : null;
    if (st && Array.isArray(st.colors) && t.strokes !== void 0 && t.strokes !== null) {
      const n = typeof t.strokes === "string" ? 1 : Array.isArray(t.strokes) ? t.strokes.length : 0;
      if (n !== st.colors.length) say("`tokens.strokes` names " + n + " variable" + (n === 1 ? "" : "s") + " for " + st.colors.length + " stroke colour" + (st.colors.length === 1 ? "" : "s") + "; give one per colour, in order");
    }
    if (problems.length) return { problems, summary };
    summary.fields = fields;
    const add = (list, name) => {
      if (typeof name === "string" && list.indexOf(name) < 0) list.push(name);
    };
    if (Array.isArray(set.fills)) {
      for (const p of set.fills) if (isObj(p) && isObj(p.tokens)) add(summary.refs.variables, p.tokens.color);
    }
    for (const v of Object.values(t)) for (const name of typeof v === "string" ? [v] : Array.isArray(v) ? v : []) add(summary.refs.variables, name);
    if (isObj(set.styles)) add(summary.refs.textStyles, set.styles.text);
    summary.unbound = unboundOf2(set, t);
    return { problems, summary };
  }
  function unboundOf2(set, t) {
    const has2 = (k) => t[k] !== void 0 && t[k] !== null;
    let c = 0;
    if (Array.isArray(set.fills)) {
      for (const p of set.fills) if (isObj(p) && p.tokens === void 0) c++;
    }
    const st = isObj(set.strokes) ? set.strokes : null;
    if (st) {
      if (Array.isArray(st.colors) && !has2("strokes")) c += st.colors.length;
      if (st.weight !== void 0 && !has2("strokeWeight")) c++;
      if (isObj(st.weights)) {
        for (const [side, f] of [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]]) if (st.weights[side] !== void 0 && !has2(f)) c++;
      }
    }
    const l = isObj(set.layout) ? set.layout : null;
    if (l) {
      if (l.gap !== void 0 && !has2("itemSpacing")) c++;
      if (Array.isArray(l.padding)) {
        for (const f of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) if (!has2(f)) c++;
      }
    }
    const corners = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]];
    if (typeof set.radius === "number") {
      if (!corners.every(([, f]) => has2(f))) c++;
    } else if (isObj(set.radius)) {
      for (const [k, f] of corners) if (set.radius[k] !== void 0 && !has2(f)) c++;
    }
    return c;
  }
  function isPatchSet(v) {
    return checkPatch(v).problems.length === 0;
  }
  function patchRefusal(problems) {
    const first2 = problems[0];
    if (problems.length === 1 && first2 !== void 0) return first2 + ". Nothing was changed.";
    return problems.length + " problems in the patch \u2014 nothing was changed:\n" + problems.join("\n");
  }
  function patchRows(set, s) {
    return s.fields.map((f) => ({ field: f, to: JSON.stringify(set[f]) }));
  }
  function describePatch(nodeId, s) {
    const { variables, textStyles } = s.refs;
    const parts = ["node " + (nodeId || "?") + ": sets " + s.fields.join(", ")];
    if (variables.length) parts.push("variables " + quoteList(variables));
    if (textStyles.length) parts.push("text styles " + quoteList(textStyles));
    if (s.unbound) parts.push(s.unbound + " raw value" + (s.unbound === 1 ? "" : "s") + " left unbound");
    return parts.join("; ") + " \u2014 the node, its kind and the names are checked against the file when applied; the values it replaces are kept, and put back if a later op of the batch fails";
  }

  // ../bridge/src/commands.ts
  var WRITE_OP_NAMES = ["createFrame", "createText", "setFill", "setText", "setVariableMode", "clearVariableMode", "createTree", "patch", "move", "delete"];
  var INHERITED = "inherited";
  var WRITE_OPS = {
    createFrame: { effect: "creates", required: [], shows: {} },
    createText: { effect: "creates", required: ["text"], shows: { newText: "text" } },
    setFill: { effect: "overwrites", required: ["nodeId", "color"], shows: { newFill: "color" } },
    setText: { effect: "overwrites", required: ["nodeId", "text"], shows: { newText: "text" } },
    setVariableMode: { effect: "overwrites", required: ["nodeId", "collection", "mode"], shows: { collection: "collection", newMode: "mode" } },
    clearVariableMode: { effect: "overwrites", required: ["nodeId", "collection"], shows: { collection: "collection", newMode: INHERITED } },
    createTree: { effect: "creates", required: ["tree"], shows: {} },
    patch: { effect: "overwrites", required: ["nodeId", "set"], shows: {} },
    move: { effect: "moves", required: ["nodeId", "parentId"], shows: {} },
    delete: { effect: "deletes", required: ["nodeId"], shows: {} }
  };
  function missingWriteFields(op, fields) {
    return WRITE_OPS[op].required.filter((k) => fields[k] === void 0);
  }
  function writeOpPreview(o, index) {
    const row = WRITE_OPS[o.op];
    const creates = row.effect === "creates";
    const missing = missingWriteFields(o.op, o);
    if (o.op === "createTree") return treePreview(o, index, missing);
    if (o.op === "patch") return patchPreview(o, index, missing);
    if (o.op === "move" || o.op === "delete") return structurePreview(o, index, missing);
    return {
      index,
      op: o.op,
      effect: row.effect,
      target: creates ? o.parentId ? `new node under ${o.parentId}` : "new node on the current page" : o.nodeId || null,
      ...row.shows.newFill ? { newFill: o[row.shows.newFill] } : {},
      ...row.shows.newText ? { newText: o[row.shows.newText] } : {},
      ...row.shows.collection ? { collection: o[row.shows.collection] } : {},
      ...row.shows.newMode ? modeChange(o, row.shows.newMode) : {},
      ...missing.length ? { invalid: `missing ${missing.join(", ")}` } : {}
    };
  }
  function treePreview(o, index, missing) {
    const base = { index, op: o.op, effect: "creates", target: o.page ? `new frame on page '${o.page}'` : "new frame on the current page" };
    if (missing.length) return { ...base, invalid: `missing ${missing.join(", ")}` };
    const { problems, summary } = checkTree(o.tree);
    if (problems.length || !isTreeSpec(o.tree)) return { ...base, invalid: problems.join("\n") };
    return { ...base, change: describeTree(o.tree, o.page, summary), ...summary.warnings.length ? { warnings: summary.warnings } : {} };
  }
  function patchPreview(o, index, missing) {
    const base = { index, op: o.op, effect: "overwrites", target: o.nodeId || null };
    if (missing.length) return { ...base, invalid: `missing ${missing.join(", ")}` };
    const { problems, summary } = checkPatch(o.set);
    if (problems.length || !isPatchSet(o.set)) return { ...base, invalid: problems.join("\n") };
    return { ...base, fields: patchRows(o.set, summary), change: describePatch(o.nodeId, summary) };
  }
  function structurePreview(o, index, missing) {
    const base = { index, op: o.op, effect: WRITE_OPS[o.op].effect, target: o.nodeId || null };
    if (missing.length) return { ...base, invalid: `missing ${missing.join(", ")}` };
    const only = " \u2014 only a node this plugin session created (checked when applied)";
    const change = o.op === "delete" ? `deletes node ${o.nodeId} and everything inside it${only}; deletes run after every other op of the batch has landed` : `moves node ${o.nodeId} into ${o.parentId}${o.index !== void 0 ? ` at index ${o.index}` : " as its last child"}${only}; put back if a later op fails`;
    return { ...base, change };
  }
  function modeChange(o, shows) {
    const newMode = shows === INHERITED ? INHERITED : o[shows];
    const node = `node ${o.nodeId || "?"}`, coll = `'${o.collection || "?"}'`;
    const change = shows === INHERITED ? `${node}: the ${coll} variable mode goes from its current mode to inherited (whatever its parent uses)` : `${node}: the ${coll} variable mode goes from its current mode to '${newMode || "?"}'`;
    return { newMode, change: change + " \u2014 the reply names the mode it replaced; the names are checked against the file when applied" };
  }
  var EDITS_OFF_MESSAGE = "Edits are off in the Design Twin plugin \u2014 tick 'Allow edits' in the plugin window, then retry. Nothing in the file was changed.";
  var REVIEW_REASON_MAX = 500;
  function reviewReason(raw) {
    const said = typeof raw === "string" ? raw.trim() : "";
    if (!said) return void 0;
    return said.length > REVIEW_REASON_MAX ? said.slice(0, REVIEW_REASON_MAX) + "\u2026 (cut)" : said;
  }
  function rejectedMessage(reason) {
    return "The designer rejected this write in the Design Twin plugin window. Nothing in the file was changed. " + (reason ? 'Their reason: "' + reason + '"' : "They gave no reason.");
  }
  function unreviewedMessage(end, waitMs) {
    const nothing = " Nothing in the file was changed.";
    if (end === "timed-out") {
      return "Nobody applied or rejected this write in the Design Twin plugin window within " + Math.round(waitMs / 6e4) + " min, so it was not applied." + nothing + " Ask the designer to watch the plugin window (or to untick 'Review each write' there), then retry.";
    }
    if (end === "cancelled") return "The designer stopped this write with Cancel in the Design Twin plugin window before applying it." + nothing;
    return "This write was withdrawn before the designer answered its review: the request was abandoned or the bridge disconnected." + nothing;
  }
  function reviewLines(ops) {
    return ops.map((o, i) => {
      const s = writeOpPreview(o, i);
      if (s.change) return s.change;
      const parts = [];
      if (s.op === "createFrame") parts.push("creates a frame" + (o.name ? " '" + o.name + "'" : "") + " \u2014 " + s.target);
      else if (s.op === "createText") parts.push("creates a text" + (s.newText !== void 0 ? ' "' + s.newText + '"' : "") + " \u2014 " + s.target);
      else if (s.op === "setFill") parts.push("node " + (s.target || "?") + ": the fill becomes " + (s.newFill || "?"));
      else if (s.op === "setText") parts.push("node " + (s.target || "?") + ': the text becomes "' + (s.newText !== void 0 ? s.newText : "") + '"');
      else parts.push(s.op + " " + (s.target || ""));
      if (s.op === "createFrame") {
        if (o.width && o.height) parts.push(o.width + "\xD7" + o.height);
        if (o.layoutMode) parts.push((o.layoutMode === "HORIZONTAL" ? "row" : "column") + " auto-layout");
        if (o.itemSpacing != null) parts.push("gap " + o.itemSpacing);
        if (o.padding) parts.push("padding " + o.padding.join(" "));
      }
      if (s.op === "createText" && o.fontSize) parts.push("size " + o.fontSize);
      if ((s.op === "createFrame" || s.op === "createText") && o.fill) parts.push("fill " + o.fill);
      return parts.join(", ");
    });
  }
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
  var isNum2 = (v) => typeof v === "number";
  function opt(a, key, ok, what, label3 = key) {
    const v = a[key];
    return v === void 0 || ok(v) ? null : `\`${label3}\` is not ${what}`;
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
  var isPadding = (v) => Array.isArray(v) && v.length === 4 && v.every(isNum2);
  var WRITE_STR_FIELDS = ["parentId", "name", "fill", "text", "nodeId", "color", "collection", "mode", "page"];
  var WRITE_NUM_FIELDS = ["width", "height", "itemSpacing", "fontSize"];
  var isIndex = (v) => isNum2(v) && Number.isInteger(v) && v >= 0;
  function writeOpError(o, i) {
    const at = `ops[${i}]`;
    if (!isRecord(o)) return `\`${at}\` is not an object`;
    const op = o.op;
    if (!isWriteOpName(op)) return `\`${at}.op\` is not one of ${WRITE_OP_NAMES.join(" | ")}`;
    const typeErr = first([
      ...WRITE_STR_FIELDS.map((k) => opt(o, k, isStr, "a string", `${at}.${k}`)),
      ...WRITE_NUM_FIELDS.map((k) => opt(o, k, isNum2, "a number", `${at}.${k}`)),
      opt(o, "layoutMode", (v) => v === "HORIZONTAL" || v === "VERTICAL", "HORIZONTAL or VERTICAL", `${at}.layoutMode`),
      opt(o, "padding", isPadding, "four numbers", `${at}.padding`),
      opt(o, "index", isIndex, "a whole number \u2265 0", `${at}.index`)
    ]);
    if (typeErr !== null) return typeErr;
    if (o.treeFile !== void 0) return `\`${at}.treeFile\`: a spec path is read by figma_write on the MCP server; send the spec itself as \`tree\``;
    const missing = missingWriteFields(op, o);
    if (missing.length) return `\`${at}\` (${op}): missing ${missing.join(", ")}`;
    if (op === "createTree") {
      const { problems } = checkTree(o.tree);
      if (problems.length) return treeRefusal(problems.map((p) => p.replace(/^tree/, `${at}.tree`)));
    }
    if (op === "patch") {
      const { problems } = checkPatch(o.set, `${at}.set`);
      if (problems.length) return patchRefusal(problems);
    }
    return null;
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
    screenshot: (a) => first([nodeArgs(a), opt(a, "scale", isNum2, "a number")]),
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
  function isExtended(c) {
    return c.isExtension === true;
  }
  async function parentCollection(id) {
    return id ? run().collection(id) : null;
  }
  async function extensionLineage(e) {
    const [parent, root] = await Promise.all([parentCollection(e.parentVariableCollectionId), parentCollection(e.rootVariableCollectionId)]);
    const parentModes = {};
    for (const m of e.modes) {
      const pm = parent ? parent.modes.find((x) => x.modeId === m.parentModeId) : void 0;
      parentModes[m.name] = pm ? pm.name : m.parentModeId;
    }
    return {
      parent: parent ? parent.name : e.parentVariableCollectionId,
      ...ifDefined("parentKey", parent && parent.key || void 0),
      root: root ? root.name : e.rootVariableCollectionId,
      ...ifDefined("rootKey", root && root.key || void 0),
      parentModes
    };
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
    const localById = new Map(localVars.map((v) => [v.id, v]));
    for (const c of await Promise.all(run().collectionIds().map((cid) => run().collection(cid)))) {
      if (c && isExtended(c) && !collById.has(c.id)) collById.set(c.id, c);
    }
    const extended = [...collById.values()].filter(isExtended);
    const extensionsOf = /* @__PURE__ */ new Map();
    const extensionAliases = [];
    await Promise.all(extended.map(async (coll) => {
      let unreadable = 0;
      await Promise.all(coll.variableIds.map(async (id) => {
        try {
          const v = localById.get(id) || await run().varName.obj(id);
          if (!v || v.variableCollectionId === coll.id) return;
          const values = await v.valuesByModeForCollectionAsync(coll);
          const list = extensionsOf.get(id);
          if (list) list.push({ coll, values });
          else extensionsOf.set(id, [{ coll, values }]);
          for (const raw of Object.values(values)) extensionAliases.push(...aliasIds(raw));
        } catch (e) {
          unreadable++;
        }
      }));
      if (unreadable) hygiene.push("extended collection '" + coll.name + "': values unreadable for " + unreadable + " variable(s) \u2014 their inherited/override values are missing");
    }));
    const remoteVars = [];
    const seen = new Set(localIds);
    let frontier = [...new Set(run().varName.ids().concat(...localVars.map(aliasTargets), [...extensionsOf.keys()], extensionAliases))].filter((id) => !seen.has(id));
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
    const modeName2 = {};
    for (const c of allCollections) for (const m of c.modes) if (!(m.modeId in modeName2)) modeName2[m.modeId] = m.name;
    const resolvedIds = new Set(localIds);
    for (const v of remoteVars) resolvedIds.add(v.id);
    if (remoteVars.length) {
      hygiene.push(
        remoteVars.length + " variable(s) referenced by this file come from a published LIBRARY, not this file \u2014 included below with remote:true (getLocalVariablesAsync cannot enumerate them)"
      );
    }
    const reportBrokenAliases = (v, ids) => {
      for (const id of ids) if (!resolvedIds.has(id)) hygiene.push("broken alias in '" + v.name + "' \u2014 target " + id + " could not be resolved");
    };
    const extensionRecord = async (v, { coll, values: raws }) => {
      const e = coll;
      const nameOf = (modeId) => {
        const m = e.modes.find((x) => x.modeId === modeId);
        return m ? m.name : modeId;
      };
      const entries = await Promise.all(Object.entries(raws).map(async ([modeId, raw]) => ({ modeId, raw, value: await resolveModeValue(raw, v.resolvedType) })));
      const overridden = e.variableOverrides && e.variableOverrides[v.id] || {};
      const values = {};
      for (const { modeId, raw, value } of entries) {
        reportBrokenAliases(v, aliasIds(raw));
        values[nameOf(modeId)] = value;
      }
      return { collection: coll.name, ...ifDefined("collectionKey", coll.key || void 0), values, overrides: Object.keys(overridden).filter((m) => m in raws).map(nameOf) };
    };
    for (const v of localVars.concat(remoteVars)) {
      const values = {};
      let hasAlias = false;
      const modes = await Promise.all(Object.entries(v.valuesByMode).map(async ([modeId, raw]) => ({ modeId, raw, value: await resolveModeValue(raw, v.resolvedType) })));
      for (const { modeId, raw, value } of modes) {
        if (isVariableAlias(raw) || toComposed(raw)) hasAlias = true;
        reportBrokenAliases(v, isVariableAlias(raw) ? [raw.id] : aliasIds(raw));
        values[modeName2[modeId] || modeId] = value;
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
      const views = extensionsOf.get(v.id);
      if (views) rec.extensions = await Promise.all(views.map((x) => extensionRecord(v, x)));
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
    const lineage = new Map(await Promise.all(extended.map(async (c) => [c.id, await extensionLineage(c)])));
    return {
      // Local collections plus any LIBRARY collection a referenced remote variable belongs to — the
      // token emitters need each collection's default mode to pick the `:root` value.
      collections: allCollections.map((c) => ({
        name: c.name,
        modes: c.modes.map((m) => m.name),
        // Which mode is the base/`:root` default (vs. the override theme) — codegen otherwise guesses.
        ...ifDefined("default", modeName2[c.defaultModeId] || void 0),
        theming: c.modes.length > 1,
        // Extended collection (its modes inherit from a parent collection via parentModeId) — codegen
        // should treat it as an override layer, not a standalone theme. Its values are on each inherited
        // variable's `extensions`.
        ...ifDefined("extended", c.isExtension === true ? true : void 0),
        ...lineage.get(c.id),
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
  async function simplifyGrid(g) {
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
    const tokens = await resolveBoundMap(g.boundVariables);
    if (tokens) o.tokens = tokens;
    return o;
  }
  async function simplifyGrids(grids) {
    return (await Promise.all(grids.map(simplifyGrid))).filter((g) => !!g);
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
    let size2;
    try {
      const img = figma.getImageByHash(hash);
      if (img) {
        const s = await img.getSizeAsync();
        if (s && typeof s.width === "number") size2 = { w: s.width, h: s.height };
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
    return size2;
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
          const size2 = await collectSourceImage(f.imageHash);
          if (size2) mp.intrinsicSize = size2;
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
      const paints3 = await simplifyFills(vis);
      if (paints3) out.paints = paints3;
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

  // src/node-visuals.ts
  async function nodePaints(node) {
    const [fills, strokes, effects] = await Promise.all([
      simplifyFills("fills" in node ? node.fills : void 0),
      simplifyStrokes(node),
      simplifyEffects("effects" in node ? node.effects : void 0)
    ]);
    const out = {};
    if (fills) out.fills = fills;
    if (strokes) out.strokes = strokes;
    if (effects) out.effects = effects;
    return out;
  }
  var CORNER_KEYS = [
    ["topLeftRadius", "tl"],
    ["topRightRadius", "tr"],
    ["bottomRightRadius", "br"],
    ["bottomLeftRadius", "bl"]
  ];
  var RADIUS_SENTINEL = 1e4;
  function radiusOut(raw, size2, flag) {
    if (raw < RADIUS_SENTINEL) return round(raw);
    flag.full = true;
    const w = size2 && typeof size2.w === "number" ? size2.w : void 0;
    const h = size2 && typeof size2.h === "number" ? size2.h : void 0;
    if (w === void 0 && h === void 0) return round(raw);
    return round(Math.min(w === void 0 ? Infinity : w, h === void 0 ? Infinity : h) / 2);
  }
  function nodeCorners(node, size2) {
    const out = {};
    if (!("cornerRadius" in node)) return out;
    const flag = {};
    let radius;
    if (node.cornerRadius !== figma.mixed && node.cornerRadius) radius = radiusOut(node.cornerRadius, size2, flag);
    else if (node.cornerRadius === figma.mixed) {
      const corners = {};
      for (const [k, s] of CORNER_KEYS) {
        const v = numProp(node, k);
        if (k in node && typeof v === "number" && v) corners[s] = radiusOut(v, size2, flag);
      }
      radius = nonEmpty(corners);
    }
    if (flag.full) out.radiusFull = true;
    if (radius !== void 0) out.radius = radius;
    return out;
  }
  function nodeOpacity(node) {
    return "opacity" in node && typeof node.opacity === "number" && node.opacity < 1 ? round(node.opacity) : void 0;
  }
  function nodeBlendMode(node) {
    return "blendMode" in node && node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH" ? String(node.blendMode).toLowerCase() : void 0;
  }
  async function nodeVisuals(node, size2) {
    const out = { ...await nodePaints(node), ...nodeCorners(node, size2) };
    const opacity = nodeOpacity(node);
    if (opacity !== void 0) out.opacity = opacity;
    const blendMode = nodeBlendMode(node);
    if (blendMode) out.blendMode = blendMode;
    return nonEmpty(out);
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
      const tags = Object.keys(feats);
      const on2 = tags.filter((k) => feats[k]);
      const off = tags.filter((k) => !feats[k]);
      if (on2.length) f.openType = on2;
      if (off.length) f.openTypeOff = off;
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

  // src/instance-refs.ts
  async function instanceComponentRef(node) {
    if (node.type !== "INSTANCE") return void 0;
    try {
      const main = await node.getMainComponentAsync();
      if (!main) return void 0;
      const ref2 = { name: main.name };
      if (main.id) ref2.id = main.id;
      if (main.key) ref2.key = main.key;
      if (main.remote) ref2.remote = true;
      const parent = main.parent;
      if (parent && parent.type === "COMPONENT_SET") {
        ref2.setId = parent.id;
        if (parent.key) ref2.setKey = parent.key;
        ref2.setName = parent.name;
        ref2.variant = main.name;
      }
      return ref2;
    } catch (e) {
      return void 0;
    }
  }
  var PROP_REF_KEYS = ["visible", "characters", "mainComponent"];
  function componentPropRefs(node) {
    if (!("componentPropertyReferences" in node)) return void 0;
    const refs2 = node.componentPropertyReferences;
    if (!refs2) return void 0;
    const out = {};
    for (const k of PROP_REF_KEYS) {
      const ref2 = refs2[k];
      if (ref2) out[k] = propName(ref2);
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

  // src/serialize.ts
  var MAX_DEPTH = 60;
  var SIZE_LIMIT_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
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
      out.layoutGrids = await simplifyGrids(node.layoutGrids);
    }
    if ("annotations" in node && isList(node.annotations) && node.annotations.length) {
      out.annotations = await Promise.all(node.annotations.map(async (a) => {
        const o = {};
        if (a.label) o.label = a.label;
        if (a.labelMarkdown) o.markdown = a.labelMarkdown;
        if (a.categoryId) {
          o.categoryId = a.categoryId;
          const category = await r.annotationCategory(a.categoryId);
          if (category) o.category = category;
        }
        if (isList(a.properties) && a.properties.length) o.props = a.properties.map((p) => p.type);
        return o;
      }));
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
    const { fills, strokes, effects } = await nodePaints(node);
    if (fills) out.fills = fills;
    if (strokes) out.strokes = strokes;
    if ("strokesIncludedInLayout" in node && node.strokesIncludedInLayout) out.strokesInLayout = true;
    if (effects) out.effects = effects;
    const { radiusFull, radius } = nodeCorners(node, out.box);
    if (radiusFull) out.radiusFull = true;
    if (radius !== void 0) out.radius = radius;
    const opacity = nodeOpacity(node);
    if (opacity !== void 0) out.opacity = opacity;
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
    const blendMode = nodeBlendMode(node);
    if (blendMode) out.blendMode = blendMode;
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
      const count2 = counts[i];
      if (count2 !== void 0) entry.variableCount = count2;
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
    for (const [source, count2] of compBySource) {
      if (seenSources.has(source)) continue;
      libraries.push({
        key: source,
        name: source,
        kind: "library",
        variableCollections: [],
        componentCount: count2,
        note: source === UNKNOWN_LIBRARY ? "components consumed from published libraries that the API cannot attribute to a source (only VARIABLES carry a libraryName). componentCount counts DISTINCT components USED IN THIS FILE, not what any library offers." : "componentCount counts components USED IN THIS FILE (attributed by the local registry), not everything the library offers"
      });
    }
    return { exportedAt: exportedAt(), ...ifDefined("file", figma.root && figma.root.name || void 0), libraries, warnings };
  }

  // src/components.ts
  function componentVisuals(node) {
    return nodeVisuals(node, { w: node.width, h: node.height });
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
  function serializeVariant(main) {
    return serialize(main, 60 - VARIANT_WALK_DEPTH, void 0, void 0, void 0, "none");
  }
  async function collectComponentCatalog(hygiene, asLibrary) {
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
            const visuals = await componentVisuals(n);
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
    for (const { entry, node: n } of standalone) {
      try {
        const node = await serializeVariant(n);
        if (node) entry.node = node;
      } catch (e) {
        run().warn("component '" + n.name + "': visuals unreadable (" + errMsg(e) + ") \u2014 node tree omitted");
      }
    }
    if (variantVisuals && variantsBySet.size) {
      for (const [setId, variants] of variantsBySet) {
        const entry = entriesBySetId.get(setId);
        if (!entry) continue;
        const out = [];
        for (const v of variants) {
          try {
            const node = await serializeVariant(v);
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
  async function buildDesignSystem(opts) {
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
    const components = await collectComponentCatalog(hygiene, asLibrary);
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
    const localStyleIds = new Set([...paint, ...text, ...effect, ...grid, ...animation].map((s) => s.id));
    const usedLibraryStyles = asLibrary ? [] : (await Promise.all(run().styleName.ids().filter((id) => !localStyleIds.has(id)).map((id) => run().styleName.obj(id)))).filter((s) => !!s && s.remote === true);
    const libraryOf = (type) => usedLibraryStyles.filter((s) => s.type === type);
    if (usedLibraryStyles.length) {
      hygiene.push(
        usedLibraryStyles.length + " style(s) used by this file come from a published LIBRARY, not this file \u2014 included with remote:true (getLocal*StylesAsync cannot enumerate them; only the styles this pull reached are here, and nothing was imported)"
      );
    }
    const catalogRows = async (list, toIr) => {
      const rows = await Promise.all(list.map(async (s) => {
        try {
          return await toIr(s);
        } catch (e) {
          if (!s.remote) throw e;
          run().warn("library style '" + s.name + "': values unreadable (" + errMsg(e) + ") \u2014 omitted from the style catalog");
          return null;
        }
      }));
      return rows.filter((r) => r !== null);
    };
    const [paintStyles, textStyles, effectStyles] = await Promise.all([
      // Paint styles carry their ACTUAL colors, not just a name.
      // `tokens` (boundVariables) was read for TEXT styles only, so a paint style bound to a color
      // variable silently lost that link — the binding is what makes it a token rather than a hex.
      catalogRows([...paint, ...libraryOf("PAINT")], async (s) => ({ name: s.name, ...ifDefined("paints", await simplifyFills(s.paints)), ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)), ...ifDefined("description", s.description || void 0), ...await styleMeta(s) })),
      catalogRows([...text, ...libraryOf("TEXT")], async (s) => ({
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
      })),
      catalogRows([...effect, ...libraryOf("EFFECT")], async (s) => ({ name: s.name, ...ifDefined("effects", await simplifyEffects(s.effects)), ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)), ...ifDefined("description", s.description || void 0), ...await styleMeta(s) }))
    ]);
    const styles = {
      paint: paintStyles,
      text: textStyles,
      effect: effectStyles,
      // Layout-grid styles (column/row grids) — the responsive grid tokens, fanned out like their three siblings.
      grid: await catalogRows([...grid, ...libraryOf("GRID")], async (s) => ({
        name: s.name,
        ...ifDefined("grids", Array.isArray(s.layoutGrids) ? await simplifyGrids(s.layoutGrids) : void 0),
        ...ifDefined("tokens", await resolveBoundMap(s.boundVariables)),
        ...ifDefined("description", s.description || void 0),
        ...await styleMeta(s)
      })),
      // Custom animation styles: the Figma animations each one contains (CustomAnimationStyle.
      // animationEntries), in the same compact form a node's applied animation style takes (motion.ts).
      // Their props can bind EASING variables, so they resolve before dumpVariables too.
      animation: await catalogRows([...animation, ...libraryOf("CUSTOM_ANIMATION")], async (s) => ({
        name: s.name,
        ...ifDefined("entries", await customAnimationEntries(s)),
        ...ifDefined("description", s.description || void 0),
        ...await styleMeta(s)
      }))
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

  // src/collect.ts
  async function serializeWithRefs(node, underHidden) {
    const tree = await serialize(node, 0, void 0, underHidden);
    if (!tree) return { tree: null };
    const [ref2, dev, modes] = await Promise.all([collectReference(node), devResources(node), resolvedModes(node)]);
    if (modes) tree.resolvedModes = modes;
    return { tree, ...ifDefined("ref", ref2 || void 0), ...ifDefined("dev", dev || void 0) };
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
    const { tree, ref: ref2, dev } = await serializeWithRefs(node, underHidden);
    if (!tree) return null;
    if (ref2) tree.reference = ref2;
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
    const measurements = collectMeasurements(r, page ? [page] : void 0);
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
    const size2 = first2 ? first2.w + "\xD7" + first2.h : "";
    return g.length + " " + what + " share name '" + name + "' and size " + size2 + " \u2014 told apart by " + tellBy + "; when those match too, `dtwin screenshot <id> --scale 0.25` each (" + g.map((r) => r.id).join(", ") + ")";
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
  function liveWalkNode(n, ref2) {
    let src;
    const kids = [];
    const children = {
      [Symbol.iterator]: () => {
        let i = 0;
        return {
          next: () => {
            if (!src) src = "children" in n ? n.children : [];
            const c = src[i];
            if (!c || !spend(ref2.budget, !kids[i])) return { done: true, value: void 0 };
            const w = kids[i] || (kids[i] = liveWalkNode(c, ref2));
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
    const ref2 = { budget: { visits: 0, cap: TITLE_VISIT_CAP } };
    return { root: liveWalkNode(node, ref2), ref: ref2 };
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
    const textsOf2 = g.map((row) => {
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
      const mine = textsOf2[i];
      if (!mine || mine.cut) return;
      const others = textsOf2.filter((o, j) => j !== i && !!o).map((o) => o.texts);
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
    let count2 = 0;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (++count2 > CSS_AUTO_NODE_CAP) return false;
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
    const size2 = "width" in node && "height" in node ? { w: round(node.width), h: round(node.height) } : {};
    return { id: node.id, name: node.name, type: node.type, ...size2, scale: referenceScale(node, opts), reference, manifest: manifestOf(r), assets: r.assets.slice() };
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
    const designSystem = await buildDesignSystem();
    checkCancelled();
    if ((designSystem.variables || []).some((v) => v && v.remote === true) || (designSystem.components || []).some((c) => c && c.remote === true) || Object.values(designSystem.styles).some((list) => list.some((s) => s.remote === true))) {
      designSystem.hygiene = [
        'design-system pull of a file that consumes libraries: library (remote) variables and styles are only the ones this pull reached \u2014 this is not the library\'s catalog; open the library file and run `dtwin pull --as-library "<name>"` for it.',
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
    const designSystem = await buildDesignSystem({ asLibrary });
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
        const { tree, ref: ref2, dev } = await serializeWithRefs(f);
        if (tree) {
          layers.push({ name: f.name, id: f.id, page: page.name, pageId: page.id, tree, ...ifDefined("reference", ref2), ...ifDefined("devResources", dev) });
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
    const designSystem = await buildDesignSystem();
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

  // ../bridge/src/ports.ts
  var ALLOWED_PORTS = [8787, 8788, 8789];

  // ../bridge/src/timeouts.ts
  var REVIEW_WAIT_MS = 3e5;
  var TIMEOUTS = { command: 12e4, selection: 12e4, list: 3e5, export: 3e5, exportAll: 9e5, write: REVIEW_WAIT_MS + 6e4 };
  var PLUGIN_REDIAL_MS = 1e3;
  var SETTLE_MS = ALLOWED_PORTS.length * PLUGIN_REDIAL_MS + 500;

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
  async function setEditsAllowed(on2) {
    await loaded;
    allowed = on2;
    try {
      await figma.clientStorage.setAsync(KEY, on2);
    } catch (e) {
      console.error("[export] could not save the Allow edits setting:", e);
    }
    return allowed;
  }

  // src/review.ts
  var KEY2 = "reviewWrites";
  var on = false;
  var loaded2 = (async () => {
    try {
      on = await figma.clientStorage.getAsync(KEY2) === true;
    } catch (e) {
      console.error("[export] could not read the Review each write setting; review stays off:", e);
      on = false;
    }
  })();
  async function reviewWrites() {
    await loaded2;
    return on;
  }
  async function setReviewWrites(value) {
    await loaded2;
    on = value;
    try {
      await figma.clientStorage.setAsync(KEY2, value);
    } catch (e) {
      console.error("[export] could not save the Review each write setting:", e);
    }
    return on;
  }
  var pending = /* @__PURE__ */ new Map();
  var seq = 0;
  function awaitReview(ops) {
    const id = "review-" + ++seq;
    const run2 = activeRun();
    return new Promise((resolve) => {
      if (run2 && run2.cancel) {
        resolve({ end: run2.cancel === "designer" ? "cancelled" : "withdrawn" });
        return;
      }
      let timer;
      const onCancel = () => settle({ end: run2 && run2.cancel === "designer" ? "cancelled" : "withdrawn" });
      const settle = (o) => {
        if (!pending.delete(id)) return;
        if (timer !== void 0) clearTimeout(timer);
        if (run2 && run2.onCancel === onCancel) run2.onCancel = null;
        const ended = { type: "review-end", id, end: o.end };
        figma.ui.postMessage(ended);
        resolve(o);
      };
      pending.set(id, { settle });
      if (run2) run2.onCancel = onCancel;
      timer = setTimeout(() => settle({ end: "timed-out" }), REVIEW_WAIT_MS);
      const card = { type: "review", id, lines: reviewLines(ops), waitMs: REVIEW_WAIT_MS };
      figma.ui.postMessage(card);
    });
  }
  function answerReview(id, apply, reason) {
    const p = pending.get(id);
    if (!p) return;
    const said = reviewReason(reason);
    p.settle(apply ? { end: "approved" } : { end: "rejected", ...said !== void 0 ? { reason: said } : {} });
  }
  function endReviews(end) {
    for (const p of [...pending.values()]) p.settle({ end });
  }

  // src/variable-modes.ts
  var isModeOp = (op) => op.op === "setVariableMode" || op.op === "clearVariableMode";
  async function resolveModeOps(ops) {
    const targets = /* @__PURE__ */ new Map();
    const problems = [];
    let locals = null;
    let library = null;
    const localCollections = async () => {
      if (!locals) locals = await figma.variables.getLocalVariableCollectionsAsync();
      return locals;
    };
    const libraryCollections = async () => {
      if (library) return library;
      try {
        library = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      } catch {
        library = [];
      }
      return library;
    };
    for (const [index, op] of ops.entries()) {
      if (!isModeOp(op)) continue;
      const bad = (message) => {
        problems.push({ index, op: op.op, message });
      };
      const nodeId = op.nodeId || "";
      const ref2 = op.collection || "";
      const nd = await figma.getNodeByIdAsync(nodeId);
      let node = null;
      if (!nd) bad("no node with id '" + nodeId + "' (invalid or removed)");
      else if (!("setExplicitVariableModeForCollection" in nd)) bad("node '" + nd.name + "' is a " + nd.type + ", which cannot carry a variable mode");
      else node = nd;
      const coll = await resolveCollection(ref2, localCollections, libraryCollections);
      if ("error" in coll) {
        bad(coll.error);
        continue;
      }
      const collection = coll.ok;
      let modeId = null;
      if (op.op === "setVariableMode") {
        const mode = resolveMode(op.mode || "", collection);
        if ("error" in mode) {
          bad(mode.error);
          continue;
        }
        modeId = mode.ok;
      }
      if (node) targets.set(index, { node, collection, modeId });
    }
    return { targets, problems };
  }
  async function resolveCollection(ref2, localCollections, libraryCollections) {
    let byId = null;
    try {
      byId = ref2 ? await figma.variables.getVariableCollectionByIdAsync(ref2) : null;
    } catch {
      byId = null;
    }
    if (byId) return { ok: byId };
    const locals = await localCollections();
    const m = matchByName(ref2, locals, (c) => c.name, (c) => [c.id, c.key]);
    if (m.kind === "one") return { ok: m.item };
    if (m.kind === "many") {
      return { error: "collection '" + ref2 + "' matches " + m.matches.length + " local collections \u2014 pass one's id: " + m.matches.slice(0, 3).map((c) => "'" + c.name + "' (" + c.id + ")").join(", ") };
    }
    const lib = (await libraryCollections()).filter((c) => c.name === ref2 || c.key === ref2);
    if (lib.length) {
      const from = [...new Set(lib.map((c) => c.libraryName))];
      return { error: "collection '" + ref2 + "' is in the library " + quoteList(from) + ", and a library collection's mode can be set only once this file uses one of its variables (a write cannot import one yet) \u2014 use a local collection, or bind one of its variables in this file first" };
    }
    return { error: "collection '" + ref2 + "' matches no local variable collection" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "; this file has none") };
  }
  function resolveMode(ref2, collection) {
    const m = matchByName(ref2, collection.modes, (md) => md.name, (md) => [md.modeId]);
    if (m.kind === "one") return { ok: m.item.modeId };
    if (m.kind === "many") {
      return { error: "mode '" + ref2 + "' appears " + m.matches.length + " times in collection '" + collection.name + "' \u2014 pass its modeId: " + m.matches.slice(0, 3).map((md) => "'" + md.name + "' (" + md.modeId + ")").join(", ") };
    }
    return { error: "mode '" + ref2 + "' is not in collection '" + collection.name + "'" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") };
  }
  function modeName(collection, modeId) {
    if (modeId === void 0 || modeId === null) return INHERITED;
    const m = collection.modes.find((md) => md.modeId === modeId);
    return m ? m.name : modeId;
  }
  function applyMode(t) {
    const { node, collection, modeId } = t;
    const prev = (node.explicitVariableModes || {})[collection.id];
    if (modeId === null) node.clearExplicitVariableModeForCollection(collection);
    else node.setExplicitVariableModeForCollection(collection, modeId);
    return {
      applied: { id: node.id, collection: collection.name, from: modeName(collection, prev), to: modeName(collection, modeId) },
      kind: "variable mode change",
      what: "the '" + collection.name + "' mode on node " + node.id,
      restore() {
        if (prev === void 0) node.clearExplicitVariableModeForCollection(collection);
        else node.setExplicitVariableModeForCollection(collection, prev);
      }
    };
  }

  // src/tree-refs.ts
  var isKey = (ref2) => /^[0-9a-f]{40}$/i.test(ref2);
  function usesOf(index, s, path, out) {
    const kind = nodeKind(s);
    const op = "createTree";
    if (kind === "INSTANCE" && s.component !== void 0) out.push({ index, op, path: path + ".component", kind: "component", ref: s.component, node: s });
    if (kind === "TEXT" && s.styles && s.styles.text !== void 0) out.push({ index, op, path: path + ".styles.text", kind: "textStyle", ref: s.styles.text });
    (s.fills || []).forEach((f, i) => {
      if (f.tokens) out.push({ index, op, path: path + ".fills[" + i + "].tokens.color", kind: "variable", ref: f.tokens.color, type: "COLOR" });
    });
    const t = s.tokens || {};
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (v === void 0) continue;
      const names = typeof v === "string" ? [v] : v;
      const type = k === "fills" || k === "strokes" ? "COLOR" : "FLOAT";
      if (k === "fills" && s.fills) continue;
      names.forEach((ref2, i) => out.push({ index, op, path: path + ".tokens." + k + (names.length > 1 ? "[" + i + "]" : ""), kind: "variable", ref: ref2, type }));
    }
    (s.children || []).forEach((c, i) => usesOf(index, c, path + ".children[" + i + "]", out));
    return out;
  }
  function treeUses(specs) {
    const uses = [];
    for (const [index, spec] of specs) usesOf(index, spec, "tree", uses);
    return uses;
  }
  function patchUses(index, set) {
    const out = [];
    const op = "patch";
    (set.fills || []).forEach((f, i) => {
      if (f.tokens) out.push({ index, op, path: "set.fills[" + i + "].tokens.color", kind: "variable", ref: f.tokens.color, type: "COLOR" });
    });
    const t = set.tokens || {};
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (v === void 0 || v === null) continue;
      if (k === "fills" && set.fills) continue;
      const names = typeof v === "string" ? [v] : v;
      const type = k === "fills" || k === "strokes" ? "COLOR" : "FLOAT";
      names.forEach((ref2, i) => out.push({ index, op, path: "set.tokens." + k + (names.length > 1 ? "[" + i + "]" : ""), kind: "variable", ref: ref2, type }));
    }
    if (set.styles && set.styles.text !== void 0) out.push({ index, op, path: "set.styles.text", kind: "textStyle", ref: set.styles.text });
    return out;
  }
  var ImportsRevoked = class extends Error {
  };
  async function resolveRefs(uses, loadFont) {
    const refs2 = { instances: /* @__PURE__ */ new Map(), variables: /* @__PURE__ */ new Map(), textStyles: /* @__PURE__ */ new Map() };
    const problems = [];
    if (!uses.length) return { refs: refs2, problems, imports: async () => ({ problems: [], revoked: false }), importCount: 0 };
    const file = fileLookups();
    const found = /* @__PURE__ */ new Map();
    const lookup = (kind, ref2, run2) => {
      const k = kind + "\0" + ref2;
      let p = found.get(k);
      if (!p) {
        p = run2();
        found.set(k, p);
      }
      return p;
    };
    const report = reporter(problems);
    const bad = report.bad;
    const imported = [];
    for (const u of uses) {
      const f = u.kind === "component" ? await lookup(u.kind, u.ref, () => file.component(u.ref)) : u.kind === "variable" ? await lookup(u.kind, u.ref, () => file.variable(u.ref)) : await lookup(u.kind, u.ref, () => file.textStyle(u.ref));
      if ("error" in f) {
        bad(u, f.error);
        continue;
      }
      if ("later" in f) {
        const typed = file.libraryType(u.ref);
        if (u.kind === "variable" && typed && u.type && typed !== u.type) {
          bad(u, typeMismatch(u, typed));
          continue;
        }
        imported.push({ use: u, get: f.later });
        continue;
      }
      const err = await accept(u, f.ok, refs2, loadFont);
      if (err) bad(u, err);
    }
    report.finish();
    const importCount = new Set(imported.map((i) => i.use.kind + "\0" + i.use.ref)).size;
    return {
      refs: refs2,
      problems,
      importCount,
      async imports(allowed2) {
        const late = [];
        const lateReport = reporter(late);
        const once = /* @__PURE__ */ new Map();
        for (const { use, get } of imported) {
          const k = use.kind + "\0" + use.ref;
          let got = once.get(k);
          if (!got) {
            if (!allowed2()) return { problems: [], revoked: true };
            try {
              got = { item: await get(allowed2) };
            } catch (e) {
              if (e instanceof ImportsRevoked) return { problems: [], revoked: true };
              got = { error: e };
            }
            once.set(k, got);
          }
          if ("error" in got) {
            lateReport.bad(use, importFailed(use, got.error));
            continue;
          }
          const err = await accept(use, got.item, refs2, loadFont);
          if (err) lateReport.bad(use, err);
        }
        lateReport.finish();
        return { problems: late, revoked: false };
      }
    };
  }
  function reporter(out) {
    const reported = /* @__PURE__ */ new Map();
    return {
      bad(u, message) {
        const k = u.index + "\0" + u.kind + "\0" + u.ref + "\0" + message;
        const seen = reported.get(k);
        if (seen) {
          seen.more++;
          return;
        }
        const problem = { index: u.index, op: u.op, message: u.path + ": " + message };
        reported.set(k, { problem, more: 0 });
        out.push(problem);
      },
      finish() {
        for (const { problem, more } of reported.values()) if (more) problem.message += " (and " + more + " more place" + (more === 1 ? "" : "s") + " in this spec)";
      }
    };
  }
  function importFailed(u, e) {
    const what = u.kind === "component" ? "component" : u.kind === "variable" ? "variable" : "text style";
    return "no " + what + " in this file or an enabled library has the key '" + u.ref + "'" + (e instanceof Error && e.message ? " (" + e.message + ")" : "");
  }
  var typeMismatch = (u, actual) => "variable '" + u.ref + "' holds a " + actual.toLowerCase() + ", and this field takes a " + (u.type || "").toLowerCase() + " variable";
  async function accept(u, item, refs2, loadFont) {
    if (u.kind === "variable") {
      const v = item;
      if (u.type && v.resolvedType !== u.type) return typeMismatch(u, v.resolvedType);
      refs2.variables.set(u.ref, v);
      return null;
    }
    if (u.kind === "textStyle") {
      const st = item;
      if (st.type !== "TEXT") return "'" + u.ref + "' is a " + st.type.toLowerCase() + " style, not a text style";
      const font = st.fontName;
      const err = await loadFont(font);
      if (err) return "text style '" + st.name + "': its " + err;
      refs2.textStyles.set(u.ref, st);
      return null;
    }
    const c = item;
    const node = u.node;
    if (!node) return "no node";
    const set = c.type === "COMPONENT_SET" ? c : c.parent && c.parent.type === "COMPONENT_SET" ? c.parent : null;
    const main = c.type === "COMPONENT_SET" ? c.defaultVariant : c;
    let defs;
    try {
      defs = (set || c).componentPropertyDefinitions;
    } catch {
      defs = {};
    }
    const mapped = mapProps(node.props || {}, defs, (set || c).name);
    if ("errors" in mapped) return mapped.errors.join("; ");
    const shown2 = set ? variantFor(set, main, mapped.ok, defs) : main;
    if ("missing" in shown2) {
      const have = set ? set.children.filter((k) => k.type === "COMPONENT").map((k) => k.name) : [];
      return "component '" + (set || c).name + "' has no variant " + shown2.missing + (have.length ? "; closest: " + quoteList(nearestNames(shown2.missing, have)) : "");
    }
    if (shown2.layoutMode === "NONE") for (const axis of ["widthMode", "heightMode"]) {
      if (node[axis] === "hug") return "component '" + (set || c).name + "' has no auto-layout, so its instance cannot `" + axis + ': "hug"`';
    }
    refs2.instances.set(node, { main, props: mapped.ok });
    return null;
  }
  function variantFor(set, start, props, defs) {
    const want = {};
    const from = start.variantProperties || {};
    for (const k of Object.keys(defs)) {
      const d = defs[k];
      if (!d || d.type !== "VARIANT") continue;
      const given2 = props[k];
      const v = typeof given2 === "string" ? given2 : from[k];
      if (v !== void 0) want[k] = v;
    }
    const given = Object.keys(want).some((k) => typeof props[k] === "string");
    const matches = (c) => {
      const vp = c.variantProperties || {};
      return Object.keys(want).every((k) => vp[k] === want[k]);
    };
    if (!given || matches(start)) return start;
    for (const c of set.children) if (c.type === "COMPONENT" && matches(c)) return c;
    return { missing: Object.keys(want).map((k) => k + "=" + want[k]).join(", ") };
  }
  function mapProps(given, defs, component) {
    const keys = Object.keys(defs);
    const bare = (k) => {
      const i = k.lastIndexOf("#");
      return i > 0 ? k.slice(0, i) : k;
    };
    const ok = {};
    const errors = [];
    for (const name of Object.keys(given)) {
      const value = given[name];
      if (value === void 0) continue;
      const hits = keys.indexOf(name) >= 0 ? [name] : keys.filter((k) => bare(k) === name);
      const key = hits[0];
      if (key === void 0) {
        const near = nearestNames(name, keys.map(bare));
        errors.push("component '" + component + "' has no property '" + name + "'" + (near.length ? "; closest: " + quoteList(near) : keys.length ? "" : " (it has none)"));
        continue;
      }
      if (hits.length > 1) {
        errors.push("component '" + component + "' has " + hits.length + " properties named '" + name + "' \u2014 pass one's full key: " + quoteList(hits.slice(0, 3)));
        continue;
      }
      const def = defs[key];
      if (!def) continue;
      if (def.type === "VARIANT") {
        const options = def.variantOptions || [];
        if (typeof value !== "string" || options.indexOf(value) < 0) {
          const near = typeof value === "string" ? nearestNames(value, options) : options.slice(0, 3);
          errors.push("property '" + name + "' of '" + component + "' has no value " + JSON.stringify(value) + (near.length ? "; closest: " + quoteList(near) : ""));
          continue;
        }
      } else if (def.type === "BOOLEAN") {
        if (typeof value !== "boolean") {
          errors.push("property '" + name + "' of '" + component + "' is a boolean: give true or false");
          continue;
        }
      } else if (def.type === "TEXT") {
        if (typeof value !== "string") {
          errors.push("property '" + name + "' of '" + component + "' is a text: give a string");
          continue;
        }
      } else {
        errors.push("property '" + name + "' of '" + component + "' swaps a nested instance, which a write cannot set yet");
        continue;
      }
      ok[key] = value;
    }
    return errors.length ? { errors } : { ok };
  }
  function fileLookups() {
    let components = null;
    let variables = null;
    let styles = null;
    let library = null;
    const libraryTypes = /* @__PURE__ */ new Map();
    const allComponents = () => {
      if (!components) components = (async () => {
        const out = [];
        for (const page of figma.root.children) {
          try {
            await page.loadAsync();
            out.push(...page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }));
          } catch {
          }
        }
        return out;
      })();
      return components;
    };
    const libraryVariables = () => {
      if (!library) library = (async () => {
        const out = [];
        let colls = [];
        try {
          colls = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        } catch {
          colls = [];
        }
        for (const c of colls) {
          try {
            for (const v of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key)) out.push({ ...v, libraryName: c.libraryName });
          } catch {
          }
        }
        return out;
      })();
      return library;
    };
    const ambiguous = (what, ref2, items) => ({ error: what + " '" + ref2 + "' matches " + items.length + " " + what + "s \u2014 pass one's key or id: " + items.slice(0, 3).map((x) => "'" + x.name + "' (" + x.id + ")").join(", ") });
    const none = (what, ref2, candidates, where) => ({ error: what + " '" + ref2 + "' matches no " + what + " " + where + (candidates.length ? "; closest: " + quoteList(candidates) : "") });
    return {
      libraryType: (ref2) => libraryTypes.get(ref2),
      async component(ref2) {
        let byId = null;
        try {
          byId = /^[I\d][\d:;I-]*$/.test(ref2) ? await figma.getNodeByIdAsync(ref2) : null;
        } catch {
          byId = null;
        }
        if (byId && (byId.type === "COMPONENT" || byId.type === "COMPONENT_SET")) return { ok: byId };
        const all = await allComponents();
        const exact = all.filter((c) => c.key === ref2 || c.id === ref2);
        const first2 = exact[0];
        if (first2 && exact.length === 1) return { ok: first2 };
        if (isKey(ref2)) return { later: (allowed2) => importComponent(ref2, allowed2) };
        const named = all.filter((c) => !(c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET"));
        const m = matchByName(ref2, named, (c) => c.name);
        if (m.kind === "one") return { ok: m.item };
        if (m.kind === "many") return ambiguous("component", ref2, m.matches);
        return none("component", ref2, m.candidates, "in this file (a library component is named by its key)");
      },
      async variable(ref2) {
        let byId = null;
        try {
          byId = ref2.indexOf("VariableID:") === 0 ? await figma.variables.getVariableByIdAsync(ref2) : null;
        } catch {
          byId = null;
        }
        if (byId) return { ok: byId };
        if (!variables) variables = figma.variables.getLocalVariablesAsync();
        const locals = await variables;
        const exact = locals.filter((v) => v.id === ref2 || v.key === ref2);
        const first2 = exact[0];
        if (first2 && exact.length === 1) return { ok: first2 };
        if (isKey(ref2)) {
          const listed = (await libraryVariables()).filter((v) => v.key === ref2)[0];
          if (listed) libraryTypes.set(ref2, listed.resolvedType);
          return { later: () => figma.variables.importVariableByKeyAsync(ref2) };
        }
        const m = matchByName(ref2, locals, (v) => v.name);
        if (m.kind === "one") return { ok: m.item };
        if (m.kind === "many") return ambiguous("variable", ref2, m.matches);
        const lib = (await libraryVariables()).filter((v) => v.name === ref2);
        const one = lib[0];
        if (one && lib.length === 1) {
          libraryTypes.set(ref2, one.resolvedType);
          return { later: () => figma.variables.importVariableByKeyAsync(one.key) };
        }
        if (lib.length > 1) return { error: "variable '" + ref2 + "' matches " + lib.length + " library variables \u2014 pass one's key: " + lib.slice(0, 3).map((v) => "'" + v.name + "' in '" + v.libraryName + "' (" + v.key + ")").join(", ") };
        const near = nearestNames(ref2, [...locals.map((v) => v.name), ...(await libraryVariables()).map((v) => v.name)]);
        return none("variable", ref2, near, "in this file or an enabled library");
      },
      async textStyle(ref2) {
        if (!styles) styles = figma.getLocalTextStylesAsync();
        const locals = await styles;
        const exact = locals.filter((st) => st.id === ref2 || st.key === ref2);
        const first2 = exact[0];
        if (first2 && exact.length === 1) return { ok: first2 };
        let byId = null;
        try {
          byId = ref2.indexOf("S:") === 0 ? await figma.getStyleByIdAsync(ref2) : null;
        } catch {
          byId = null;
        }
        if (byId) return { ok: byId };
        if (isKey(ref2)) return { later: () => figma.importStyleByKeyAsync(ref2) };
        const m = matchByName(ref2, locals, (st) => st.name);
        if (m.kind === "one") return { ok: m.item };
        if (m.kind === "many") return ambiguous("text style", ref2, m.matches);
        return none("text style", ref2, m.candidates, "in this file (a library style is named by its key)");
      }
    };
  }
  async function importComponent(key, allowed2) {
    try {
      return await figma.importComponentByKeyAsync(key);
    } catch (e) {
      if (!allowed2()) throw new ImportsRevoked("'Allow edits' was turned off");
      try {
        return await figma.importComponentSetByKeyAsync(key);
      } catch {
        throw e;
      }
    }
  }

  // src/session.ts
  var created = /* @__PURE__ */ new Set();
  function markCreated(node) {
    created.add(node.id);
    if (node.type === "INSTANCE" || !("children" in node)) return;
    for (const c of node.children) markCreated(c);
  }
  function createdThisSession(id) {
    return created.has(id);
  }
  function foreignBelow(node) {
    if (!created.has(node.id)) return node;
    if (node.type === "INSTANCE" || !("children" in node)) return null;
    for (const c of node.children) {
      const f = foreignBelow(c);
      if (f) return f;
    }
    return null;
  }

  // ../bridge/src/tree-diff.ts
  var EXTRA_FIELDS = ["x", "y", "absolute", "grow", "alignSelf", "clip", "sizeLimits", "strokesInLayout"];
  function ownSpec(s) {
    const out = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k !== "children" && v !== void 0) out[k] = v;
    }
    return out;
  }
  var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  function canonical(v) {
    if (v === void 0) return "undefined";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    const o = v;
    return "{" + Object.keys(o).filter((k) => o[k] !== void 0).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  var same = (a, b) => canonical(a) === canonical(b);
  function without(o, keys) {
    if (!isObj2(o)) return void 0;
    const out = {};
    for (const k of Object.keys(o)) if (keys.indexOf(k) < 0 && o[k] !== void 0) out[k] = o[k];
    return Object.keys(out).length ? out : void 0;
  }
  function compared(s, kind) {
    const out = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (v === void 0 || k === "children" || k === "handle" || k === "renderBox" || k === "reference" || k === "key") continue;
      if (k === "box") {
        out.box = without(v, ["x", "y"]);
        continue;
      }
      if (k === "font") {
        out.font = without(v, ["weightValue"]);
        continue;
      }
      if (k === "layout") {
        out.layout = without(v, ["width", "height"]);
        continue;
      }
      out[k] = v;
    }
    if (kind === "FRAME") {
      const size2 = sizeOf(s);
      if (size2) out.box = size2;
    }
    return out;
  }
  function sizeOf(s) {
    if (s.box) return { w: s.box.w, h: s.box.h };
    const l = s.layout;
    if (!l || l.width === void 0 && l.height === void 0) return void 0;
    return { ...l.width !== void 0 ? { w: l.width } : {}, ...l.height !== void 0 ? { h: l.height } : {} };
  }
  function rebuildReason(kind, a, b, changed) {
    if (nodeKind(a) !== kind) return "its type changed";
    if (kind === "INSTANCE") {
      if (a.component !== b.component) return "its component changed";
      if (changed.indexOf("name") >= 0 && b.name === void 0) return "its name was dropped";
      if (changed.indexOf("box") >= 0 && b.box === void 0) return "its size was dropped";
      const gone = Object.keys(a.props || {}).filter((k) => !b.props || !(k in b.props));
      if (gone.length) return "a property it set was dropped";
    }
    if (kind === "TEXT") {
      for (const f of ["font", "truncate", "maxLines", "widthMode", "heightMode"]) if (changed.indexOf(f) >= 0) return "`" + f + "` changed";
      if (changed.indexOf("styles") >= 0 && !(b.styles && b.styles.text !== void 0)) return "its text style was dropped";
      if (changed.indexOf("strokes") >= 0 && a.strokes && a.strokes.align !== void 0 && !(b.strokes && b.strokes.align !== void 0)) return "its stroke alignment was dropped";
    }
    return null;
  }
  var SIDES2 = ["top", "right", "bottom", "left"];
  function translate(kind, a, b, changed) {
    const set = {};
    const tokens = {};
    const extras = [];
    const fields = [];
    const has2 = (f) => changed.indexOf(f) >= 0;
    const touch = (f) => {
      if (fields.indexOf(f) < 0) fields.push(f);
    };
    const bt = b.tokens || {};
    const at = a.tokens || {};
    if (has2("name")) {
      set.name = b.name !== void 0 ? b.name : kind === "TEXT" ? b.text || "" : "Frame";
      touch("name");
    }
    if (has2("hidden")) {
      set.hidden = b.hidden === true;
      touch("hidden");
    }
    if (has2("opacity")) {
      set.opacity = b.opacity !== void 0 ? b.opacity : 1;
      touch("opacity");
    }
    if (has2("text") && b.text !== void 0) {
      set.text = b.text;
      touch("text");
    }
    if (has2("styles") && b.styles && b.styles.text !== void 0) {
      set.styles = { text: b.styles.text };
      touch("styles");
    }
    if (has2("props") && b.props) {
      set.props = b.props;
      touch("props");
    }
    if (has2("layout") && kind === "FRAME") {
      set.layout = layoutOf(b);
      touch("layout");
    }
    if (has2("radius")) {
      const r = b.radius;
      set.radius = r === void 0 ? 0 : typeof r === "number" ? r : { tl: r.tl || 0, tr: r.tr || 0, br: r.br || 0, bl: r.bl || 0 };
      touch("radius");
    }
    if (has2("box") || kind === "TEXT" && has2("autoResize") || kind !== "TEXT" && (has2("widthMode") || has2("heightMode"))) {
      if (kind === "TEXT") {
        if (b.box) set.box = { w: b.box.w, h: b.box.h };
        set.autoResize = b.autoResize !== void 0 ? b.autoResize : b.box ? "none" : "width_and_height";
        if (has2("box")) touch("box");
        if (has2("autoResize")) touch("autoResize");
      } else {
        const size2 = kind === "FRAME" ? sizeOf(b) : b.box;
        const box = {};
        if (size2 && size2.w !== void 0 && b.widthMode === void 0 && (has2("box") || has2("widthMode"))) box.w = size2.w;
        if (size2 && size2.h !== void 0 && b.heightMode === void 0 && (has2("box") || has2("heightMode"))) box.h = size2.h;
        if (has2("box") && !size2 && b.widthMode === void 0 && b.heightMode === void 0) {
          box.w = 100;
          box.h = 100;
        }
        if (box.w !== void 0 || box.h !== void 0) {
          set.box = box;
          touch("box");
        }
      }
    }
    for (const axis of ["widthMode", "heightMode"]) {
      if (!has2(axis)) continue;
      const m = b[axis];
      set[axis] = m !== void 0 ? m : "fixed";
      touch(axis);
    }
    if (kind !== "INSTANCE" && (has2("fills") || !same(at.fills, bt.fills))) {
      if (b.fills) set.fills = b.fills;
      else if (bt.fills !== void 0) tokens.fills = bt.fills;
      else set.fills = kind === "TEXT" ? [{ type: "solid", color: b.font && b.font.color !== void 0 ? b.font.color : "#000000" }] : [];
      touch("fills");
    }
    if (kind !== "INSTANCE" && (has2("strokes") || !same(at.strokes, bt.strokes))) {
      const sa = a.strokes || {};
      const sb = b.strokes || {};
      const st = {};
      if (sb.colors) st.colors = sb.colors;
      else if (bt.strokes === void 0) st.colors = [];
      if (st.colors !== void 0 && st.colors.length && bt.strokes !== void 0) tokens.strokes = bt.strokes;
      else if (st.colors === void 0) tokens.strokes = bt.strokes !== void 0 ? bt.strokes : null;
      if (sb.weight !== void 0) st.weight = sb.weight;
      else if (sa.weight !== void 0) st.weight = 1;
      if (kind === "FRAME" && (sb.weights !== void 0 || sa.weights !== void 0)) {
        const w = {};
        for (const side of SIDES2) {
          const v = sb.weights && sb.weights[side];
          if (v !== void 0) w[side] = v;
          else if (sa.weights && sa.weights[side] !== void 0) w[side] = sb.weight !== void 0 ? sb.weight : 1;
        }
        if (Object.keys(w).length) st.weights = w;
      }
      if (sb.align !== void 0) st.align = sb.align;
      else if (sa.align !== void 0) st.align = "inside";
      if (Object.keys(st).length) set.strokes = st;
      touch("strokes");
    }
    const numberChanged = NUMBER_TOKEN_FIELDS.filter((k) => at[k] !== bt[k]);
    if (numberChanged.length) touch("tokens");
    for (const k of numberChanged) tokens[k] = bt[k] !== void 0 ? bt[k] : null;
    if (Object.keys(set).length || numberChanged.length) {
      for (const k of NUMBER_TOKEN_FIELDS) if (bt[k] !== void 0) tokens[k] = bt[k];
    }
    if (Object.keys(tokens).length) set.tokens = tokens;
    for (const f of EXTRA_FIELDS) {
      if (!has2(f)) continue;
      if ((f === "x" || f === "y") && b[f] === void 0) continue;
      if ((f === "clip" || f === "sizeLimits" || f === "strokesInLayout") && kind !== "FRAME") continue;
      extras.push(f);
      touch(f);
    }
    return { set, extras, fields };
  }
  function layoutOf(b) {
    const l = b.layout;
    if (!l || l.display !== "flex") return { mode: "absolute" };
    const column = l.flexDirection === "column";
    const out = {
      display: "flex",
      flexDirection: column ? "column" : "row",
      gap: l.gap !== void 0 ? l.gap : 0,
      padding: l.padding ? l.padding : [0, 0, 0, 0],
      justifyContent: l.justifyContent !== void 0 ? l.justifyContent : "flex-start",
      alignItems: l.alignItems !== void 0 ? l.alignItems : "flex-start",
      flexWrap: l.flexWrap === "wrap" ? "wrap" : "nowrap",
      reverseZ: l.reverseZ === true
    };
    if (l.flexWrap === "wrap") {
      if (column) out.columnGap = l.columnGap !== void 0 ? l.columnGap : 0;
      else out.rowGap = l.rowGap !== void 0 ? l.rowGap : 0;
      out.alignContent = l.alignContent !== void 0 ? l.alignContent : "auto";
    }
    return out;
  }
  function match(olds, news) {
    const out = news.map(() => null);
    const used = /* @__PURE__ */ new Set();
    news.forEach((n, i) => {
      if (n.handle === void 0) return;
      const j = olds.findIndex((o, k) => !used.has(k) && o.spec.handle === n.handle);
      if (j >= 0) {
        out[i] = olds[j] || null;
        used.add(j);
      }
    });
    const count2 = (list, name, of) => list.filter((x) => of(x) === name).length;
    news.forEach((n, i) => {
      if (out[i] || n.name === void 0) return;
      if (count2(news, n.name, (x) => x.name) !== 1 || count2(olds, n.name, (o) => o.spec.name) !== 1) return;
      const j = olds.findIndex((o, k) => !used.has(k) && o.spec.name === n.name && o.spec.handle === void 0);
      if (j >= 0) {
        out[i] = olds[j] || null;
        used.add(j);
      }
    });
    let next = 0;
    news.forEach((n, i) => {
      if (out[i]) return;
      while (next < olds.length && (used.has(next) || olds[next] && olds[next].spec.handle !== void 0)) next++;
      const o = olds[next];
      if (!o) return;
      if (n.name !== void 0 && o.spec.name !== void 0 && n.name !== o.spec.name) return;
      out[i] = o;
      used.add(next);
      next++;
    });
    return out;
  }
  function planUpdate(old, spec) {
    const plan = { updates: [], builds: [], removals: [], orders: [], stamps: [], handles: [] };
    visit(old, spec, "tree", plan);
    return plan;
  }
  function visit(old, spec, path, plan) {
    const kind = nodeKind(spec) || "FRAME";
    const a = compared(old.spec, kind);
    const b = compared(spec, kind);
    const changed = Object.keys(a).concat(Object.keys(b).filter((k) => !(k in a))).filter((k) => !same(a[k], b[k]));
    if (changed.length) {
      const t = translate(kind, old.spec, spec, changed);
      if (t.fields.length) plan.updates.push({ ref: old.ref, spec, fields: t.fields, set: Object.keys(t.set).length ? t.set : null, extras: t.extras, path });
    }
    if (!same(old.spec, ownSpec(spec))) plan.stamps.push({ ref: old.ref, spec: ownSpec(spec) });
    if (spec.handle !== void 0 && spec.handle !== old.spec.handle) plan.handles.push({ handle: spec.handle, ref: old.ref });
    if (kind !== "FRAME") return;
    const news = spec.children || [];
    const pairs = match(old.children, news);
    const order = [];
    let built = false;
    news.forEach((n, i) => {
      const at = path + ".children[" + i + "]";
      const o = pairs[i];
      const why = o ? replaceReason(o, n) : null;
      if (o && why === null) {
        visit(o, n, at, plan);
        order.push({ ref: o.ref });
        return;
      }
      order.push({ build: plan.builds.length });
      plan.builds.push({ parent: old.ref, spec: n, replaces: o ? o.ref : null, path: at });
      built = true;
    });
    const kept = new Set(pairs.filter((p) => p !== null).map((p) => p.ref));
    for (const o of old.children) if (!kept.has(o.ref)) plan.removals.push(o.ref);
    const before = old.children.filter((o) => kept.has(o.ref)).map((o) => o.ref);
    const after = order.filter((e) => "ref" in e && kept.has(e.ref)).map((e) => e.ref);
    const reordered = before.some((r, i) => r !== after[i]);
    if (built || reordered) plan.orders.push({ parent: old.ref, order });
  }
  function replaceReason(o, n) {
    const kind = nodeKind(n) || "FRAME";
    const a = compared(o.spec, kind);
    const b = compared(n, kind);
    const changed = Object.keys(a).concat(Object.keys(b).filter((k) => !(k in a))).filter((k) => !same(a[k], b[k]));
    return rebuildReason(kind, o.spec, n, changed);
  }

  // src/keyed-store.ts
  var KEY_DATA = "dtwin.key";
  var SPEC_DATA = "dtwin.spec";
  var indexEntry = (key) => "dtwin.key:" + key;
  function stampNode(n, key, spec) {
    n.setPluginData(KEY_DATA, key);
    n.setPluginData(SPEC_DATA, JSON.stringify(ownSpec(spec)));
  }
  function readIndex(key) {
    return figma.root.getPluginData(indexEntry(key));
  }
  function writeIndex(key, id) {
    figma.root.setPluginData(indexEntry(key), id);
  }

  // src/tree.ts
  var PLACE_GAP = 100;
  async function resolveTreeOps(ops) {
    const targets = /* @__PURE__ */ new Map();
    const specs = /* @__PURE__ */ new Map();
    const problems = [];
    const loaded3 = /* @__PURE__ */ new Map();
    let available = null;
    const availableNames = () => {
      if (!available) available = figma.listAvailableFontsAsync().then((fs) => fs.map((f) => f.fontName.family + " " + f.fontName.style), () => []);
      return available;
    };
    const load = (family, weight) => {
      const key = family + "|" + weight;
      let p = loaded3.get(key);
      if (!p) {
        p = figma.loadFontAsync({ family, style: weight }).then(() => null, async () => {
          const near = nearestNames(family + " " + weight, await availableNames());
          return "font '" + family + " " + weight + "' is not available in this file" + (near.length ? "; closest: " + quoteList(near) : "");
        });
        loaded3.set(key, p);
      }
      return p;
    };
    for (const [index, op] of ops.entries()) {
      if (op.op !== "createTree") continue;
      const bad = (message) => {
        problems.push({ index, op: op.op, message });
      };
      const spec = op.tree;
      if (!isTreeSpec(spec)) {
        bad("the tree spec did not pass its check");
        continue;
      }
      const summary = checkTree(spec).summary;
      const page = resolvePage(op.page);
      if ("error" in page) bad(page.error);
      const fontErrors = (await Promise.all(summary.fonts.map((f) => load(f.family, f.weight)))).filter((e) => e !== null);
      for (const e of fontErrors) bad(e);
      const axisErrors = fontErrors.length ? [] : variationProblems(spec);
      for (const e of axisErrors) bad(e);
      specs.set(index, spec);
      if ("error" in page || fontErrors.length || axisErrors.length) continue;
      await page.ok.loadAsync();
      targets.set(index, { spec, page: page.ok, summary, refs: { instances: /* @__PURE__ */ new Map(), variables: /* @__PURE__ */ new Map(), textStyles: /* @__PURE__ */ new Map() } });
    }
    const r = await resolveRefs(treeUses(specs), (f) => load(f.family, f.style));
    problems.push(...r.problems);
    for (const t of targets.values()) t.refs = r.refs;
    return { targets, problems, imports: r.imports, importCount: r.importCount };
  }
  function textsOf(s, path, out) {
    if (nodeKind(s) === "TEXT") out.push({ s, path });
    (s.children || []).forEach((c, i) => textsOf(c, path + ".children[" + i + "]", out));
    return out;
  }
  function variationProblems(spec) {
    const out = [];
    for (const { s, path } of textsOf(spec, "tree", [])) {
      const vs = s.font && s.font.variationSettings;
      if (!vs || !Object.keys(vs).length || s.styles && s.styles.text !== void 0) continue;
      const { family } = fontOf(s.font);
      let axes;
      try {
        axes = figma.getFontFamilyVariationAxes(family);
      } catch {
        axes = null;
      }
      const unknown = Object.keys(vs).filter((k) => !axes || axes.indexOf(k) < 0);
      if (!unknown.length) continue;
      out.push(path + ".font.variationSettings: " + (axes ? "'" + family + "' has no axis " + quoteList(unknown) + "; its axes are " + quoteList(axes) : "'" + family + "' is not a variable font, so it has no axes to set"));
    }
    return out;
  }
  function resolvePage(ref2) {
    if (ref2 === void 0) return { ok: figma.currentPage };
    const m = matchByName(ref2, figma.root.children, (p) => p.name, (p) => [p.id]);
    if (m.kind === "one") return { ok: m.item };
    if (m.kind === "many") return { error: "page '" + ref2 + "' matches " + m.matches.length + " pages \u2014 pass one's id: " + m.matches.slice(0, 3).map((p) => "'" + p.name + "' (" + p.id + ")").join(", ") };
    return { error: "page '" + ref2 + "' matches no page in this file" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") };
  }
  async function buildTree(t, consent2) {
    const made = newMade(t.refs);
    const root = figma.createFrame();
    const key = t.spec.key;
    const indexWas = key !== void 0 ? readIndex(key) : "";
    root.visible = false;
    try {
      applyFrame(root, t.spec, null, made);
      for (const [text, style] of made.styled) {
        await text.setTextStyleIdAsync(style.id);
        consent2();
      }
      const { x, y } = placement(t.page, root, t.spec);
      t.page.appendChild(root);
      root.x = x;
      root.y = y;
      root.visible = t.spec.hidden !== true;
      if (key !== void 0) {
        for (const [n, s] of made.pairs) stampNode(n, key, s);
        writeIndex(key, root.id);
      }
      markCreated(root);
    } catch (e) {
      try {
        root.remove();
      } catch {
      }
      throw e;
    }
    const applied = { id: root.id, created: createdCount(made) };
    if (key !== void 0) applied.key = key;
    if (made.handles.size) applied.handles = handleRecord(made.handles);
    if (t.summary.unbound) applied.unbound = t.summary.unbound;
    return {
      applied,
      kind: "created tree",
      what: "the tree '" + root.name + "' (" + root.id + ")",
      restore() {
        root.remove();
        if (key !== void 0 && readIndex(key) === root.id) writeIndex(key, indexWas);
      }
    };
  }
  function createdCount(made) {
    return made.instances ? { frames: made.frames, texts: made.texts, instances: made.instances } : { frames: made.frames, texts: made.texts };
  }
  function newMade(refs2) {
    return { frames: 0, texts: 0, instances: 0, handles: /* @__PURE__ */ new Map(), refs: refs2, styled: [], pairs: [] };
  }
  async function buildSubtree(spec, parent, made, consent2) {
    const kind = nodeKind(spec);
    const first2 = made.pairs.length;
    const styledFrom = made.styled.length;
    let node = null;
    try {
      if (kind === "TEXT") {
        const t = figma.createText();
        node = t;
        applyText(t, spec, parent, made);
      } else if (kind === "INSTANCE") node = applyInstance(spec, parent, made);
      else {
        const f = figma.createFrame();
        node = f;
        applyFrame(f, spec, parent, made);
      }
      for (const [text, style] of made.styled.slice(styledFrom)) {
        await text.setTextStyleIdAsync(style.id);
        consent2();
      }
    } catch (e) {
      const made0 = made.pairs[first2];
      const n = node || (made0 ? made0[0] : null);
      if (n) {
        try {
          n.remove();
        } catch {
        }
      }
      throw e;
    }
    if (!node) throw new Error("the subtree '" + String(spec.name) + "' was not built");
    markCreated(node);
    return node;
  }
  function handleRecord(m) {
    const out = {};
    for (const [k, v] of m) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    return out;
  }
  function occupied(c) {
    const b = "absoluteBoundingBox" in c ? c.absoluteBoundingBox : null;
    return b ? b : { x: c.x, y: c.y, width: c.width, height: c.height };
  }
  function placement(page, root, spec) {
    if (spec.x !== void 0 && spec.y !== void 0) return { x: spec.x, y: spec.y };
    let right = null;
    let top = null;
    for (const c of page.children) {
      if (c.id === root.id) continue;
      const b = occupied(c);
      right = right === null ? b.x + b.width : Math.max(right, b.x + b.width);
      top = top === null ? b.y : Math.min(top, b.y);
    }
    return {
      x: spec.x !== void 0 ? spec.x : right === null ? 0 : Math.round(right + PLACE_GAP),
      y: spec.y !== void 0 ? spec.y : top === null ? 0 : Math.round(top)
    };
  }
  var ALIGN_MAIN = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", "space-between": "SPACE_BETWEEN", "space-evenly": "SPACE_EVENLY", "space-around": "SPACE_AROUND" };
  var ALIGN_CROSS = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", baseline: "BASELINE" };
  var SIZING = { fill: "FILL", hug: "HUG" };
  function paints2(fills, names, made) {
    if (fills) return fills.map((f) => bindPaint(solid(f.color === void 0 ? "#000000" : f.color, f.opacity), f.tokens && f.tokens.color, made));
    return nameList2(names).map((n) => bindPaint(solid("#000000"), n, made));
  }
  var nameList2 = (v) => v === void 0 ? [] : typeof v === "string" ? [v] : v;
  function bindPaint(p, ref2, made) {
    if (ref2 === void 0) return p;
    return figma.variables.setBoundVariableForPaint(p, "color", variable(ref2, made));
  }
  function variable(ref2, made) {
    const v = made.refs.variables.get(ref2);
    if (!v) throw new Error("variable '" + ref2 + "' was not resolved before the batch ran");
    return v;
  }
  function bindNumbers(n, s, made) {
    const t = s.tokens;
    if (!t) return;
    for (const k of NUMBER_TOKEN_FIELDS) {
      const ref2 = t[k];
      if (ref2 !== void 0) n.setBoundVariable(k, variable(ref2, made));
    }
  }
  function solid(color, opacity) {
    const c = parseHexColor(color);
    if (!c) throw new Error("'" + color + "' is not a hex colour");
    const alpha = (c.a === void 0 ? 1 : c.a) * (opacity === void 0 ? 1 : opacity);
    return alpha < 1 ? { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: alpha } : { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
  }
  function common(n, s, parent, made) {
    if (s.name !== void 0) n.name = s.name;
    if (s.hidden && parent) n.visible = false;
    if (s.opacity !== void 0) n.opacity = s.opacity;
    const strokeNames = nameList2(s.tokens && s.tokens.strokes);
    if (s.strokes || strokeNames.length) {
      if (s.strokes && s.strokes.colors) n.strokes = s.strokes.colors.map((c, i) => bindPaint(solid(c), strokeNames[i], made));
      else if (strokeNames.length) n.strokes = paints2(void 0, strokeNames, made);
    }
    if (s.strokes) {
      if (s.strokes.weight !== void 0) n.strokeWeight = s.strokes.weight;
      const w = s.strokes.weights;
      if (w && n.type === "FRAME") {
        if (w.top !== void 0) n.strokeTopWeight = w.top;
        if (w.right !== void 0) n.strokeRightWeight = w.right;
        if (w.bottom !== void 0) n.strokeBottomWeight = w.bottom;
        if (w.left !== void 0) n.strokeLeftWeight = w.left;
      }
      if (s.strokes.align) n.strokeAlign = s.strokes.align === "inside" ? "INSIDE" : s.strokes.align === "outside" ? "OUTSIDE" : "CENTER";
    }
    if (s.handle) made.handles.set(s.handle, n.id);
    if (!parent) return;
    const inFlex = parent.layoutMode !== "NONE";
    if (inFlex) {
      if (s.absolute) n.layoutPositioning = "ABSOLUTE";
      if (s.grow !== void 0) n.layoutGrow = s.grow;
      if (s.alignSelf) n.layoutAlign = s.alignSelf === "min" ? "MIN" : s.alignSelf === "center" ? "CENTER" : s.alignSelf === "max" ? "MAX" : "STRETCH";
    }
    if (!inFlex || s.absolute) {
      if (s.x !== void 0) n.x = s.x;
      if (s.y !== void 0) n.y = s.y;
    }
  }
  function sizing(n, s) {
    if (s.widthMode) n.layoutSizingHorizontal = SIZING[s.widthMode];
    if (s.heightMode) n.layoutSizingVertical = SIZING[s.heightMode];
  }
  function applyFrame(f, s, parent, made) {
    made.frames++;
    made.pairs.push([f, s]);
    if (parent) parent.appendChild(f);
    f.fills = paints2(s.fills, s.tokens && s.tokens.fills, made);
    f.clipsContent = s.clip === true;
    if (typeof s.radius === "number") f.cornerRadius = s.radius;
    else if (s.radius) {
      if (s.radius.tl !== void 0) f.topLeftRadius = s.radius.tl;
      if (s.radius.tr !== void 0) f.topRightRadius = s.radius.tr;
      if (s.radius.br !== void 0) f.bottomRightRadius = s.radius.br;
      if (s.radius.bl !== void 0) f.bottomLeftRadius = s.radius.bl;
    }
    const l = s.layout;
    if (l && l.display === "flex") {
      f.layoutMode = l.flexDirection === "column" ? "VERTICAL" : "HORIZONTAL";
      if (l.gap !== void 0) f.itemSpacing = l.gap;
      const p = l.padding;
      if (p) {
        f.paddingTop = p[0] || 0;
        f.paddingRight = p[1] || 0;
        f.paddingBottom = p[2] || 0;
        f.paddingLeft = p[3] || 0;
      }
      if (l.justifyContent) f.primaryAxisAlignItems = ALIGN_MAIN[l.justifyContent];
      if (l.alignItems) f.counterAxisAlignItems = ALIGN_CROSS[l.alignItems];
      if (l.flexWrap) f.layoutWrap = "WRAP";
      const track = l.flexDirection === "column" ? l.columnGap : l.rowGap;
      if (l.flexWrap && track !== void 0) f.counterAxisSpacing = track;
      if (l.alignContent) f.counterAxisAlignContent = "SPACE_BETWEEN";
      if (l.reverseZ) f.itemReverseZIndex = true;
      if (s.strokesInLayout) f.strokesIncludedInLayout = true;
    }
    const w = s.box ? s.box.w : l && l.width;
    const h = s.box ? s.box.h : l && l.height;
    if (w !== void 0 && h !== void 0) f.resize(w, h);
    else if (w !== void 0 || h !== void 0) f.resize(w !== void 0 ? w : f.width, h !== void 0 ? h : f.height);
    if (l && l.display === "flex" || parent && parent.layoutMode !== "NONE") {
      f.layoutSizingHorizontal = "FIXED";
      f.layoutSizingVertical = "FIXED";
    }
    common(f, s, parent, made);
    if (s.sizeLimits) {
      const m = s.sizeLimits;
      if (m.minWidth !== void 0) f.minWidth = m.minWidth;
      if (m.maxWidth !== void 0) f.maxWidth = m.maxWidth;
      if (m.minHeight !== void 0) f.minHeight = m.minHeight;
      if (m.maxHeight !== void 0) f.maxHeight = m.maxHeight;
    }
    for (const c of s.children || []) {
      const kind = nodeKind(c);
      if (kind === "TEXT") applyText(figma.createText(), c, f, made);
      else if (kind === "INSTANCE") applyInstance(c, f, made);
      else applyFrame(figma.createFrame(), c, f, made);
    }
    sizing(f, s);
    bindNumbers(f, s, made);
  }
  function applyInstance(s, parent, made) {
    const r = made.refs.instances.get(s);
    if (!r) throw new Error("component '" + String(s.component) + "' was not resolved before the batch ran");
    made.instances++;
    const inst = r.main.createInstance();
    made.pairs.push([inst, s]);
    parent.appendChild(inst);
    if (Object.keys(r.props).length) inst.setProperties(r.props);
    if (s.box) inst.resize(s.box.w, s.box.h);
    common(inst, s, parent, made);
    sizing(inst, s);
    bindNumbers(inst, s, made);
    return inst;
  }
  function applyText(t, s, parent, made) {
    made.texts++;
    made.pairs.push([t, s]);
    parent.appendChild(t);
    const font = s.font || {};
    const styleRef = s.styles && s.styles.text;
    const style = styleRef !== void 0 ? made.refs.textStyles.get(styleRef) : void 0;
    if (styleRef !== void 0 && !style) throw new Error("text style '" + styleRef + "' was not resolved before the batch ran");
    if (style) {
      t.fontName = style.fontName;
      made.styled.push([t, style]);
    } else {
      const { family, weight } = fontOf(font);
      const vs = font.variationSettings;
      t.fontName = vs && Object.keys(vs).length ? { family, style: weight, variationSettings: vs } : { family, style: weight };
      if (font.size !== void 0) t.fontSize = font.size;
    }
    t.characters = s.text || "";
    const fillNames = s.tokens && s.tokens.fills;
    if (s.fills || fillNames !== void 0) t.fills = paints2(s.fills, fillNames, made);
    else if (font.color) t.fills = [solid(font.color)];
    if (font.align) t.textAlignHorizontal = font.align === "justified" ? "JUSTIFIED" : font.align === "center" ? "CENTER" : font.align === "right" ? "RIGHT" : "LEFT";
    if (font.valign) t.textAlignVertical = font.valign === "center" ? "CENTER" : "BOTTOM";
    if (!style) {
      if (font.lineHeight) t.lineHeight = font.lineHeight.unit === "auto" || font.lineHeight.value === void 0 ? { unit: "AUTO" } : { unit: font.lineHeight.unit === "px" ? "PIXELS" : "PERCENT", value: font.lineHeight.value };
      if (font.letterSpacing) t.letterSpacing = { unit: font.letterSpacing.unit === "px" ? "PIXELS" : "PERCENT", value: font.letterSpacing.value };
      if (font.case) t.textCase = font.case === "small_caps" ? "SMALL_CAPS" : font.case === "small_caps_forced" ? "SMALL_CAPS_FORCED" : font.case === "upper" ? "UPPER" : font.case === "lower" ? "LOWER" : "TITLE";
      if (font.decoration) t.textDecoration = font.decoration === "underline" ? "UNDERLINE" : "STRIKETHROUGH";
    }
    if (s.box) t.resize(s.box.w, s.box.h);
    if (s.autoResize) t.textAutoResize = s.autoResize === "height" ? "HEIGHT" : s.autoResize === "truncate" ? "TRUNCATE" : "WIDTH_AND_HEIGHT";
    else if (s.box) t.textAutoResize = "NONE";
    if (s.truncate) t.textTruncation = "ENDING";
    if (s.maxLines !== void 0 && s.truncate) t.maxLines = s.maxLines;
    common(t, s, parent, made);
    sizing(t, s);
    bindNumbers(t, s, made);
  }

  // src/write-batch.ts
  function batchRefusal(problems) {
    const line = (p) => "ops[" + p.index + "] (" + p.op + "): " + p.message;
    const first2 = problems[0];
    if (problems.length === 1 && first2) return line(first2) + ". Nothing was changed.";
    return problems.length + " problems \u2014 nothing was changed:\n" + problems.map(line).join("\n");
  }
  var RestoreStopped = class extends Error {
  };
  async function restoreChanges(changes, allowed2) {
    const restored = [];
    const failed = [];
    const left = [...changes].reverse();
    for (const [i, c] of left.entries()) {
      if (!allowed2()) {
        failed.push("'Allow edits' was turned off while the batch was being put back, so " + countChanges(left.slice(i)).replace(/ earlier /g, " ") + " stay applied");
        break;
      }
      try {
        await c.restore(allowed2);
        restored.push(c);
      } catch (e) {
        if (e instanceof RestoreStopped) {
          failed.push("'Allow edits' was turned off while the batch was being put back, so " + countChanges(left.slice(i)).replace(/ earlier /g, " ") + " stay applied (in part, for " + c.what + ")");
          break;
        }
        failed.push("could not undo " + c.what + " (" + errMsg(e) + ")");
      }
    }
    return { restored, failed };
  }
  function countChanges(changes) {
    const counts = /* @__PURE__ */ new Map();
    for (const c of changes) counts.set(c.kind, (counts.get(c.kind) || 0) + 1);
    return [...counts].map(([k, n]) => n + " earlier " + k + (n === 1 ? "" : "s")).join(" and ");
  }

  // src/patch.ts
  var getF = (n, k) => Reflect.get(n, k);
  function setF(n, k, v) {
    if (!Reflect.set(n, k, v)) throw new Error("cannot set " + k);
  }
  function bindField(node, k, v) {
    node.setBoundVariable(k, v);
  }
  function boundId(node, k) {
    const bv = "boundVariables" in node ? node.boundVariables : void 0;
    const a = bv && typeof bv === "object" ? getF(bv, k) : void 0;
    if (!a || typeof a !== "object") return null;
    const id = getF(a, "id");
    return typeof id === "string" ? id : null;
  }
  var has = (node, k) => k in node;
  var isFlex2 = (n) => !!n && "layoutMode" in n && n.layoutMode !== "NONE";
  var SPACING_FIELDS = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "counterAxisSpacing"];
  function layoutNow(node) {
    const mode = node && "layoutMode" in node ? node.layoutMode : "NONE";
    return { dir: mode === "VERTICAL" ? "column" : mode === "HORIZONTAL" ? "row" : "none", wrap: !!node && "layoutWrap" in node && node.layoutWrap === "WRAP" };
  }
  function directionAfter(node, set) {
    const l = set.layout;
    if (l && l.mode === "absolute") return "none";
    if (l && l.flexDirection) return l.flexDirection;
    const now = layoutNow(node).dir;
    if (now !== "none") return now;
    return l && l.display === "flex" ? "row" : "none";
  }
  function unfit(node, set) {
    const kind = [];
    const state = [];
    const say = (list) => (field, m) => {
      list.push("set." + field + ": " + m);
    };
    const fixed = say(kind), now = say(state);
    const what = "'" + node.name + "' is a " + node.type;
    for (const f of ["text", "styles", "autoResize"]) if (set[f] !== void 0 && node.type !== "TEXT") fixed(f, "only on a TEXT node; " + what);
    if (set.props !== void 0 && node.type !== "INSTANCE") fixed("props", "only on an INSTANCE node; " + what);
    if (set.fills !== void 0 && !has(node, "fills")) fixed("fills", what + ", which has no fills");
    if (set.strokes !== void 0) {
      if (!has(node, "strokes")) fixed("strokes", what + ", which has no strokes");
      else if (set.strokes.weights !== void 0 && !has(node, "strokeTopWeight")) fixed("strokes.weights", "per-side weights are not on a " + node.type + "; use `strokes.weight`");
    }
    if (set.radius !== void 0 && !has(node, "cornerRadius")) fixed("radius", what + ", which has no corner radius");
    else if (set.radius !== void 0 && node.type === "VECTOR") fixed("radius", "a vector's corner radius is set per vertex, which a patch cannot put back yet");
    else if (typeof set.radius === "object" && !has(node, "topLeftRadius")) fixed("radius", what + ", which has no per-corner radius; give one number");
    if (set.opacity !== void 0 && !has(node, "opacity")) fixed("opacity", what + ", which has no opacity");
    if (set.box !== void 0 && !has(node, "resize")) fixed("box", what + ", which cannot be resized");
    const flexAfter = directionAfter(node, set) !== "none";
    const l = set.layout;
    if (l) {
      if (!has(node, "layoutMode")) fixed("layout", what + ", which cannot have auto-layout (a frame, component or instance can)");
      else if (l.mode === void 0 && l.display === void 0 && !flexAfter) {
        const fields = Object.keys(l).filter((k) => l[k] !== void 0);
        now("layout", "'" + node.name + "' has no auto-layout, so " + fields.map((k) => "`layout." + k + "`").join(", ") + ' would do nothing; add `display: "flex"`');
      } else if (flexAfter) {
        const wraps = l.flexWrap === "wrap" || l.flexWrap === void 0 && layoutNow(node).wrap;
        for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== void 0 && !wraps) now("layout." + k, 'needs wrapping: give `flexWrap: "wrap"` (the node does not wrap)');
        const dir = directionAfter(node, set);
        if (wraps && (dir === "column" ? l.rowGap : l.columnGap) !== void 0) now("layout." + (dir === "column" ? "rowGap" : "columnGap"), "is the main-axis gap in a wrapping " + dir + "; use `gap`");
        if (l.alignItems === "baseline" && dir === "column") now("layout.alignItems", '"baseline" works only in a row; the node is a column');
      }
    }
    for (const axis of ["widthMode", "heightMode"]) {
      const m = set[axis];
      if (m === void 0) continue;
      if (!has(node, "layoutSizingHorizontal")) {
        fixed(axis, what + ", which has no sizing mode");
        continue;
      }
      if (m === "fill") {
        if (layoutNow(node.parent).dir === "none") now(axis, `"fill" needs a parent with auto-layout; '` + node.name + "''s parent has none");
        else if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") now(axis, '"fill" is not on an absolutely positioned child (it is out of the auto-layout flow)');
      }
      if (m === "hug" && node.type !== "TEXT" && !flexAfter) now(axis, `"hug" needs auto-layout on the node (or a TEXT); '` + node.name + '\' has none \u2014 add `layout: {display: "flex"}`');
    }
    const t = set.tokens || {};
    for (const k of Object.keys(t)) {
      if (t[k] === void 0) continue;
      if (k === "fills" || k === "strokes") {
        if (!has(node, k)) fixed("tokens." + k, what + ", which has no " + k);
        continue;
      }
      if (!has(node, k)) {
        fixed("tokens." + k, what + ", which has no `" + k + "` to bind");
        continue;
      }
      if (t[k] !== null && SPACING_FIELDS.indexOf(k) >= 0 && !flexAfter) now("tokens." + k, "needs auto-layout on the node; '" + node.name + "' has none");
    }
    if (t.fills === null && set.fills === void 0 && node.type === "TEXT" && node.fills === figma.mixed) now("tokens.fills", "the text's paints differ from run to run; give `fills` to replace them instead");
    return { kind, state };
  }
  async function variantProblem(node, props) {
    const main = await node.getMainComponentAsync();
    const owner = main && main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    if (!main || !owner) return null;
    let defs;
    try {
      defs = owner.componentPropertyDefinitions;
    } catch {
      defs = {};
    }
    const shown2 = variantFor(owner, main, props, defs);
    return "missing" in shown2 ? "set.props: component '" + owner.name + "' has no variant " + shown2.missing : null;
  }
  async function checkBeforeApply(t) {
    const problems = unfit(t.node, t.set).state;
    if (t.props && t.node.type === "INSTANCE") {
      const v = await variantProblem(t.node, t.props);
      if (v) problems.push(v);
    }
    if (problems.length) throw new Error(problems.join("; ") + " (checked right before this op ran, after the earlier ops of the batch)");
  }
  function changesBefore(ops, index) {
    return ops.slice(0, index).some((o) => o.op !== "setVariableMode" && o.op !== "clearVariableMode" && o.op !== "delete");
  }
  function fontsOf(t) {
    const len = t.characters.length;
    if (len > 0) return t.getRangeAllFontNames(0, len);
    return t.fontName !== figma.mixed ? [t.fontName] : [];
  }
  async function resolvePatchOps(ops) {
    const targets = /* @__PURE__ */ new Map();
    const problems = [];
    const uses = [];
    const loaded3 = /* @__PURE__ */ new Map();
    const loadFont = (f) => {
      const key = f.family + "|" + f.style;
      let p = loaded3.get(key);
      if (!p) {
        p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file");
        loaded3.set(key, p);
      }
      return p;
    };
    for (const [index, op] of ops.entries()) {
      if (op.op !== "patch") continue;
      const later = changesBefore(ops, index);
      const bad = (message) => {
        problems.push({ index, op: op.op, message });
      };
      const set = op.set;
      if (!isPatchSet(set)) {
        bad("the patch did not pass its check");
        continue;
      }
      uses.push(...patchUses(index, set));
      const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (!nd) {
        bad("no node with id '" + String(op.nodeId) + "' (invalid or removed)");
        continue;
      }
      const target = await resolvePatchNode(nd, set, later, loadFont, bad);
      if (target) targets.set(index, target);
    }
    const r = await resolveRefs(uses, loadFont);
    problems.push(...r.problems);
    for (const t of targets.values()) t.refs = r.refs;
    return { targets, problems, imports: r.imports, importCount: r.importCount };
  }
  async function resolvePatchNode(nd, set, later, loadFont, bad) {
    if (nd.type === "DOCUMENT" || nd.type === "PAGE") {
      bad("'" + nd.name + "' is a " + nd.type + "; a patch changes a layer on a page");
      return null;
    }
    const node = nd;
    const fit = unfit(node, set);
    const misfits = later ? fit.kind : [...fit.kind, ...fit.state];
    for (const m of misfits) bad(m);
    if (node.type === "TEXT") {
      for (const f of await fontsToKeep(node)) {
        const err = await loadFont(f);
        if (err) bad("'" + node.name + "' uses the " + err + ", so it cannot be changed");
      }
    }
    let props = null;
    if (set.props && node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (!main) {
        bad("set.props: the instance '" + node.name + "' has no main component to read its properties from");
        return null;
      }
      const owner = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
      let defs;
      try {
        defs = (owner || main).componentPropertyDefinitions;
      } catch {
        defs = {};
      }
      const mapped = mapProps(set.props, defs, (owner || main).name);
      if ("errors" in mapped) {
        for (const e of mapped.errors) bad("set.props: " + e);
        return null;
      }
      if (!later) {
        const v = await variantProblem(node, mapped.ok);
        if (v) {
          bad(v);
          return null;
        }
      }
      props = mapped.ok;
    }
    const bound = /* @__PURE__ */ new Map();
    for (const k of NUMBER_TOKEN_FIELDS) {
      const id = boundId(node, k);
      if (!id || bound.has(id)) continue;
      let v = null;
      try {
        v = await figma.variables.getVariableByIdAsync(id);
      } catch {
        v = null;
      }
      if (v) bound.set(id, v);
    }
    if (misfits.length) return null;
    return { node, set, unbound: checkPatch(set).summary.unbound, props, refs: { instances: /* @__PURE__ */ new Map(), variables: /* @__PURE__ */ new Map(), textStyles: /* @__PURE__ */ new Map() }, bound };
  }
  function canonical2(v) {
    if (v === void 0) return "undefined";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical2).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical2(getF(v, k))).join(",") + "}";
  }
  var same2 = (a, b) => a === b || canonical2(a) === canonical2(b);
  function putBack(n, k, v) {
    if (!same2(getF(n, k), v)) setF(n, k, v);
  }
  var LAYOUT_PROPS = [
    "layoutMode",
    "layoutWrap",
    "itemSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "counterAxisSpacing",
    "counterAxisAlignContent",
    "itemReverseZIndex"
  ];
  var STROKE_PROPS = ["strokes", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign"];
  var CORNER_PROPS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
  var RANGE_PROPS = [
    ["fontName", "FontName"],
    ["fontSize", "FontSize"],
    ["lineHeight", "LineHeight"],
    ["letterSpacing", "LetterSpacing"],
    ["textCase", "TextCase"],
    ["textDecoration", "TextDecoration"],
    ["textDecorationStyle", "TextDecorationStyle"],
    ["textDecorationOffset", "TextDecorationOffset"],
    ["textDecorationThickness", "TextDecorationThickness"],
    ["textDecorationColor", "TextDecorationColor"],
    ["textDecorationSkipInk", "TextDecorationSkipInk"],
    ["paragraphSpacing", "ParagraphSpacing"],
    ["paragraphIndent", "ParagraphIndent"],
    ["listOptions", "ListOptions"],
    ["listSpacing", "ListSpacing"],
    ["indentation", "Indentation"],
    ["hyperlink", "Hyperlink"],
    ["textWrapStyle", "TextWrapStyle"],
    ["fills", "Fills"]
  ];
  var NODE_TEXT_PROPS = ["leadingTrim", "hangingPunctuation", "hangingList"];
  var NULLABLE_ONLY_READ = ["textDecorationStyle", "textDecorationOffset", "textDecorationThickness", "textDecorationColor", "textDecorationSkipInk"];
  var SEGMENT_FIELDS = [...RANGE_PROPS.map(([f]) => f), "textStyleId", "fillStyleId", "boundVariables", "textStyleOverrides"];
  var STYLE_OWNED = {
    fontName: "SEMANTIC_WEIGHT|SEMANTIC_ITALIC",
    fontSize: null,
    lineHeight: null,
    letterSpacing: null,
    textCase: null,
    textDecoration: "TEXT_DECORATION",
    textDecorationStyle: "TEXT_DECORATION",
    textDecorationOffset: "TEXT_DECORATION",
    textDecorationThickness: "TEXT_DECORATION",
    textDecorationColor: "TEXT_DECORATION",
    textDecorationSkipInk: "TEXT_DECORATION",
    paragraphSpacing: null,
    paragraphIndent: null,
    listSpacing: null,
    hyperlink: "HYPERLINK"
  };
  var overrideNames = (r) => (r.textStyleOverrides || []).map((o) => typeof o === "string" ? o : o && typeof o === "object" ? String(getF(o, "type")) : "").filter((x) => x !== "");
  var TEXT_BINDABLE = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"];
  var call = (t, name, args) => {
    const fn = getF(t, name);
    if (typeof fn !== "function") throw new Error("this Figma version has no TextNode." + name);
    return Reflect.apply(fn, t, args);
  };
  async function fontsToKeep(t) {
    const out = fontsOf(t).slice();
    const ids = /* @__PURE__ */ new Set();
    if (t.characters.length) {
      for (const r of t.getStyledTextSegments(["textStyleId"])) if (r.textStyleId) ids.add(r.textStyleId);
    } else if (typeof t.textStyleId === "string" && t.textStyleId) ids.add(t.textStyleId);
    for (const id of ids) {
      let st = null;
      try {
        st = await figma.getStyleByIdAsync(id);
      } catch {
        st = null;
      }
      if (st && st.type === "TEXT") out.push(st.fontName);
    }
    return out;
  }
  var checker = (allowed2) => () => {
    if (!allowed2()) throw new RestoreStopped("'Allow edits' was turned off");
  };
  function keep(n, keys) {
    return keys.filter((k) => k in n).map((k) => [k, getF(n, k)]);
  }
  async function variablesById(ids) {
    const out = /* @__PURE__ */ new Map();
    for (const id of ids) {
      if (out.has(id)) continue;
      let v = null;
      try {
        v = await figma.variables.getVariableByIdAsync(id);
      } catch {
        v = null;
      }
      if (v) out.set(id, v);
    }
    return out;
  }
  async function keepText(t) {
    for (const f of await fontsToKeep(t)) {
      try {
        await figma.loadFontAsync(f);
      } catch {
        throw new Error("'" + t.name + "' uses the font '" + f.family + " " + f.style + "', which is not available, so a change to it could not be put back");
      }
    }
    const chars = t.characters;
    const runs = chars.length ? t.getStyledTextSegments([...SEGMENT_FIELDS]) : [];
    const nodeProps = keep(t, NODE_TEXT_PROPS).filter(([, v]) => v !== figma.mixed);
    const whole = chars.length ? null : {
      props: keep(t, RANGE_PROPS.map(([f]) => f)).filter(([, v]) => v !== figma.mixed && v !== null),
      textStyleId: t.textStyleId,
      fillStyleId: t.fillStyleId,
      bound: TEXT_BINDABLE.map((f) => [f, boundId(t, f)])
    };
    const ids = [];
    for (const r of runs) for (const f of TEXT_BINDABLE) {
      const a = r.boundVariables && r.boundVariables[f];
      if (a) ids.push(a.id);
    }
    if (whole) {
      for (const [, id] of whole.bound) if (id) ids.push(id);
    }
    const vars = await variablesById(ids);
    return async (allowed2) => {
      const check = checker(allowed2);
      if (t.characters !== chars) t.characters = chars;
      if (whole) {
        const style = typeof whole.textStyleId === "string" ? whole.textStyleId : null;
        if (style !== null && t.textStyleId !== style) {
          await t.setTextStyleIdAsync(style);
          check();
        }
        for (const [k, v] of whole.props) putBack(t, k, v);
        if (typeof whole.fillStyleId === "string" && whole.fillStyleId && t.fillStyleId !== whole.fillStyleId) {
          await t.setFillStyleIdAsync(whole.fillStyleId);
          check();
        }
        for (const [f, id] of whole.bound) {
          if (boundId(t, f) === id) continue;
          const v = id ? vars.get(id) : null;
          if (v !== void 0) t.setBoundVariable(f, v);
        }
        for (const [k, v] of nodeProps) putBack(t, k, v);
        return;
      }
      if (same2(t.getStyledTextSegments([...SEGMENT_FIELDS]), runs)) {
        for (const [k, v] of nodeProps) putBack(t, k, v);
        return;
      }
      for (const r of runs) {
        const s = r.start, e = r.end;
        const all = s === 0 && e === t.characters.length;
        if (t.getRangeTextStyleId(s, e) !== r.textStyleId) {
          if (all) await t.setTextStyleIdAsync(r.textStyleId);
          else await t.setRangeTextStyleIdAsync(s, e, r.textStyleId);
          check();
        }
        const had = r.textStyleId ? overrideNames(r) : null;
        for (const [f, suffix] of RANGE_PROPS) {
          if (had && Object.prototype.hasOwnProperty.call(STYLE_OWNED, f)) {
            const kind = STYLE_OWNED[f];
            if (kind === null || kind === void 0 || !kind.split("|").some((k) => had.indexOf(k) >= 0)) continue;
          }
          const want = getF(r, f);
          if (want === void 0 || want === null && NULLABLE_ONLY_READ.indexOf(f) >= 0) continue;
          const got = call(t, "getRange" + suffix, [s, e]);
          if ((got === null || got === void 0) && (want === null || want === void 0)) continue;
          if (!same2(got, want)) call(t, "setRange" + suffix, [s, e, want]);
        }
        if (r.fillStyleId && t.getRangeFillStyleId(s, e) !== r.fillStyleId) {
          if (all) await t.setFillStyleIdAsync(r.fillStyleId);
          else await t.setRangeFillStyleIdAsync(s, e, r.fillStyleId);
          check();
        }
      }
      for (const r of runs) for (const f of TEXT_BINDABLE) {
        const want = r.boundVariables && r.boundVariables[f];
        const have = t.getRangeBoundVariable(r.start, r.end, f);
        const haveId = have && have !== figma.mixed ? have.id : null;
        if (want) {
          const v = vars.get(want.id);
          if (v && haveId !== want.id) t.setRangeBoundVariable(r.start, r.end, f, v);
        } else if (have !== null) t.setRangeBoundVariable(r.start, r.end, f, null);
      }
      for (const [k, v] of nodeProps) putBack(t, k, v);
    };
  }
  function keepStyleLink(n, field) {
    const old = field in n ? getF(n, field) : void 0;
    if (typeof old !== "string" || !old) return null;
    return async (check) => {
      if (getF(n, field) === old) return;
      if (field === "fillStyleId" && "setFillStyleIdAsync" in n) await n.setFillStyleIdAsync(old);
      else if (field === "strokeStyleId" && "setStrokeStyleIdAsync" in n) await n.setStrokeStyleIdAsync(old);
      check();
    };
  }
  async function snapshot(t) {
    const n = t.node;
    const set = t.set;
    const tok = set.tokens || {};
    const steps = [];
    const before = new Map(NUMBER_TOKEN_FIELDS.filter((k) => k in n).map((k) => [k, boundId(n, k)]));
    steps.push(() => {
      for (const [k, id] of before) if (id === null && boundId(n, k) !== null) bindField(n, k, null);
    });
    if (t.props && n.type === "INSTANCE") {
      const old = {};
      const shown2 = (k) => {
        const p = n.componentProperties[k];
        return p ? JSON.stringify([p.value, p.boundVariables && p.boundVariables.value ? p.boundVariables.value.id : null]) : "";
      };
      const was = /* @__PURE__ */ new Map();
      for (const k of Object.keys(t.props)) {
        const p = n.componentProperties[k];
        if (!p) continue;
        old[k] = p.boundVariables && p.boundVariables.value ? p.boundVariables.value : p.value;
        was.set(k, shown2(k));
      }
      steps.push(() => {
        if ([...was].some(([k, v]) => shown2(k) !== v)) n.setProperties(old);
      });
    }
    const LIMITS2 = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
    const limitsTouched = LIMITS2.some((k) => tok[k] !== void 0);
    const sizeTouched = set.box !== void 0 || set.widthMode !== void 0 || set.heightMode !== void 0 || set.layout !== void 0 || set.props !== void 0 || set.autoResize !== void 0 || set.text !== void 0 || set.styles !== void 0 || tok.width !== void 0 || tok.height !== void 0 || limitsTouched;
    if (set.layout) {
      const props = keep(n, LAYOUT_PROPS);
      steps.push(() => {
        for (const [k, v] of props) putBack(n, k, v);
      });
      if ("children" in n) {
        const kids = n.children.map((k) => ({ k, at: keep(k, ["layoutPositioning", "layoutGrow", "layoutAlign"]), w: k.width, h: k.height, sizing: keep(k, ["layoutSizingHorizontal", "layoutSizingVertical"]), x: k.x, y: k.y }));
        steps.push(() => {
          const flex = isFlex2(t.node);
          for (const c of kids) {
            if (flex) for (const [k, v] of c.at) putBack(c.k, k, v);
            if ((c.k.width !== c.w || c.k.height !== c.h) && "resize" in c.k) c.k.resize(c.w, c.h);
            if (flex) for (const [k, v] of c.sizing) putBack(c.k, k, v);
            putBack(c.k, "x", c.x);
            putBack(c.k, "y", c.y);
          }
        });
      }
    }
    if (sizeTouched && "resize" in n) {
      const w = t.node.width, h = t.node.height;
      const sizing2 = keep(n, ["layoutSizingHorizontal", "layoutSizingVertical"]);
      const auto = keep(n, ["textAutoResize"]);
      const limits = limitsTouched ? keep(n, LIMITS2) : [];
      steps.push(() => {
        for (const [k, v] of limits) putBack(n, k, v);
        if ((n.width !== w || n.height !== h) && "resize" in n) n.resize(w, h);
        const inFlex = isFlex2(t.node.parent);
        for (const [k, v] of sizing2) {
          if (v === "FILL" && !inFlex) continue;
          if (v === "HUG" && t.node.type !== "TEXT" && !isFlex2(t.node)) continue;
          if (v === "FIXED" && !inFlex && !isFlex2(t.node)) continue;
          putBack(n, k, v);
        }
        for (const [k, v] of auto) putBack(n, k, v);
      });
    }
    const plain = [];
    const links = [];
    const textRuns = n.type === "TEXT" && (set.text !== void 0 || set.styles !== void 0 || set.fills !== void 0 || tok.fills !== void 0);
    const notMixed = ([, v]) => v !== figma.mixed;
    if ((set.fills !== void 0 || tok.fills !== void 0) && !textRuns) {
      plain.push(...keep(n, ["fills"]).filter(notMixed));
      const link = keepStyleLink(n, "fillStyleId");
      if (link) links.push(link);
    }
    if (set.strokes !== void 0 || tok.strokes !== void 0 || tok.strokeWeight !== void 0 || tok.strokeTopWeight !== void 0 || tok.strokeRightWeight !== void 0 || tok.strokeBottomWeight !== void 0 || tok.strokeLeftWeight !== void 0) {
      plain.push(...keep(n, STROKE_PROPS).filter(notMixed));
      const link = keepStyleLink(n, "strokeStyleId");
      if (link) links.push(link);
    }
    if (set.radius !== void 0 || CORNER_PROPS.some((k) => tok[k] !== void 0)) plain.push(...keep(n, ["cornerRadius", ...CORNER_PROPS]).filter(notMixed));
    if (set.opacity !== void 0 || tok.opacity !== void 0) plain.push(...keep(n, ["opacity"]));
    if (set.hidden !== void 0) plain.push(...keep(n, ["visible"]));
    if (set.name !== void 0) plain.push(...keep(n, ["name"]));
    const geometry = ["width", "height", ...LIMITS2];
    for (const k of Object.keys(tok)) if (geometry.indexOf(k) < 0 && NUMBER_TOKEN_FIELDS.indexOf(k) >= 0 && k in n) plain.push(...keep(n, [k]));
    steps.push(() => {
      for (const [k, v] of plain) putBack(n, k, v);
    });
    for (const link of links) steps.push(link);
    if (textRuns && n.type === "TEXT") {
      const text = await keepText(n);
      steps.push((check) => text(() => {
        check();
        return true;
      }));
    }
    steps.push(() => {
      for (const [k, id] of before) {
        if (id === null || boundId(n, k) === id) continue;
        const v = t.bound.get(id);
        if (v) bindField(n, k, v);
      }
    });
    return async (allowed2) => {
      const check = checker(allowed2);
      const failed = [];
      for (const step of steps) {
        check();
        try {
          await step(check);
        } catch (e) {
          if (e instanceof RestoreStopped) throw e;
          failed.push(errMsg(e));
        }
      }
      if (failed.length) throw new Error(failed.join("; "));
    };
  }
  var ALIGN_MAIN2 = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", "space-between": "SPACE_BETWEEN", "space-evenly": "SPACE_EVENLY", "space-around": "SPACE_AROUND" };
  var ALIGN_CROSS2 = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", baseline: "BASELINE" };
  var SIZING2 = { fill: "FILL", hug: "HUG", fixed: "FIXED" };
  var AUTO_RESIZE = { width_and_height: "WIDTH_AND_HEIGHT", height: "HEIGHT", truncate: "TRUNCATE", none: "NONE" };
  var nameList3 = (v) => v === void 0 || v === null ? [] : typeof v === "string" ? [v] : v;
  function variable2(t, ref2) {
    const v = t.refs.variables.get(ref2);
    if (!v) throw new Error("variable '" + ref2 + "' was not resolved before the batch ran");
    return v;
  }
  var bindPaint2 = (t, p, ref2) => ref2 === void 0 ? p : figma.variables.setBoundVariableForPaint(p, "color", variable2(t, ref2));
  var unbindPaints = (paints3) => paints3.map((p) => p.type === "SOLID" && p.boundVariables && p.boundVariables.color ? figma.variables.setBoundVariableForPaint(p, "color", null) : p);
  var fillPaints = (t, fills) => fills.map((f) => bindPaint2(t, solid(f.color === void 0 ? "#000000" : f.color, f.opacity), f.tokens && f.tokens.color));
  async function setFields(t, consent2) {
    const n = t.node;
    const { set } = t;
    const tok = set.tokens || {};
    if (t.props && n.type === "INSTANCE") n.setProperties(t.props);
    if (set.name !== void 0) n.name = set.name;
    if (set.hidden !== void 0) n.visible = !set.hidden;
    if (set.opacity !== void 0) setF(n, "opacity", set.opacity);
    const l = set.layout;
    if (l && "layoutMode" in n) {
      if (l.mode === "absolute") n.layoutMode = "NONE";
      else {
        const dir = directionAfter(n, set);
        const mode = dir === "column" ? "VERTICAL" : "HORIZONTAL";
        if (n.layoutMode !== mode) n.layoutMode = mode;
        if (l.flexWrap !== void 0) setF(n, "layoutWrap", l.flexWrap === "wrap" ? "WRAP" : "NO_WRAP");
        if (l.gap !== void 0) setF(n, "itemSpacing", l.gap);
        if (l.padding) {
          setF(n, "paddingTop", l.padding[0] || 0);
          setF(n, "paddingRight", l.padding[1] || 0);
          setF(n, "paddingBottom", l.padding[2] || 0);
          setF(n, "paddingLeft", l.padding[3] || 0);
        }
        if (l.justifyContent) setF(n, "primaryAxisAlignItems", ALIGN_MAIN2[l.justifyContent]);
        if (l.alignItems) setF(n, "counterAxisAlignItems", ALIGN_CROSS2[l.alignItems]);
        const track = dir === "column" ? l.columnGap : l.rowGap;
        if (track !== void 0) setF(n, "counterAxisSpacing", track);
        if (l.alignContent) setF(n, "counterAxisAlignContent", l.alignContent === "space-between" ? "SPACE_BETWEEN" : "AUTO");
        if (l.reverseZ !== void 0) setF(n, "itemReverseZIndex", l.reverseZ);
      }
    }
    const box = set.box;
    if (box && "resize" in n) {
      const fixable = isFlex2(n.parent) || isFlex2(n);
      if (n.type === "TEXT" && set.autoResize === void 0) n.textAutoResize = box.h !== void 0 ? "NONE" : "HEIGHT";
      if (fixable && box.w !== void 0) setF(n, "layoutSizingHorizontal", "FIXED");
      if (fixable && box.h !== void 0) setF(n, "layoutSizingVertical", "FIXED");
      n.resize(box.w !== void 0 ? box.w : n.width, box.h !== void 0 ? box.h : n.height);
    }
    for (const [axis, field] of [["widthMode", "layoutSizingHorizontal"], ["heightMode", "layoutSizingVertical"]]) {
      const m = set[axis];
      if (m === void 0) continue;
      if (m === "fixed" && !isFlex2(n.parent) && !isFlex2(n)) continue;
      setF(n, field, SIZING2[m]);
    }
    if (typeof set.radius === "number") setF(n, "cornerRadius", set.radius);
    else if (set.radius) {
      const r = set.radius;
      if (r.tl !== void 0) setF(n, "topLeftRadius", r.tl);
      if (r.tr !== void 0) setF(n, "topRightRadius", r.tr);
      if (r.br !== void 0) setF(n, "bottomRightRadius", r.br);
      if (r.bl !== void 0) setF(n, "bottomLeftRadius", r.bl);
    }
    if ("fills" in n) {
      if (set.fills) n.fills = fillPaints(t, set.fills);
      else if (tok.fills === null && n.fills !== figma.mixed) n.fills = unbindPaints(n.fills);
      else if (tok.fills !== void 0 && tok.fills !== null) n.fills = nameList3(tok.fills).map((ref2) => bindPaint2(t, solid("#000000"), ref2));
    }
    const st = set.strokes;
    if ("strokes" in n) {
      const strokeNames = nameList3(tok.strokes);
      if (st && st.colors) n.strokes = st.colors.map((c, i) => bindPaint2(t, solid(c), strokeNames[i]));
      else if (tok.strokes === null) n.strokes = unbindPaints(n.strokes);
      else if (strokeNames.length) n.strokes = strokeNames.map((ref2) => bindPaint2(t, solid("#000000"), ref2));
      if (st) {
        if (st.weight !== void 0) setF(n, "strokeWeight", st.weight);
        const w = st.weights;
        if (w) {
          if (w.top !== void 0) setF(n, "strokeTopWeight", w.top);
          if (w.right !== void 0) setF(n, "strokeRightWeight", w.right);
          if (w.bottom !== void 0) setF(n, "strokeBottomWeight", w.bottom);
          if (w.left !== void 0) setF(n, "strokeLeftWeight", w.left);
        }
        if (st.align) n.strokeAlign = st.align === "inside" ? "INSIDE" : st.align === "outside" ? "OUTSIDE" : "CENTER";
      }
    }
    if (n.type === "TEXT") {
      const styleRef = set.styles && set.styles.text;
      if (styleRef !== void 0) {
        const style = t.refs.textStyles.get(styleRef);
        if (!style) throw new Error("text style '" + styleRef + "' was not resolved before the batch ran");
        await n.setTextStyleIdAsync(style.id);
        consent2();
      }
      if (set.text !== void 0) n.characters = set.text;
      if (set.autoResize !== void 0) n.textAutoResize = AUTO_RESIZE[set.autoResize];
    }
    for (const k of NUMBER_TOKEN_FIELDS) {
      const ref2 = tok[k];
      if (ref2 === void 0) continue;
      bindField(n, k, ref2 === null ? null : variable2(t, ref2));
    }
  }
  async function applyPatch(t, consent2, allowed2, changes) {
    await checkBeforeApply(t);
    const restore = await snapshot(t);
    consent2();
    const applied = { id: t.node.id };
    if (t.unbound) applied.unbound = t.unbound;
    const change = { applied, kind: "patched node", what: "the changes to '" + t.node.name + "' (" + t.node.id + ")", restore };
    changes.push(change);
    try {
      await setFields(t, consent2);
    } catch (e) {
      if (allowed2()) {
        try {
          await restore(allowed2);
          changes.splice(changes.indexOf(change), 1);
        } catch {
        }
      }
      throw e;
    }
    return change;
  }

  // src/keyed.ts
  var isObj3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var label = (n) => "'" + n.name + "' (" + n.id + ")";
  async function findResult(key) {
    const id = readIndex(key);
    if (!id) return null;
    const n = await figma.getNodeByIdAsync(id);
    if (!n || n.type !== "FRAME" || n.removed || n.getPluginData(KEY_DATA) !== key) return null;
    let p = n.parent;
    while (p && p.type !== "PAGE") p = p.parent;
    if (!p || p.type !== "PAGE") return null;
    await p.loadAsync();
    return n;
  }
  function readOld(n, key) {
    let spec;
    try {
      spec = JSON.parse(n.getPluginData(SPEC_DATA));
    } catch {
      return null;
    }
    if (!isObj3(spec)) return null;
    const children = [];
    if (n.type === "FRAME") {
      for (const c of n.children) {
        if (c.getPluginData(KEY_DATA) !== key) continue;
        const o = readOld(c, key);
        if (o) children.push(o);
      }
    }
    return { ref: n, spec, children };
  }
  var MAX_STAMP_BYTES = 99e3;
  function utf8Bytes(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 128) n += 1;
      else if (c < 2048) n += 2;
      else if (c >= 55296 && c <= 56319) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }
  function oversized(s, path, out) {
    const bytes = utf8Bytes(JSON.stringify(ownSpec(s)));
    if (bytes > MAX_STAMP_BYTES) out.push(path + ": its own fields are " + bytes + " bytes, more than a keyed spec can store on a node (" + MAX_STAMP_BYTES + "); shorten its text, or leave out the key");
    (s.children || []).forEach((c, i) => oversized(c, path + ".children[" + i + "]", out));
    return out;
  }
  function foreignIn(n, key) {
    if (n.getPluginData(KEY_DATA) !== key) return n;
    if (n.type !== "FRAME") return null;
    for (const c of n.children) {
      const f = foreignIn(c, key);
      if (f) return f;
    }
    return null;
  }
  async function resolveKeyed(ops, targets) {
    const problems = [];
    const seen = /* @__PURE__ */ new Map();
    const loaded3 = /* @__PURE__ */ new Map();
    const loadFont = (f) => {
      const k = f.family + "|" + f.style;
      let p = loaded3.get(k);
      if (!p) {
        p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file");
        loaded3.set(k, p);
      }
      return p;
    };
    for (const [index, op] of ops.entries()) {
      if (op.op !== "createTree" || !isObj3(op.tree) || typeof op.tree.key !== "string") continue;
      const key = op.tree.key;
      const bad = (message) => {
        problems.push({ index, op: op.op, message });
      };
      const first2 = seen.get(key);
      if (first2 !== void 0) {
        bad("tree.key '" + key + "' is also the key of ops[" + first2 + "]; one batch updates a result once");
        continue;
      }
      seen.set(key, index);
      const t = targets.get(index);
      if (!t) continue;
      const big = oversized(t.spec, "tree", []);
      if (big.length) {
        for (const m of big) bad(m);
        continue;
      }
      const root = await findResult(key);
      if (!root) continue;
      if (op.page !== void 0 && root.parent && root.parent.id !== t.page.id) {
        bad("tree.key '" + key + "': its result " + label(root) + " is on page '" + root.parent.name + "', not '" + t.page.name + "'; an update stays where the result is \u2014 leave `page` out");
        continue;
      }
      const old = readOld(root, key);
      if (!old) {
        bad("tree.key '" + key + "': the spec stored on its result " + label(root) + " cannot be read; give the spec another key to build it again");
        continue;
      }
      const plan = planUpdate(old, t.spec);
      const before = problems.length;
      for (const b of plan.builds) {
        if (!b.replaces) continue;
        const f = foreignIn(b.replaces, key);
        if (f) bad(b.path + ": " + label(b.replaces) + " is built anew (its type, component, font or a dropped property changed), but it holds " + label(f) + ", which this key did not build; move that layer out first");
      }
      for (const r of plan.removals) {
        const f = foreignIn(r, key);
        if (f) bad("tree.key '" + key + "': " + label(r) + " is no longer in the spec, but it holds " + label(f) + ", which this key did not build; move that layer out, or keep the node in the spec");
      }
      const patches = /* @__PURE__ */ new Map();
      for (const [i, u] of plan.updates.entries()) {
        if (!u.set) continue;
        const say = (m) => bad(u.path + " (" + label(u.ref) + "): " + m);
        const checked = checkPatch(u.set);
        if (checked.problems.length) {
          for (const m of checked.problems) say(m);
          continue;
        }
        const p = await resolvePatchNode(u.ref, u.set, true, loadFont, say);
        if (!p) continue;
        p.refs = t.refs;
        patches.set(i, p);
      }
      if (problems.length === before) t.update = { key, root, plan, patches };
    }
    return { problems };
  }
  function checkRemoval(u, n) {
    if (n.removed) return;
    const f = foreignIn(n, u.key);
    if (f) throw new Error(label(n) + " is to be removed (the spec with key '" + u.key + "' no longer has it), but it now holds " + label(f) + ", which that key did not build; nothing was removed");
  }
  function removalsOf(u) {
    const out = u.plan.removals.slice();
    for (const b of u.plan.builds) if (b.replaces) out.push(b.replaces);
    return out;
  }
  var ALIGN_SELF = { min: "MIN", center: "CENTER", max: "MAX", stretch: "STRETCH" };
  var LIMITS = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
  var PLACE_FIELDS = ["absolute", "grow", "alignSelf"];
  var AFTER_FIELDS = ["clip", "sizeLimits", "strokesInLayout", "x", "y"];
  function boundTo(n, k) {
    const bv = "boundVariables" in n ? n.boundVariables : void 0;
    const a = isObj3(bv) ? bv[k] : void 0;
    return isObj3(a) && typeof a.id === "string" ? a.id : null;
  }
  function applyExtras(n, s, fields, only, variables, changes) {
    const todo = only.filter((f) => fields.indexOf(f) >= 0);
    if (!todo.length) return;
    const kept = [];
    const limits = todo.indexOf("sizeLimits") >= 0;
    const bound = limits ? LIMITS.map((k) => [k, boundTo(n, k)]) : [];
    const size2 = limits ? { w: n.width, h: n.height, sizing: ["layoutSizingHorizontal", "layoutSizingVertical"].map((k) => [k, k in n ? Reflect.get(n, k) : void 0]) } : null;
    changes.push({
      applied: { id: n.id },
      kind: "updated node",
      what: "the place, clipping or size limits of " + label(n),
      async restore() {
        for (const [k, v] of kept.slice().reverse()) Reflect.set(n, k, v);
        if (size2) {
          if ((n.width !== size2.w || n.height !== size2.h) && "resize" in n) n.resize(size2.w, size2.h);
          for (const [k, v] of size2.sizing) if (v !== void 0 && Reflect.get(n, k) !== v) Reflect.set(n, k, v);
        }
        for (const [k, id] of bound) {
          if (boundTo(n, k) === id) continue;
          const v = id ? await figma.variables.getVariableByIdAsync(id) : null;
          n.setBoundVariable(k, v);
        }
      }
    });
    const put = (k, v) => {
      if (!(k in n)) return;
      const was = Reflect.get(n, k);
      if (was === v) return;
      if (!Reflect.set(n, k, v)) throw new Error("cannot set " + k);
      kept.push([k, was]);
    };
    const parent = n.parent;
    const onPage = !parent || parent.type === "PAGE";
    const inFlex = !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
    for (const f of todo) {
      if (f === "absolute" && inFlex) put("layoutPositioning", s.absolute === true ? "ABSOLUTE" : "AUTO");
      else if (f === "grow" && inFlex) put("layoutGrow", s.grow !== void 0 ? s.grow : 0);
      else if (f === "alignSelf" && inFlex) put("layoutAlign", s.alignSelf !== void 0 ? ALIGN_SELF[s.alignSelf] : "INHERIT");
      else if (f === "clip") put("clipsContent", s.clip === true);
      else if (f === "sizeLimits") {
        for (const k of LIMITS) put(k, s.sizeLimits && s.sizeLimits[k] !== void 0 ? s.sizeLimits[k] : null);
        for (const k of LIMITS) {
          const ref2 = s.tokens && s.tokens[k];
          const v = ref2 !== void 0 ? variables.get(ref2) : void 0;
          if (v && boundTo(n, k) !== v.id) n.setBoundVariable(k, v);
        }
      } else if (f === "strokesInLayout") put("strokesIncludedInLayout", s.strokesInLayout === true);
      else if ((f === "x" || f === "y") && s[f] !== void 0 && (onPage || !inFlex || s.absolute === true)) put(f, s[f]);
    }
  }
  function arrange(parent, want) {
    for (const [i, n] of want.entries()) {
      if (n.parent !== parent) continue;
      if (parent.children[i] !== n) parent.insertChild(i, n);
    }
  }
  function applyOrder(o, built, replaced) {
    const parent = o.parent;
    const was = parent.children.slice();
    const nodes = [];
    const olds = [];
    for (const e of o.order) {
      const n = "ref" in e ? e.ref : built[e.build];
      if (n && n.parent === parent) nodes.push(n);
      const r = "build" in e ? replaced[e.build] : null;
      if (r && r.parent === parent) olds.push(r);
    }
    const seq2 = nodes.concat(olds);
    const slots = was.map((c, i) => seq2.indexOf(c) >= 0 ? i : -1).filter((i) => i >= 0);
    const want = was.slice();
    slots.forEach((slot, k) => {
      const n = seq2[k];
      if (n) want[slot] = n;
    });
    arrange(parent, want);
    return {
      applied: { id: parent.id },
      kind: "reordered frame",
      what: "the order of the layers in " + label(parent),
      restore() {
        arrange(parent, was.filter((c) => c.parent === parent));
      }
    };
  }
  function restamp(stamps, key, changes) {
    const was = stamps.map((s) => [s.ref, s.ref.getPluginData(SPEC_DATA)]);
    changes.push({
      applied: {},
      kind: "stored spec",
      what: "the spec stored on " + stamps.length + " node(s)",
      restore() {
        for (const [n, v] of was) n.setPluginData(SPEC_DATA, v);
      }
    });
    for (const s of stamps) stampNode(s.ref, key, s.spec);
  }
  async function applyUpdate(t, u, consent2, allowed2, changes) {
    const { plan, key } = u;
    const changed = [];
    for (const [i, up] of plan.updates.entries()) {
      const p = u.patches.get(i);
      if (up.extras.length) {
        consent2();
        applyExtras(up.ref, up.spec, up.extras, PLACE_FIELDS, t.refs.variables, changes);
      }
      if (p) {
        consent2();
        await applyPatch(p, consent2, allowed2, changes);
      }
      if (up.extras.length) {
        consent2();
        applyExtras(up.ref, up.spec, up.extras, AFTER_FIELDS, t.refs.variables, changes);
      }
      changed.push({ id: up.ref.id, ...up.spec.handle !== void 0 ? { handle: up.spec.handle } : {}, fields: up.fields });
    }
    const made = newMade(t.refs);
    const built = [];
    for (const b of plan.builds) {
      consent2();
      const from = made.pairs.length;
      const n = await buildSubtree(b.spec, b.parent, made, consent2);
      changes.push({ applied: { id: n.id }, kind: "created node", what: "the new node " + label(n), restore() {
        n.remove();
      } });
      for (const [m, s] of made.pairs.slice(from)) stampNode(m, key, s);
      built.push(n);
    }
    const replaced = plan.builds.map((b) => b.replaces);
    for (const o of plan.orders) {
      consent2();
      changes.push(applyOrder(o, built, replaced));
    }
    if (plan.stamps.length) {
      consent2();
      restamp(plan.stamps, key, changes);
    }
    const applied = { id: u.root.id, key };
    if (changed.length) applied.changed = changed;
    if (plan.builds.length) applied.created = createdCount(made);
    const removed = removalsOf(u).length;
    if (removed) applied.removed = removed;
    const reordered = plan.orders.filter((o) => o.order.every((e) => "ref" in e)).length;
    if (reordered) applied.reordered = reordered;
    const handles = {};
    for (const h of plan.handles) Object.defineProperty(handles, h.handle, { value: h.ref.id, enumerable: true, writable: true, configurable: true });
    for (const [h, id] of made.handles) Object.defineProperty(handles, h, { value: id, enumerable: true, writable: true, configurable: true });
    if (Object.keys(handles).length) applied.handles = handles;
    if (!changed.length && !plan.builds.length && !removed && !plan.orders.length && !applied.handles) applied.unchanged = true;
    return applied;
  }

  // src/structure.ts
  var label2 = (n) => "'" + n.name + "' (" + n.id + ")";
  var NOT_OURS = "this plugin session did not create it; a write moves or deletes only nodes it created since the plugin window was opened";
  var holds = (node, foreign) => "node " + label2(node) + " holds " + label2(foreign) + ", which this plugin session did not create; a delete takes everything below a node, and a write deletes only nodes it created since the plugin window was opened";
  function instanceAround(n) {
    for (let p = n; p; p = p.parent) if (p.type === "INSTANCE") return p;
    return null;
  }
  function within(n, of) {
    for (let p = n; p; p = p.parent) if (p.id === of.id) return true;
    return false;
  }
  function placeProblem(node, parent, index) {
    const inst = instanceAround(parent);
    if (inst) return "parent " + label2(parent) + " is " + (inst === parent ? "an instance" : "inside the instance " + label2(inst)) + ", which cannot take new children";
    if (within(parent, node)) return "parent " + label2(parent) + " is " + (parent.id === node.id ? "the node itself" : "inside the node") + "; a node cannot move into itself";
    const room = parent.children.length - (node.parent && node.parent.id === parent.id ? 1 : 0);
    if (index !== void 0 && index > room) return "index " + index + " is past the end: " + label2(parent) + " would have " + room + " other child" + (room === 1 ? "" : "ren") + " (0 is first; leave `index` out for last)";
    return null;
  }
  async function resolveStructureOps(ops, changesBefore2) {
    const moves = /* @__PURE__ */ new Map();
    const deletes = /* @__PURE__ */ new Map();
    const problems = [];
    const others = ops.some((o) => o.op !== "delete" && o.op !== "setVariableMode" && o.op !== "clearVariableMode");
    for (const [index, op] of ops.entries()) {
      if (op.op !== "move" && op.op !== "delete") continue;
      const bad = (message) => {
        problems.push({ index, op: op.op, message });
      };
      const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (!nd) {
        bad("no node with id '" + String(op.nodeId) + "' (invalid or removed)");
        continue;
      }
      if (nd.type === "DOCUMENT" || nd.type === "PAGE") {
        bad(label2(nd) + " is a " + nd.type + "; " + NOT_OURS);
        continue;
      }
      const node = nd;
      if (!createdThisSession(node.id)) {
        bad("node " + label2(node) + ": " + NOT_OURS);
        continue;
      }
      if (op.op === "delete") {
        const foreign = others ? null : foreignBelow(node);
        if (foreign) {
          bad(holds(node, foreign));
          continue;
        }
        deletes.set(index, { node });
        continue;
      }
      const pd = op.parentId ? await figma.getNodeByIdAsync(op.parentId) : null;
      if (!pd) {
        bad("no parent with id '" + String(op.parentId) + "' (invalid or removed)");
        continue;
      }
      if (pd.type === "DOCUMENT" || !("insertChild" in pd)) {
        bad("parent " + label2(pd) + " is a " + pd.type + ", which cannot have children");
        continue;
      }
      if (pd.type === "PAGE") await pd.loadAsync();
      if (!changesBefore2(index)) {
        const wrong = placeProblem(node, pd, op.index);
        if (wrong) {
          bad(wrong);
          continue;
        }
      }
      moves.set(index, { node, parent: pd, index: op.index });
    }
    return { moves, deletes, problems };
  }
  function checkDelete(t) {
    const foreign = foreignBelow(t.node);
    if (foreign) throw new Error(holds(t.node, foreign));
  }
  function applyMove(t) {
    const { node, parent } = t;
    const wrong = placeProblem(node, parent, t.index);
    if (wrong) throw new Error(wrong);
    const from = node.parent;
    if (!from || !("insertChild" in from)) throw new Error("node " + label2(node) + " has no parent to move it from");
    const at = from.children.indexOf(node);
    const x = node.x, y = node.y, w = node.width, h = node.height;
    const sizing2 = "layoutSizingHorizontal" in node ? { h: node.layoutSizingHorizontal, v: node.layoutSizingVertical } : null;
    if (t.index === void 0) parent.appendChild(node);
    else parent.insertChild(t.index, node);
    const applied = { id: node.id, parentId: parent.id };
    return {
      applied,
      kind: "moved node",
      what: "the move of " + label2(node),
      restore() {
        from.insertChild(Math.min(at, from.children.length - (node.parent && node.parent.id === from.id ? 1 : 0)), node);
        if ((node.width !== w || node.height !== h) && "resize" in node) node.resize(w, h);
        if (sizing2 && "layoutSizingHorizontal" in node) {
          const inFlex = !!node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE";
          const ownFlex = "layoutMode" in node && node.layoutMode !== "NONE";
          const fits = (m) => m === "FILL" ? inFlex : m === "HUG" ? ownFlex || node.type === "TEXT" : inFlex || ownFlex;
          if (node.layoutSizingHorizontal !== sizing2.h && fits(sizing2.h)) node.layoutSizingHorizontal = sizing2.h;
          if (node.layoutSizingVertical !== sizing2.v && fits(sizing2.v)) node.layoutSizingVertical = sizing2.v;
        }
        if (node.x !== x) node.x = x;
        if (node.y !== y) node.y = y;
      }
    };
  }
  function applyDelete(t) {
    checkDelete(t);
    const id = t.node.id;
    t.node.remove();
    return { id, deleted: true };
  }
  function nodesBelow(n, out = []) {
    out.push(n);
    if ("children" in n) for (const c of n.children) nodesBelow(c, out);
    return out;
  }
  function idsDeletedWith(n, moves) {
    const movedTo = /* @__PURE__ */ new Map();
    for (const [, m] of [...moves].sort((a, b) => a[0] - b[0])) movedTo.set(m.node.id, m.parent);
    const up = (x) => {
      const m = movedTo.get(x.id);
      return m !== void 0 ? m : x.parent;
    };
    const under = (x) => {
      const seen = /* @__PURE__ */ new Set();
      for (let p = x; p && !seen.has(p.id); p = up(p)) {
        if (p.id === n.id) return true;
        seen.add(p.id);
      }
      return false;
    };
    const candidates = [...nodesBelow(n), ...[...moves.values()].flatMap((m) => nodesBelow(m.node))];
    const out = /* @__PURE__ */ new Set();
    for (const c of candidates) if (under(c)) out.add(c.id);
    return out;
  }

  // src/writes.ts
  function solidPaint(hex2, what) {
    const c = parseHexColor(hex2);
    if (!c) throw new Error(what + ": '" + String(hex2) + "' is not a valid colour \u2014 expected " + HEX_COLOR_HINT);
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
    for (let a = p; a; a = a.parent) {
      if (a.type === "INSTANCE") throw new Error("parent '" + p.name + "' is " + (a === p ? "an instance" : "inside the instance '" + a.name + "'") + ", which cannot take new children");
    }
    if (p.type === "PAGE") await p.loadAsync();
    return p;
  }
  var EditsRevoked = class extends Error {
  };
  function consent() {
    if (!editsAllowedNow()) throw new EditsRevoked("'Allow edits' was turned off in the Design Twin plugin partway through this batch \u2014 the ops before this one were applied. Tick 'Allow edits' in the plugin window, then retry the rest.");
  }
  function createdNode(n) {
    markCreated(n);
    return { applied: { id: n.id }, kind: "created node", what: "the new node '" + n.name + "' (" + n.id + ")", restore() {
      n.remove();
    } };
  }
  async function applyWrite(op, { mode, tree, patch, move }, changes) {
    switch (op.op) {
      case "createFrame": {
        const parent = await resolveParent(op.parentId);
        const fill = op.fill ? solidPaint(op.fill, "createFrame fill") : null;
        consent();
        const f = figma.createFrame();
        const change = createdNode(f);
        changes.push(change);
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
        return change.applied;
      }
      case "createText": {
        const parent = await resolveParent(op.parentId);
        const fill = op.fill ? solidPaint(op.fill, "createText fill") : null;
        consent();
        const t = figma.createText();
        const change = createdNode(t);
        changes.push(change);
        try {
          await figma.loadFontAsync(t.fontName);
        } catch (e) {
          if (editsAllowedNow()) {
            t.remove();
            changes.pop();
          }
          throw e;
        }
        if (!editsAllowedNow()) {
          t.remove();
          changes.pop();
          consent();
        }
        t.characters = op.text || "";
        if (op.fontSize) t.fontSize = op.fontSize;
        if (fill) t.fills = [fill];
        parent.appendChild(t);
        return change.applied;
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
        if (nd.type === "TEXT") {
          const restore = await keepText(nd);
          consent();
          nd.fills = [paint];
          const change2 = { applied: ifDefined("id", op.nodeId), kind: "fill change", what: "the fill of '" + nd.name + "' (" + nd.id + ")", restore };
          changes.push(change2);
          return change2.applied;
        }
        const target = nd;
        const old = target.fills;
        const oldStyle = target.fillStyleId;
        target.fills = [paint];
        const change = {
          applied: ifDefined("id", op.nodeId),
          kind: "fill change",
          what: "the fill of '" + nd.name + "' (" + nd.id + ")",
          // The paints, then the paint style they came from (setting paints detaches it).
          async restore(allowed2) {
            target.fills = old;
            if (typeof oldStyle === "string" && oldStyle && target.fillStyleId !== oldStyle) {
              await target.setFillStyleIdAsync(oldStyle);
              if (!allowed2()) throw new RestoreStopped("'Allow edits' was turned off");
            }
          }
        };
        changes.push(change);
        return change.applied;
      }
      case "setText": {
        const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
        if (!nd) throw new Error("setText: no node with id '" + op.nodeId + "' (invalid or removed)");
        if (nd.type !== "TEXT") throw new Error("setText: node '" + nd.name + "' is a " + nd.type + ", not TEXT");
        await loadNodeFonts(nd);
        consent();
        const restore = await keepText(nd);
        consent();
        nd.characters = op.text || "";
        const change = { applied: ifDefined("id", op.nodeId), kind: "text change", what: "the text of '" + nd.name + "' (" + nd.id + ")", restore };
        changes.push(change);
        return change.applied;
      }
      // Resolved up front with the rest of the batch: here the target is known to exist and the names to match.
      case "setVariableMode":
      case "clearVariableMode": {
        if (!mode) throw new Error(op.op + ": the op was not resolved before the batch ran");
        consent();
        const change = applyMode(mode);
        changes.push(change);
        return change.applied;
      }
      // Resolved up front: its page exists, its fonts are loaded and its names resolved, so the build makes every node
      // without an await; only setting text styles awaits, and consent is checked after each (tree.ts buildTree). The
      // tree lands whole or not at all.
      case "createTree": {
        if (!tree) throw new Error("createTree: the op was not resolved before the batch ran");
        consent();
        if (tree.update) return applyUpdate(tree, tree.update, consent, editsAllowedNow, changes);
        const change = await buildTree(tree, consent);
        changes.push(change);
        return change.applied;
      }
      // Resolved up front: the node exists and has every field, the names resolved and the fonts loaded. The values it
      // replaces are kept; it puts itself back if it throws partway (patch.ts).
      case "patch": {
        if (!patch) throw new Error("patch: the op was not resolved before the batch ran");
        consent();
        return (await applyPatch(patch, consent, editsAllowedNow, changes)).applied;
      }
      case "move": {
        if (!move) throw new Error("move: the op was not resolved before the batch ran");
        consent();
        const change = applyMove(move);
        changes.push(change);
        return change.applied;
      }
      // Deletes are not run here: gatedWrites runs them after every other op (a deleted node cannot be brought back).
      case "delete":
        throw new Error("delete: deletes run after the rest of the batch");
      default:
        throw new Error("unknown write op: " + op.op);
    }
  }
  async function applyWrites(ops) {
    const list = Array.isArray(ops) ? ops : [];
    if (list.length) commitUndo();
    const r = await gatedWrites(list);
    if (list.length) commitUndo();
    announce(r);
    return r;
  }
  function commitUndo() {
    try {
      figma.commitUndo();
    } catch (e) {
      console.error("[export] figma.commitUndo failed:", e);
    }
  }
  function announce(r) {
    const n = r.applied.length;
    const edits = n + " edit" + (n === 1 ? "" : "s");
    let text = null;
    if (r.refused === "edits-off") text = n ? "Design Twin applied " + edits + ", then stopped \u2014 'Allow edits' was turned off." : "Design Twin refused an edit request \u2014 'Allow edits' is off.";
    else if (r.refused === "rejected") text = "Design Twin did not apply the edit request \u2014 it was rejected. Nothing changed.";
    else if (r.refused === "unreviewed") text = "Design Twin did not apply an edit request: " + (r.error || "nobody reviewed it.");
    else if (r.ok && n) text = "Design Twin applied " + edits + " to this file.";
    else if (!r.ok && n) text = "Design Twin applied " + edits + " that could not be put back after one failed: " + (r.error || "unknown error");
    else if (!r.ok && r.restored && r.restored.length) text = "Design Twin undid " + r.restored.length + " earlier change" + (r.restored.length === 1 ? "" : "s") + " after an edit failed: " + (r.error || "unknown error");
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
    const resolveBatch = async () => {
      const modes2 = await resolveModeOps(list);
      const trees2 = await resolveTreeOps(list);
      const keyed = await resolveKeyed(list, trees2.targets);
      const patches2 = await resolvePatchOps(list);
      const structure2 = await resolveStructureOps(list, (i) => changesBefore(list, i));
      const problems2 = [
        ...modes2.problems,
        ...trees2.problems,
        ...keyed.problems,
        ...patches2.problems,
        ...structure2.problems,
        ...deleteConflicts(list, structure2.deletes, structure2.moves),
        ...removalConflicts(list, trees2.targets, structure2.moves)
      ].sort((a, b) => a.index - b.index);
      return { modes: modes2, trees: trees2, patches: patches2, structure: structure2, problems: problems2 };
    };
    let { modes, trees, patches, structure, problems } = await resolveBatch();
    const firstProblem = problems[0];
    if (firstProblem) return { ok: false, applied, failedAt: firstProblem.index, failedOp: firstProblem.op, error: batchRefusal(problems) };
    if (list.length && await reviewWrites()) {
      if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      const review = await awaitReview(list);
      if (review.end !== "approved") return reviewRefusal(review);
      if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      ({ modes, trees, patches, structure, problems } = await resolveBatch());
      const changed = problems[0];
      if (changed) return { ok: false, applied, failedAt: changed.index, failedOp: changed.op, error: "the file changed while the write waited for review: " + batchRefusal(problems) };
      if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      commitUndo();
    }
    for (const step of [trees, patches]) {
      if (!step.importCount) continue;
      if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      const { problems: late, revoked } = await step.imports(editsAllowedNow);
      if (revoked) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      const firstLate = late[0];
      if (firstLate) {
        return { ok: false, applied, failedAt: firstLate.index, failedOp: firstLate.op, error: batchRefusal(late) };
      }
    }
    const warnings = [...trees.targets].reduce((all, [i, t]) => all.concat(t.summary.warnings.map((w) => "ops[" + i + "]." + w)), []);
    const changes = [];
    const rows = list.map(() => void 0);
    const fail = async (i, op, e) => {
      const revoked = e instanceof EditsRevoked;
      const off = revoked || !editsAllowedNow();
      const { restored, failed } = off ? { restored: [], failed: [] } : await restoreChanges(changes, editsAllowedNow);
      const back = new Set(restored);
      const kept = !revoked && off && changes.length ? "; 'Allow edits' was turned off before the batch could put back its " + countChanges(changes) + ", so they stay applied" : "";
      return {
        ok: false,
        // What stays: every change not put back (a patch stopped partway included), and the deletes already run.
        applied: [...changes.filter((c) => !back.has(c)).map((c) => c.applied), ...rows.filter((a) => a !== void 0 && a.deleted === true)],
        failedAt: i,
        failedOp: op && op.op,
        error: errMsg(e) + (failed.length ? "; " + failed.join("; ") : "") + kept,
        ...revoked ? { refused: "edits-off" } : {},
        ...restored.length ? { restored: restored.map((c) => c.applied).reverse() } : {}
      };
    };
    for (const [i, op] of list.entries()) {
      if (op.op === "delete") continue;
      try {
        rows[i] = await applyWrite(op, { mode: modes.targets.get(i), tree: trees.targets.get(i), patch: patches.targets.get(i), move: structure.moves.get(i) }, changes);
      } catch (e) {
        return fail(i, op, e);
      }
    }
    for (const [i, t] of structure.deletes) {
      const op = list[i];
      if (!op) continue;
      try {
        checkDelete(t);
      } catch (e) {
        return fail(i, op, e);
      }
    }
    for (const [i, t] of trees.targets) {
      const op = list[i];
      if (!op || !t.update) continue;
      try {
        for (const n of removalsOf(t.update)) checkRemoval(t.update, n);
      } catch (e) {
        return fail(i, op, e);
      }
    }
    for (const [i, t] of structure.deletes) {
      const op = list[i];
      if (!op) continue;
      try {
        consent();
        rows[i] = applyDelete(t);
      } catch (e) {
        const r = await fail(i, op, e);
        const gone = rows.filter((a) => a !== void 0 && a.deleted === true).length;
        return gone ? { ...r, error: r.error + "; " + gone + " node(s) deleted before it cannot be brought back" } : r;
      }
    }
    for (const [i, t] of trees.targets) {
      const op = list[i];
      if (!op || !t.update) continue;
      try {
        for (const n of removalsOf(t.update)) {
          if (n.removed) continue;
          consent();
          n.remove();
        }
      } catch (e) {
        return fail(i, op, e);
      }
    }
    const done = rows.filter((a) => a !== void 0);
    return { ok: true, applied: done, ...warnings.length ? { warnings } : {} };
  }
  function reviewRefusal(o) {
    if (o.end === "rejected") return { ok: false, applied: [], refused: "rejected", error: rejectedMessage(o.reason), ...o.reason !== void 0 ? { reason: o.reason } : {} };
    if (o.end === "edits-off" || o.end === "approved") return { ok: false, applied: [], refused: "edits-off", error: EDITS_OFF_MESSAGE };
    return { ok: false, applied: [], refused: "unreviewed", error: unreviewedMessage(o.end, REVIEW_WAIT_MS) };
  }
  function removalConflicts(list, targets, moves) {
    const gone = /* @__PURE__ */ new Map();
    for (const [i, t] of targets) {
      if (!t.update) continue;
      for (const n of removalsOf(t.update)) for (const id of idsDeletedWith(n, moves)) if (!gone.has(id)) gone.set(id, i);
    }
    const out = [];
    if (!gone.size) return out;
    for (const [index, op] of list.entries()) {
      for (const k of ["nodeId", "parentId"]) {
        const id = op[k];
        const by = id === void 0 ? void 0 : gone.get(id);
        if (by === void 0 || by === index) continue;
        out.push({ index, op: op.op, message: "`" + k + "` '" + String(id) + "' is removed by the keyed re-send in ops[" + by + "] (its spec no longer has it; removals run after every other op); drop one of the two" });
        break;
      }
    }
    return out;
  }
  function deleteConflicts(list, deletes, moves) {
    const gone = /* @__PURE__ */ new Map();
    for (const [i, t] of deletes) for (const id of idsDeletedWith(t.node, moves)) if (!gone.has(id)) gone.set(id, i);
    const out = [];
    for (const [index, op] of list.entries()) {
      for (const k of ["nodeId", "parentId"]) {
        const id = op[k];
        const by = id === void 0 ? void 0 : gone.get(id);
        if (by === void 0 || by === index) continue;
        out.push({ index, op: op.op, message: "`" + k + "` '" + String(id) + "' is deleted by ops[" + by + "] of this batch (deletes run after every other op); drop one of the two" });
        break;
      }
    }
    return out;
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
            pluginVersion: "0.1.6",
            fileKey: fileKey === void 0 ? null : fileKey,
            fileKeyAvailable: typeof fileKey === "string" && fileKey.length > 0,
            // So figma_write's dry run can say a real write would be refused before anyone sends one.
            editsAllowed: await editsAllowed(),
            // …and that it would wait for the designer's Apply or Reject in the plugin window.
            reviewWrites: await reviewWrites()
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
    "get-review-writes",
    "set-review-writes",
    "review-answer",
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
  async function runExport(label3, collect, toFiles) {
    let r;
    try {
      r = await serializeRun(collect, { source: "ui", label: label3 });
    } catch (e) {
      post2({ type: "error", message: errMsg(e) });
      return;
    }
    const { files, layerFiles, summary, warnings } = toFiles(r);
    post2({ type: "files", files, ...ifDefined("layerFiles", layerFiles), assets: r.assets, summary, warnings: warnings ? warnings.length : 0 });
  }
  var runSelection = () => runExport("current selection", () => collectSelection(), (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: exportJsonText(r.screen), copyable: true },
      { name: "variables.json", content: exportJsonText(r.variables) }
    ],
    summary: `${r.screenName} \u2014 ${r.assets.length} asset(s)`,
    warnings: r.screen.manifest && r.screen.manifest.warnings
  }));
  var SEP = "__";
  var runFull = () => runExport("design system + page frames", () => collectFull(), (r) => {
    const { meta, layerFiles, indexFiles, rootIndex } = buildPageLayout(r.layersDoc, SEP);
    const ds = buildDesignSystemLayout(r.designSystem, SEP);
    const dsParts = ds.files.filter((f) => f.path !== "design-system.json");
    const batch = [...layerFiles, ...indexFiles, ...dsParts].map((f) => ({ name: f.path, content: exportJsonText(f.data) }));
    return {
      files: [
        { name: "design-system.json", content: exportJsonText(ds.manifest) },
        { name: rootIndex, content: exportJsonText(meta) }
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
        const allowed2 = await setEditsAllowed(raw.allowed === true);
        if (!allowed2) endReviews("edits-off");
        post2({ type: "allow-edits", allowed: allowed2 });
        break;
      }
      case "get-review-writes": {
        post2({ type: "review-writes", on: await reviewWrites() });
        break;
      }
      case "set-review-writes": {
        post2({ type: "review-writes", on: await setReviewWrites(raw.on === true) });
        break;
      }
      case "review-answer": {
        if (typeof raw.id === "string") answerReview(raw.id, raw.apply === true, raw.reason);
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
