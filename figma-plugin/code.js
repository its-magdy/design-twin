// GENERATED from src/*.ts by build.js — do not edit by hand. Run `npm run build`.
"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // ../bridge/pages-layout.js
  var require_pages_layout = __commonJS({
    "../bridge/pages-layout.js"(exports, module) {
      "use strict";
      function safe2(id) {
        return String(id).replace(/[^a-zA-Z0-9]/g, "_");
      }
      function firstByName(node, name) {
        if (!node || typeof node !== "object") return null;
        if (node.name === name) return node;
        for (const c of node.children || []) {
          const found = firstByName(c, name);
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
          const found = firstText(c);
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
          const found = firstNamedText(c, name);
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
        (function walk(node) {
          if (!node || typeof node !== "object" || out.length >= n) return;
          if (node.type === "TEXT" && typeof node.text === "string") {
            const t = node.text.trim();
            if (t && !seen.has(t)) {
              seen.add(t);
              out.push(t);
            }
          }
          for (const c of node.children || []) {
            if (out.length >= n) break;
            walk(c);
          }
        })(root);
        return out;
      }
      function buildPageLayout2(layersDoc, sep) {
        const { layers, index, ...meta } = layersDoc || {};
        const join = (...parts) => ["pages"].concat(parts).join(sep);
        const byPage = /* @__PURE__ */ new Map();
        const pages = [];
        const layerFiles = [];
        const usedDirs = /* @__PURE__ */ new Set();
        const uniqueDir = (name) => {
          const base = safe2(name) || "page";
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
            bucket = { page: pageName, pageId: l.pageId, dir: uniqueDir(pageName), entries: [] };
            byPage.set(key, bucket);
            bucket.index = join(bucket.dir, "index.json");
            pages.push(bucket);
          }
          const base = safe2(l.name || "layer") + "__" + safe2(l.id) + ".json";
          layerFiles.push({
            path: join(bucket.dir, base),
            data: { name: l.name, id: l.id, page: l.page, pageId: l.pageId, tree: l.tree, reference: l.reference, devResources: l.devResources }
          });
          const title = l.tree ? deriveTitle(l.tree) : void 0;
          const texts = l.tree ? collectTexts(l.tree) : void 0;
          bucket.entries.push({ ...(index || [])[i], title, texts, file: join(bucket.dir, base) });
        });
        meta.pageDirs = pages.map((b) => ({ page: b.page, pageId: b.pageId, dir: b.dir, index: b.index, layers: b.entries.length }));
        meta.layers = pages.flatMap((b) => b.entries);
        const indexFiles = pages.map((b) => ({ path: b.index, data: { page: b.page, pageId: b.pageId, layers: b.entries } }));
        return { meta, layerFiles, indexFiles, rootIndex: join("index.json") };
      }
      var NO_PAGE_DIR = "_unfiled";
      function screenPaths(screenDoc, sep) {
        const join = (...parts) => ["pages"].concat(parts).join(sep);
        const page2 = screenDoc.page || screenDoc.screen && screenDoc.screen.page;
        const pageId = screenDoc.pageId || screenDoc.screen && screenDoc.screen.pageId;
        const dir = page2 ? safe2(page2) : NO_PAGE_DIR;
        const nodeId = screenDoc.nodeId || screenDoc.screen && screenDoc.screen.nodeId;
        const base = safe2(screenDoc.screenName || "screen") + (nodeId ? "__" + safe2(nodeId) : "");
        return {
          page: page2 || null,
          pageId: pageId || null,
          nodeId: nodeId || null,
          dir,
          base,
          screen: join(dir, base + ".json"),
          variables: join(dir, base + ".vars.json"),
          assets: join(dir, base + ".assets.json"),
          index: join(dir, "index.json"),
          rootIndex: join("index.json")
        };
      }
      function mergeScreenIndex(prev, entry) {
        const base = prev && typeof prev === "object" ? prev : {};
        const layers = Array.isArray(base.layers) ? base.layers.filter((l) => l && l.file !== entry.file) : [];
        layers.push(entry);
        return Object.assign({}, base, { page: entry.page, pageId: entry.pageId, layers });
      }
      function mergeRootIndex(prev, paths, layerCount, entry) {
        const base = prev && typeof prev === "object" ? prev : {};
        const pageDirs = Array.isArray(base.pageDirs) ? base.pageDirs.filter((p) => p && p.dir !== paths.dir) : [];
        pageDirs.push({ page: paths.page, pageId: paths.pageId, dir: paths.dir, index: paths.index, layers: layerCount });
        const result = Object.assign({}, base, { pageDirs });
        if (entry) {
          const layers = Array.isArray(base.layers) ? base.layers.filter((l) => l && l.file !== entry.file) : [];
          layers.push(entry);
          result.layers = layers;
        }
        return result;
      }
      module.exports = { buildPageLayout: buildPageLayout2, screenPaths, mergeScreenIndex, mergeRootIndex, deriveTitle, collectTexts, firstByName, firstText, safe: safe2, NO_PAGE_DIR };
    }
  });

  // ../bridge/errmsg.js
  var require_errmsg = __commonJS({
    "../bridge/errmsg.js"(exports, module) {
      "use strict";
      var errMsg2 = (e) => typeof e === "string" ? e : String(e && e.message || e);
      module.exports = { errMsg: errMsg2 };
    }
  });

  // ../bridge/svg-normalize.js
  var require_svg_normalize = __commonJS({
    "../bridge/svg-normalize.js"(exports, module) {
      "use strict";
      var NUM_RE = /-?\d+\.\d+/g;
      function normalizeSvgText2(svg) {
        return svg.replace(NUM_RE, (m) => {
          const n = Number(m);
          return Number.isFinite(n) ? n.toFixed(1) : m;
        });
      }
      function isSvgName(fileName) {
        return /\.svg$/i.test(String(fileName || ""));
      }
      module.exports = { normalizeSvgText: normalizeSvgText2, isSvgName };
    }
  });

  // ../bridge/design-system-layout.js
  var require_design_system_layout = __commonJS({
    "../bridge/design-system-layout.js"(exports, module) {
      "use strict";
      var { safe: safe2 } = require_pages_layout();
      var DIR = "design-system";
      var COMPONENTS_DIR = "components";
      var TOKENS = "tokens.json";
      var STYLES_PAINT = "styles.paint.json";
      var STYLES_TEXT = "styles.text.json";
      var STYLES_EFFECT = "styles.effect.json";
      var STYLES_GRID = "styles.grid.json";
      var COMPONENTS_LOCAL = "components.local.json";
      var COMPONENTS_LIBRARY = "components.library.json";
      var HYGIENE = "hygiene.json";
      var MANIFEST = "design-system.json";
      function isLibraryEntry(c) {
        return !!(c && c.remote === true);
      }
      function buildDesignSystemLayout2(ds, sep) {
        const d = ds || {};
        const join = (name) => DIR + (sep || "/") + name;
        const stamp = { exportedAt: d.exportedAt, file: d.file, colorProfile: d.colorProfile };
        const components = Array.isArray(d.components) ? d.components : [];
        const rawLocal = components.filter((c) => !isLibraryEntry(c));
        const library = components.filter(isLibraryEntry);
        const hygiene = Array.isArray(d.hygiene) ? d.hygiene : [];
        const usedNames = /* @__PURE__ */ new Set();
        const uniqueDetailName = (name, id) => {
          const base = safe2(name || "component") + "__" + safe2(id);
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
              data: { ...stamp, id: c.id, key: c.key, name: c.name, node }
            });
            return { ...rest, nodeFile: detailPath2 };
          }
          if (c.type !== "COMPONENT_SET" || !Array.isArray(c.variants) || !c.variants.some((v) => v && v.node)) {
            return c;
          }
          const slimVariants = c.variants.map((v) => {
            const { node, ...rest } = v || {};
            return rest;
          });
          const detailName = uniqueDetailName(c.name, c.id);
          const detailPath = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/") + detailName + ".json";
          componentFiles.push({
            path: detailPath,
            data: { ...stamp, setId: c.id, setKey: c.key, name: c.name, variants: c.variants }
          });
          return { ...c, variants: slimVariants, variantsFile: detailPath };
        });
        const styles = d.styles || {};
        const stylesPaint = Array.isArray(styles.paint) ? styles.paint : [];
        const stylesText = Array.isArray(styles.text) ? styles.text : [];
        const stylesEffect = Array.isArray(styles.effect) ? styles.effect : [];
        const stylesGrid = Array.isArray(styles.grid) ? styles.grid : [];
        const files = [
          { path: join(TOKENS), data: { ...stamp, collections: d.collections, variables: d.variables } },
          { path: join(STYLES_PAINT), data: { ...stamp, styles: stylesPaint } },
          { path: join(STYLES_TEXT), data: { ...stamp, styles: stylesText } },
          { path: join(STYLES_EFFECT), data: { ...stamp, styles: stylesEffect } },
          { path: join(STYLES_GRID), data: { ...stamp, styles: stylesGrid } },
          { path: join(COMPONENTS_LOCAL), data: { ...stamp, components: local } },
          { path: join(COMPONENTS_LIBRARY), data: { ...stamp, components: library } },
          { path: join(HYGIENE), data: { ...stamp, hygiene } },
          ...componentFiles
        ];
        const counts = {
          collections: (d.collections || []).length,
          variables: (d.variables || []).length,
          stylesPaint: stylesPaint.length,
          stylesText: stylesText.length,
          stylesEffect: stylesEffect.length,
          stylesGrid: stylesGrid.length,
          components: local.length,
          libraryComponents: library.length,
          hygiene: hygiene.length
        };
        const manifest2 = {
          ...stamp,
          files: {
            tokens: join(TOKENS),
            stylesPaint: join(STYLES_PAINT),
            stylesText: join(STYLES_TEXT),
            stylesEffect: join(STYLES_EFFECT),
            stylesGrid: join(STYLES_GRID),
            componentsLocal: join(COMPONENTS_LOCAL),
            componentsLibrary: join(COMPONENTS_LIBRARY),
            hygiene: join(HYGIENE)
          },
          counts
        };
        const detailPrefix = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/");
        if (files.some((f) => String(f.path).startsWith(detailPrefix))) {
          manifest2.files.componentsDir = DIR + (sep || "/") + COMPONENTS_DIR;
        }
        files.push({ path: MANIFEST, data: manifest2 });
        return { files, manifest: manifest2, counts, dir: DIR };
      }
      module.exports = {
        buildDesignSystemLayout: buildDesignSystemLayout2,
        isLibraryEntry,
        DESIGN_SYSTEM_DIR: DIR,
        DESIGN_SYSTEM_FILES: {
          TOKENS,
          STYLES_PAINT,
          STYLES_TEXT,
          STYLES_EFFECT,
          STYLES_GRID,
          COMPONENTS_LOCAL,
          COMPONENTS_LIBRARY,
          COMPONENTS_DIR,
          HYGIENE,
          MANIFEST
        }
      };
    }
  });

  // ../bridge/read-opts.js
  var require_read_opts = __commonJS({
    "../bridge/read-opts.js"(exports, module) {
      "use strict";
      var READ_OPTS = [
        {
          name: "css",
          flag: "--css",
          describe: "Include Figma's OWN computed CSS per node (getCSSAsync) \u2014 the design-to-code oracle. One async call per node, so larger/slower; use for a screen you're implementing."
        },
        {
          // NOT "Dev Mode only": per developers.figma.com only addMeasurement/editMeasurement/
          // deleteMeasurement carry that restriction — PageNode.getMeasurements() has no such note. And no
          // longer "current page": collect.ts reads measurements from the page(s) actually exported.
          name: "measurements",
          flag: "--measurements",
          describe: "Include measurement redlines (spacing specs the designer placed) for the exported page(s). Reading them does not require Dev Mode."
        },
        {
          name: "pluginData",
          flag: "--plugin-data",
          describe: "Include own-scope plugin data (getPluginData) stamped on nodes \u2014 round-trip metadata. Usually empty unless the write plane wrote it."
        },
        {
          name: "motion",
          flag: "--motion",
          describe: "Include motion/animation reads (timelines, manual keyframe tracks, animations, applied animation styles). Free via the Plugin API; useful for Slides/prototype animation. Can be verbose."
        },
        {
          name: "sharedData",
          flag: "--shared-data",
          describe: "Include cross-plugin shared data (getSharedPluginData) \u2014 notably Tokens Studio applied tokens (the semantic token layer on files without native Figma Variables). Free; per-node."
        },
        {
          name: "variantVisuals",
          flag: "--variant-visuals",
          describe: "Walk each COMPONENT_SET's variant children and record their real layout/fills/radius/tokens/css \u2014 the master-component source of truth, not the component-set wrapper's own selection-chrome visuals. One node walk per variant; noticeably slower on large systems."
        },
        {
          // The odd one out: the others ADD work, this one REMOVES it. Asset export is one exportAsync (a
          // real render round-trip — SVG per vector, 2x PNG per image) PER NODE, run sequentially, and
          // unlike getCSSAsync it was never gated despite being the same O(nodes) shape and far more
          // expensive. On a real design-system page it dominates the export and can outgrow the bridge's
          // frame limit. Opt-IN to skipping, so the default stays exactly as it was.
          name: "skipAssets",
          flag: "--no-assets",
          describe: "Skip the per-node SVG/PNG render pass \u2014 the dominant cost on a big file. Structure, layout and tokens are unaffected; skipped nodes stay leaves marked `assetSkipped: true`. Asset BYTES are stripped from MCP results anyway, so this is usually pure savings here."
        }
      ];
      function readOptDefaults2() {
        const o = {};
        for (const d of READ_OPTS) o[d.name] = false;
        return o;
      }
      module.exports = { READ_OPTS, readOptDefaults: readOptDefaults2 };
    }
  });

  // ../bridge/node-id.js
  var require_node_id = __commonJS({
    "../bridge/node-id.js"(exports, module) {
      "use strict";
      var ID = "[A-Za-z0-9%:;_-]+";
      var NODE_ID_RE = new RegExp("node-id=(" + ID + ")");
      function decode(s) {
        try {
          return decodeURIComponent(s);
        } catch (e) {
          return s;
        }
      }
      function normalizeNodeId(raw) {
        if (!raw) return void 0;
        const s = decode(String(raw).trim()).replace(/-/g, ":");
        return /^I?\d+:\d+(?:[;:]\d+:\d+)*$/.test(s) || /^\d+$/.test(s) ? s : void 0;
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
      function toNodeId2(raw) {
        return parseNodeId(raw) || (raw == null ? "" : String(raw));
      }
      module.exports = { ID, parseNodeId, toNodeId: toNodeId2 };
    }
  });

  // src/util.ts
  var import_pages_layout = __toESM(require_pages_layout());
  var import_errmsg = __toESM(require_errmsg());
  var import_svg_normalize = __toESM(require_svg_normalize());
  var exportedAt = () => (/* @__PURE__ */ new Date()).toISOString();
  var round = (n) => typeof n === "number" ? Math.round(n * 100) / 100 : n;
  var propName = (k) => k.split("#")[0];
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
  function numProp(node, key) {
    const v = node[key];
    return typeof v === "number" ? v : void 0;
  }
  function anyProp(node, key) {
    return node[key];
  }
  function rgbaToHex(c) {
    const to = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
    const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
    return c.a !== void 0 && c.a < 1 ? `${hex}${to(c.a)}` : hex;
  }
  var solidHex = (p) => rgbaToHex({ ...p.color, a: p.opacity });
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
      const t = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
      chunk += B64[t >> 18 & 63] + B64[t >> 12 & 63] + (i + 1 < n ? B64[t >> 6 & 63] : "=") + (i + 2 < n ? B64[t & 63] : "=");
      if (chunk.length >= B64_CHUNK) {
        out += chunk;
        chunk = "";
      }
    }
    return out + chunk;
  }

  // src/main.ts
  var import_pages_layout2 = __toESM(require_pages_layout());
  var import_design_system_layout = __toESM(require_design_system_layout());

  // src/progress.ts
  var CANCELLED_MESSAGE = "export cancelled by the designer in Figma";
  var CANCELLED = "__designTwinCancelled";
  function cancelledError() {
    const e = new Error(CANCELLED_MESSAGE);
    e[CANCELLED] = true;
    return e;
  }
  var running = null;
  var cancelRequested = false;
  var lastPost = 0;
  var page;
  var MIN_INTERVAL_MS = 250;
  function post(m) {
    try {
      if (figma && figma.ui && typeof figma.ui.postMessage === "function") figma.ui.postMessage(m);
    } catch (e) {
    }
  }
  function beginRun(info) {
    running = info;
    cancelRequested = false;
    page = void 0;
    lastPost = 0;
    post({ type: "run-begin", source: info.source, label: info.label });
  }
  function endRun() {
    running = null;
    cancelRequested = false;
    page = void 0;
    post({ type: "run-end" });
  }
  function requestCancel() {
    if (!running) return null;
    cancelRequested = true;
    return running;
  }
  function checkCancelled() {
    if (cancelRequested) throw cancelledError();
  }
  function progress(phase, extra, force) {
    if (!running) return;
    const now = Date.now();
    if (!force && now - lastPost < MIN_INTERVAL_MS) return;
    lastPost = now;
    post({ type: "progress", phase, source: running.source, label: running.label, page, ...extra });
  }
  function enterPage(phase, index, of, name, pageId, extra) {
    page = { index, of, name, pageId };
    progress(phase, extra, true);
  }

  // src/assets.ts
  var ASSET_DIR = "assets/";
  function contentHash(a) {
    const src = a.text != null ? (0, import_svg_normalize.normalizeSvgText)(a.text) : a.base64 != null ? a.base64 : "";
    let h = 2166136261;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0") + "-" + src.length.toString(36);
  }
  var byContent = /* @__PURE__ */ new Map();
  var byName = /* @__PURE__ */ new Map();
  function resetAssetNames() {
    byContent.clear();
    byName.clear();
  }
  function assetSafe(x) {
    return String(x).replace(/[^a-zA-Z0-9-]+/g, "_").replace(/_+/g, "_");
  }
  function baseNameFor(a) {
    if (a.kind === "reference") return (0, import_pages_layout.safe)(a.id.replace(/:ref$/, "")) + "_ref";
    if (a.kind === "source") return (0, import_pages_layout.safe)(a.id);
    const last = String(a.name || "").split("/").pop() || "";
    const cleaned = assetSafe(last.trim()).replace(/^[-_]+|[-_]+$/g, "");
    return cleaned || (0, import_pages_layout.safe)(a.id);
  }
  function register(a) {
    const fmt = (0, import_pages_layout.safe)(a.format);
    const dedupable = a.kind !== "reference";
    const hash = contentHash(a);
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
      file = base + "-" + hash.split("-")[0].slice(0, 6) + "." + fmt;
    }
    byName.set(file.toLowerCase(), hash);
    const asset = { ...a, file, hash };
    assets.push(asset);
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
    const f = figma;
    if (!hash || typeof f.getImageByHash !== "function") return Promise.resolve(void 0);
    let p = imageSizeCache.get(hash);
    if (!p) {
      p = readSourceImage(f, hash);
      imageSizeCache.set(hash, p);
    }
    return p;
  }
  async function readSourceImage(f, hash) {
    let size;
    try {
      const img = f.getImageByHash(hash);
      if (img) {
        if (typeof img.getSizeAsync === "function") {
          const s = await img.getSizeAsync();
          if (s && typeof s.width === "number") size = { w: s.width, h: s.height };
        }
        if (typeof img.getBytesAsync === "function") {
          try {
            const bytes = await img.getBytesAsync();
            if (bytes && bytes.length) register({ id: "img:" + hash, name: hash, format: imageFormat(bytes), base64: toBase64(bytes), kind: "source" });
          } catch (e) {
          }
        }
      }
    } catch (e) {
      warn("source image unavailable for hash " + hash + " (" + (0, import_errmsg.errMsg)(e) + ")");
    }
    return size;
  }
  var VECTOR_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON", "ELLIPSE"]);
  var ICON_CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "INSTANCE", "GROUP", "COMPONENT"]);
  function paints(v) {
    return Array.isArray(v) ? v : null;
  }
  function hasVisiblePaint(n, fills) {
    if (fills && fills.some((p) => p.visible !== false)) return true;
    const s = paints(n.strokes);
    return !!s && s.some((p) => p.visible !== false);
  }
  function hasArea(n) {
    if (typeof n.width !== "number" || typeof n.height !== "number") return true;
    return n.width > 0 && n.height > 0;
  }
  function geometryOf(n) {
    const ds = (g) => Array.isArray(g) ? g.map((p) => p && p.data).filter((d) => typeof d === "string" && !!d) : [];
    const fills = ds(n.fillGeometry);
    const strokes = ds(n.strokeGeometry);
    if (!fills.length && !strokes.length) return void 0;
    const out = {};
    if (fills.length) out.fills = fills;
    if (strokes.length) out.strokes = strokes;
    if (typeof n.width === "number") {
      out.w = round(n.width);
      out.h = round(n.height);
    }
    return out;
  }
  async function collectAsset(node) {
    const isVector = VECTOR_TYPES.has(node.type);
    const n = node;
    const fills = "fills" in node && Array.isArray(n.fills) ? n.fills : null;
    const kids = "children" in node && Array.isArray(n.children) ? n.children : null;
    const hasImage = !!fills && fills.some((f) => f.type === "IMAGE" && f.visible !== false) && !(kids && kids.length > 0);
    let iconLike = false;
    if (ICON_CONTAINER_TYPES.has(node.type) && node.name && /icon|logo|illustration|avatar/i.test(node.name) && "width" in node && Math.max(n.width, n.height) <= 96) {
      try {
        iconLike = !n.findOne((x) => x.type === "TEXT");
      } catch (e) {
        iconLike = false;
      }
    }
    if (!iconLike && ICON_CONTAINER_TYPES.has(node.type) && n.isAsset === true) {
      try {
        iconLike = !n.findOne((x) => x.type === "TEXT");
      } catch (e) {
        iconLike = false;
      }
    }
    if (runOpts.skipAssets && (isVector || iconLike || hasImage)) {
      stats.assetsSkipped++;
      return { skipped: true };
    }
    if (isVector || iconLike || hasImage) {
      checkCancelled();
      progress("assets", { nodes: stats.nodes, assets: assets.length });
    }
    if (isVector || iconLike) {
      if (!hasArea(n) || isVector && !hasVisiblePaint(n, fills)) {
        stats.assetsSkippedInvisible++;
        return void 0;
      }
      let svg = null;
      let reason = "empty/invalid SVG";
      try {
        svg = await node.exportAsync({ format: "SVG_STRING" });
      } catch (e) {
        reason = (0, import_errmsg.errMsg)(e);
      }
      if (svg && svg.indexOf("<svg") !== -1) {
        return { path: register({ id: node.id, name: node.name, format: "svg", text: svg }) };
      }
      const geo = geometryOf(n);
      if (geo) {
        stats.assetsGeometry++;
        return { geometry: geo };
      }
      stats.assetsFailed++;
      warnKind("asset export failed (no geometry to fall back on)", node.name + " (" + node.id + "): " + reason);
      return void 0;
    }
    try {
      if (hasImage) {
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 }, useAbsoluteBounds: true });
        if (!bytes || !bytes.length) {
          stats.assetsFailed++;
          warnKind("image asset export empty", node.name + " (" + node.id + ")");
          return void 0;
        }
        return { path: register({ id: node.id, name: node.name, format: "png", base64: toBase64(bytes) }) };
      }
    } catch (e) {
      stats.assetsFailed++;
      warnKind("image asset export failed", node.name + " (" + node.id + "): " + (0, import_errmsg.errMsg)(e));
    }
    return void 0;
  }
  async function collectReference(node, opts) {
    const n = node;
    if (!node || !("exportAsync" in node) || !("width" in node)) return void 0;
    try {
      const value = opts && typeof opts.scale === "number" && opts.scale > 0 ? opts.scale : Math.min(2, 2048 / (Math.max(n.width || 0, n.height || 0) || 1));
      const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
      if (!bytes || !bytes.length) {
        warn("reference screenshot empty: " + node.name);
        return void 0;
      }
      return register({ id: node.id + ":ref", name: node.name + " (reference)", format: "png", base64: toBase64(bytes), kind: "reference" });
    } catch (e) {
      warn("reference screenshot failed: " + node.name + " (" + (0, import_errmsg.errMsg)(e) + ")");
      return void 0;
    }
  }
  async function devResources(node) {
    const n = node;
    if (!node || typeof n.getDevResourcesAsync !== "function") return void 0;
    try {
      const rs = await n.getDevResourcesAsync({ includeChildren: true });
      if (!Array.isArray(rs) || !rs.length) return void 0;
      return rs.map((r) => {
        const o = { name: r.name, url: r.url };
        if (r.nodeId) o.nodeId = r.nodeId;
        if (r.inheritedNodeId) o.inheritedNodeId = r.inheritedNodeId;
        return o;
      });
    } catch (e) {
      warn("dev resources unavailable for '" + node.name + "' (" + (0, import_errmsg.errMsg)(e) + ")");
      return void 0;
    }
  }

  // src/state.ts
  var import_read_opts = __toESM(require_read_opts());
  var assets = [];
  var runOpts = (0, import_read_opts.readOptDefaults)();
  var imageSizeCache = /* @__PURE__ */ new Map();
  var warnings = [];
  var newStats = () => ({ nodes: 0, assetsFailed: 0, assetsSkipped: 0, assetsSkippedInvisible: 0, assetsGeometry: 0, truncated: 0 });
  var stats = newStats();
  function warn(msg) {
    warnings.push(msg);
  }
  var WARN_EXAMPLES = 10;
  var grouped = /* @__PURE__ */ new Map();
  function warnKind(kind, ref) {
    let g = grouped.get(kind);
    if (!g) {
      g = { count: 0, examples: [] };
      grouped.set(kind, g);
    }
    g.count++;
    if (ref && g.examples.length < WARN_EXAMPLES) g.examples.push(ref);
  }
  function groupedWarnings() {
    const out = [];
    grouped.forEach((g, kind) => {
      let line = kind + ": " + g.count + " node(s)";
      if (g.examples.length) {
        line += " \u2014 e.g. " + g.examples.join("; ");
        if (g.count > g.examples.length) line += " (+" + (g.count - g.examples.length) + " more)";
      }
      out.push(line);
    });
    return out;
  }
  var SKIP_ASSETS_NOTE = (n) => `--no-assets: ${n} node(s) that would have exported an SVG/PNG were skipped; each is marked 'assetSkipped: true' in the tree and stays a leaf, exactly as the full export serializes it (structure, layout and tokens are unaffected). The per-root reference screenshot is still captured \u2014 it is one render per exported root, not per node.`;
  function manifest() {
    const note = runOpts.skipAssets && stats.assetsSkipped ? SKIP_ASSETS_NOTE(stats.assetsSkipped) : null;
    const all = warnings.concat(groupedWarnings());
    const reads = Object.keys(runOpts).filter((k) => runOpts[k]);
    return { ...stats, skipped: stats.truncated, reads, warnings: note ? all.concat(note) : all };
  }
  function memoName(fetch) {
    const cache = /* @__PURE__ */ new Map();
    const get = (id) => {
      let p = cache.get(id);
      if (!p) {
        try {
          p = Promise.resolve(fetch(id)).catch(() => null);
        } catch (e) {
          p = Promise.resolve(null);
        }
        cache.set(id, p);
      }
      return p;
    };
    const fn = (async (id) => {
      const o = await get(id);
      return o ? o.name : void 0;
    });
    fn.reset = () => cache.clear();
    fn.obj = get;
    fn.ids = () => Array.from(cache.keys());
    return fn;
  }
  var varName = memoName((id) => figma.variables.getVariableByIdAsync(id));
  var styleNameLookup = memoName((id) => figma.getStyleByIdAsync(id));
  var nodeNameLookup = memoName((id) => figma.getNodeByIdAsync(id));
  var collectionLookup = memoName((id) => figma.variables && figma.variables.getVariableCollectionByIdAsync ? figma.variables.getVariableCollectionByIdAsync(id) : Promise.resolve(null));
  var getCollection = collectionLookup.obj;
  var runChain = Promise.resolve();
  function serializeRun(fn, run) {
    const go = () => bracket(fn, run);
    const next = runChain.then(go, go);
    runChain = next.then(() => {
    }, () => {
    });
    return next;
  }
  async function bracket(fn, run) {
    beginRun(run);
    try {
      return await fn();
    } catch (e) {
      releaseAssets();
      throw e;
    } finally {
      endRun();
    }
  }
  function releaseAssets() {
    assets.length = 0;
  }
  async function loadAllPages(consequence) {
    if (!figma.loadAllPagesAsync) return;
    try {
      await figma.loadAllPagesAsync();
    } catch (e) {
      warn("loadAllPagesAsync failed (" + consequence + "): " + (0, import_errmsg.errMsg)(e));
    }
  }
  function resetRun() {
    releaseAssets();
    resetAssetNames();
    warnings = [];
    grouped = /* @__PURE__ */ new Map();
    stats = newStats();
    varName.reset();
    styleNameLookup.reset();
    nodeNameLookup.reset();
    collectionLookup.reset();
    imageSizeCache.clear();
  }

  // src/collect.ts
  var import_node_id = __toESM(require_node_id());

  // src/layout.ts
  var ALIGN = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end",
    SPACE_BETWEEN: "space-between",
    BASELINE: "baseline"
  };
  function flexIntent(src) {
    const l = { display: "flex", flexDirection: src.layoutMode === "VERTICAL" ? "column" : "row" };
    if (src.itemSpacing) l.gap = src.itemSpacing;
    const pad = [src.paddingTop, src.paddingRight, src.paddingBottom, src.paddingLeft];
    if (pad.some((p) => p)) l.padding = pad;
    if (src.primaryAxisAlignItems && src.primaryAxisAlignItems !== "MIN") l.justifyContent = ALIGN[src.primaryAxisAlignItems];
    if (src.counterAxisAlignItems && src.counterAxisAlignItems !== "MIN") l.alignItems = ALIGN[src.counterAxisAlignItems];
    if (src.layoutWrap === "WRAP") {
      l.flexWrap = "wrap";
      if (src.counterAxisSpacing) l.rowGap = src.counterAxisSpacing;
      if (src.counterAxisAlignContent && src.counterAxisAlignContent !== "AUTO") l.alignContent = ALIGN[src.counterAxisAlignContent];
    }
    return l;
  }
  function simplifyGrid(g) {
    if (!g) return void 0;
    const gg = g;
    const o = { pattern: gg.pattern ? String(gg.pattern).toLowerCase() : void 0 };
    if (typeof gg.sectionSize === "number") o.size = round(gg.sectionSize);
    if (typeof gg.gutterSize === "number") o.gutter = round(gg.gutterSize);
    if (typeof gg.count === "number" && gg.count !== Infinity) o.count = gg.count;
    if (typeof gg.offset === "number") o.offset = round(gg.offset);
    if (gg.alignment) o.alignment = String(gg.alignment).toLowerCase();
    if (gg.visible === false) o.visible = false;
    return o;
  }
  function simplifyTrack(t) {
    if (!t || typeof t !== "object") return t;
    const o = { type: t.type ? String(t.type).toLowerCase() : void 0 };
    if (typeof t.value === "number") o.value = round(t.value);
    return o;
  }
  var GRID_SELF = { MIN: "start", CENTER: "center", MAX: "end" };
  function layout(node) {
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
  async function resolveVar(alias) {
    if (!alias || alias.type !== "VARIABLE_ALIAS") return void 0;
    return varName(alias.id);
  }
  async function resolveBoundMap(bound) {
    if (!bound) return void 0;
    const out = {};
    for (const key of Object.keys(bound)) {
      const val = bound[key];
      if (Array.isArray(val)) {
        const names = (await Promise.all(val.map(resolveVar))).filter(Boolean);
        if (names.length) out[key] = names.length === 1 ? names[0] : names;
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
    return styleNameLookup(id);
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
      STYLE_FIELDS.map(([field]) => field in node ? styleName(anyProp(node, field)) : Promise.resolve(void 0))
    );
    const out = {};
    STYLE_FIELDS.forEach(([, key], i) => {
      if (names[i]) out[key] = names[i];
    });
    return nonEmpty(out);
  }
  async function resolveModeMap(raw, skipSingleMode) {
    if (!raw || !Object.keys(raw).length) return void 0;
    const out = {};
    for (const collectionId of Object.keys(raw)) {
      const c = await getCollection(collectionId);
      const modeId = raw[collectionId];
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
  async function resolveModeValue(v, resolvedType) {
    const val = v;
    if (val && val.type === "VARIABLE_ALIAS") return { aliasOf: await varName(val.id) || val.id };
    if (resolvedType === "COLOR" && val && typeof val.r === "number") return rgbaToHex(val);
    return v;
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
      for (const modeId of Object.keys(v.valuesByMode || {})) {
        const raw = v.valuesByMode[modeId];
        if (raw && raw.type === "VARIABLE_ALIAS" && raw.id) out.push(raw.id);
      }
      return out;
    };
    const remoteVars = [];
    const seen = new Set(localIds);
    let frontier = [...new Set(varName.ids().concat(...localVars.map(aliasTargets)))].filter((id) => !seen.has(id));
    while (frontier.length) {
      for (const id of frontier) seen.add(id);
      const fetched = (await Promise.all(frontier.map((id) => varName.obj(id)))).filter(Boolean);
      remoteVars.push(...fetched);
      frontier = [...new Set([].concat(...fetched.map(aliasTargets)))].filter((id) => !seen.has(id));
    }
    const missingCollIds = [...new Set(remoteVars.map((v) => v.variableCollectionId).filter((cid) => cid && !collById.has(cid)))];
    for (const c of await Promise.all(missingCollIds.map((cid) => getCollection(cid)))) {
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
      const modeIds = Object.keys(v.valuesByMode);
      const resolved = await Promise.all(modeIds.map((modeId) => resolveModeValue(v.valuesByMode[modeId], v.resolvedType)));
      for (let i = 0; i < modeIds.length; i++) {
        const modeId = modeIds[i];
        const raw = v.valuesByMode[modeId];
        if (raw && raw.type === "VARIABLE_ALIAS") {
          hasAlias = true;
          if (!resolvedIds.has(raw.id)) hygiene.push("broken alias in '" + v.name + "' \u2014 target " + raw.id + " could not be resolved");
        }
        values[modeName[modeId] || modeId] = resolved[i];
      }
      const rec = {
        name: v.name,
        type: v.resolvedType,
        collection: (collOf(v.variableCollectionId) || {}).name,
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
      for (let i = 0; i < pendingPublish.length; i++) if (st[i]) pendingPublish[i].rec.publish = st[i];
    }
    const collPublish = {};
    if (asLibrary) {
      const st = await Promise.all(allCollections.map((c) => publishOf2(c)));
      for (let i = 0; i < allCollections.length; i++) if (st[i]) collPublish[allCollections[i].id] = st[i];
    }
    return {
      // Local collections plus any LIBRARY collection a referenced remote variable belongs to — the
      // token emitters need each collection's default mode to pick the `:root` value.
      collections: allCollections.map((c) => ({
        name: c.name,
        modes: c.modes.map((m) => m.name),
        // Which mode is the base/`:root` default (vs. the override theme) — codegen otherwise guesses.
        default: modeName[c.defaultModeId] || void 0,
        theming: c.modes.length > 1,
        // Extended collection (its modes inherit from a root collection via parentModeId) — codegen
        // should treat it as an override layer, not a standalone theme. Flag it; deep parent-mode
        // resolution (mode.parentModeId -> root mode) is deferred.
        extended: c.isExtension === true ? true : void 0,
        hiddenFromPublishing: c.hiddenFromPublishing === true ? true : void 0,
        key: c.key || void 0,
        // durable cross-file collection identity
        publish: collPublish[c.id] || void 0
        // library mode only
      })),
      variables,
      hygiene
    };
  }

  // src/paint.ts
  var FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
  function imageFilters(f) {
    if (!f.filters || typeof f.filters !== "object") return void 0;
    const src = f.filters;
    const out = {};
    for (const k of FILTER_KEYS) {
      if (typeof src[k] === "number" && src[k]) out[k] = round(src[k]);
    }
    return nonEmpty(out);
  }
  function paintExtras(f, o) {
    if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
    if (typeof f.opacity === "number" && f.opacity < 1) o.opacity = round(f.opacity);
    return o;
  }
  function mediaPaint(f, type, hash, transform) {
    const o = paintExtras(f, { type, scaleMode: f.scaleMode ? f.scaleMode.toLowerCase() : void 0 });
    if (hash) o.hash = hash;
    if (f.scaleMode === "TILE" && typeof f.scalingFactor === "number") o.scale = f.scalingFactor;
    if (typeof f.rotation === "number" && f.rotation) o.rotation = f.rotation;
    if (Array.isArray(transform)) o.transform = transform;
    const flt = imageFilters(f);
    if (flt) o.filters = flt;
    return o;
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
          o = paintExtras(g, { type: "gradient", kind: g.type });
          if (Array.isArray(g.gradientStops)) {
            o.stops = await Promise.all(
              g.gradientStops.map(async (s) => {
                const stop = { pos: round(s.position), color: rgbaToHex(s.color) };
                const bv = await resolveBoundMap(s.boundVariables);
                if (bv) stop.tokens = bv;
                return stop;
              })
            );
          }
          if (Array.isArray(g.gradientTransform)) o.transform = g.gradientTransform;
        } else if (f.type === "IMAGE") {
          o = mediaPaint(f, "image", f.imageHash, f.imageTransform);
          const size = await collectSourceImage(f.imageHash);
          if (size) o.intrinsicSize = size;
        } else if (f.type === "VIDEO") {
          o = mediaPaint(f, "video", f.videoHash, f.videoTransform);
        } else if (f.type === "PATTERN") {
          o = paintExtras(f, { type: "pattern" });
          if (f.sourceNodeId) o.sourceNodeId = f.sourceNodeId;
          if (f.tileType) o.tileType = String(f.tileType).toLowerCase();
          if (typeof f.scalingFactor === "number") o.scale = f.scalingFactor;
          if (f.spacing) o.spacing = xy(f.spacing);
          if (f.horizontalAlignment) o.align = String(f.horizontalAlignment).toLowerCase();
        } else if (f.type === "SHADER") {
          o = paintExtras(f, { type: "shader" });
          if (f.id) o.shaderId = f.id;
        } else {
          o = paintExtras(f, { type: f.type.toLowerCase() });
        }
        const pbv = await resolveBoundMap(f.boundVariables);
        if (pbv) o.tokens = pbv;
        return o;
      })
    );
    return out.length ? out : void 0;
  }
  async function simplifyStrokes(node) {
    var _a;
    if (!("strokes" in node) || !Array.isArray(node.strokes)) return void 0;
    const vis = node.strokes.filter((s) => s.visible !== false);
    if (!vis.length) return void 0;
    const out = {};
    const solids = vis.filter((s) => s.type === "SOLID");
    if (solids.length) out.colors = solids.map(solidHex);
    if (vis.some((s) => s.type !== "SOLID")) {
      const paints2 = await simplifyFills(vis);
      if (paints2) out.paints = paints2;
    }
    const strokeWeight = node.strokeWeight;
    if (strokeWeight && strokeWeight !== figma.mixed) {
      out.weight = strokeWeight;
    } else if (strokeWeight === figma.mixed) {
      const sides = {};
      [
        ["strokeTopWeight", "top"],
        ["strokeRightWeight", "right"],
        ["strokeBottomWeight", "bottom"],
        ["strokeLeftWeight", "left"]
      ].forEach(([k, s]) => {
        const v = numProp(node, k);
        if (v != null) sides[s] = v;
      });
      putNonEmpty(out, "weights", sides);
    }
    const n = node;
    if (n.strokeAlign) out.align = String(n.strokeAlign).toLowerCase();
    if (n.dashPattern && n.dashPattern.length) out.dash = n.dashPattern;
    if ("strokeCap" in node && n.strokeCap && n.strokeCap !== figma.mixed && n.strokeCap !== "NONE") out.cap = String(n.strokeCap).toLowerCase();
    if ("strokeJoin" in node && n.strokeJoin && n.strokeJoin !== figma.mixed && n.strokeJoin !== "MITER") out.join = String(n.strokeJoin).toLowerCase();
    if ("strokeMiterLimit" in node && typeof n.strokeMiterLimit === "number" && n.strokeMiterLimit !== 4) out.miter = n.strokeMiterLimit;
    const vw = n.variableWidthStrokeProperties;
    if (vw && Array.isArray((_a = vw.strokeWeightProfile) == null ? void 0 : _a.mapping) && vw.strokeWeightProfile.mapping.length) {
      out.variableWidth = {
        profile: String(vw.strokeWeightProfile.type || "").toLowerCase(),
        points: vw.strokeWeightProfile.mapping.map((p) => ({ pos: round(p.position), weight: round(p.value) }))
      };
    }
    return out;
  }

  // src/effects.ts
  var GLASS_FIELDS = ["lightIntensity", "lightAngle", "refraction", "depth", "dispersion", "radius"];
  async function simplifyEffects(effects) {
    if (!Array.isArray(effects)) return void 0;
    const vis = effects.filter((e) => e.visible !== false);
    const out = await Promise.all(
      vis.map(async (e) => {
        const o = { type: e.type.toLowerCase() };
        if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
          if (e.color) o.color = rgbaToHex(e.color);
          if (e.offset) o.offset = xy(e.offset);
          if (typeof e.radius === "number") o.radius = round(e.radius);
          if (typeof e.spread === "number" && e.spread) o.spread = round(e.spread);
          if (e.blendMode && e.blendMode !== "NORMAL") o.blendMode = e.blendMode.toLowerCase();
          if (e.type === "DROP_SHADOW" && e.showShadowBehindNode) o.behindNode = true;
        } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
          if (typeof e.radius === "number") o.radius = round(e.radius);
          if (e.blurType && e.blurType !== "NORMAL") o.blurType = e.blurType.toLowerCase();
          const be = e;
          putXY(o, "startOffset", be.startOffset);
          putXY(o, "endOffset", be.endOffset);
          if (typeof be.startRadius === "number") o.startRadius = round(be.startRadius);
        } else if (e.type === "NOISE") {
          const ne = e;
          if (ne.noiseType) o.noiseType = String(ne.noiseType).toLowerCase();
          if (ne.color) o.color = rgbaToHex(ne.color);
          if (typeof ne.density === "number") o.density = round(ne.density);
          if (typeof ne.noiseSize === "number") o.noiseSize = round(ne.noiseSize);
          putXY(o, "noiseSizeVector", ne.noiseSizeVector);
          if (ne.secondaryColor) o.secondaryColor = rgbaToHex(ne.secondaryColor);
          if (typeof ne.opacity === "number") o.opacity = round(ne.opacity);
          if (ne.blendMode && ne.blendMode !== "NORMAL") o.blendMode = ne.blendMode.toLowerCase();
        } else if (e.type === "GLASS") {
          const ge = e;
          for (const k of GLASS_FIELDS) {
            if (typeof ge[k] === "number") o[k] = round(ge[k]);
          }
        } else if (e.type === "TEXTURE") {
          const te = e;
          if (typeof te.noiseSize === "number") o.noiseSize = round(te.noiseSize);
          putXY(o, "noiseSizeVector", te.noiseSizeVector);
          if (typeof te.radius === "number") o.radius = round(te.radius);
          if (typeof te.clipToShape === "boolean") o.clipToShape = te.clipToShape;
        } else if (e.type === "SHADER") {
          const se = e;
          if (se.id) o.shaderId = se.id;
        }
        const bv = await resolveBoundMap(e.boundVariables);
        if (bv) o.tokens = bv;
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
    }
    if (typeof src.fontWeight === "number") f.weightValue = src.fontWeight;
    const lh = lineH(src.lineHeight);
    if (lh) f.lineHeight = lh;
    const ls = letterS(src.letterSpacing);
    if (ls) f.letterSpacing = ls;
    if (src.textCase && src.textCase !== figma.mixed && src.textCase !== "ORIGINAL") f.case = src.textCase.toLowerCase();
    if (src.textDecoration && src.textDecoration !== figma.mixed && src.textDecoration !== "NONE") f.decoration = src.textDecoration.toLowerCase();
    if (f.decoration) {
      if (src.textDecorationStyle && src.textDecorationStyle !== figma.mixed && src.textDecorationStyle !== "SOLID") f.decorationStyle = String(src.textDecorationStyle).toLowerCase();
      const dcv = src.textDecorationColor && src.textDecorationColor.value;
      const dc = solidFromFills(dcv && dcv !== "AUTO" ? [dcv] : void 0);
      if (dc) f.decorationColor = dc;
      const th = decoLen(src.textDecorationThickness);
      if (th) f.decorationThickness = th;
      const off = decoLen(src.textDecorationOffset);
      if (off) f.decorationOffset = off;
      if (src.textDecorationSkipInk === false) f.decorationSkipInk = false;
    }
    if (src.openTypeFeatures && typeof src.openTypeFeatures === "object" && src.openTypeFeatures !== figma.mixed) {
      const on = Object.keys(src.openTypeFeatures).filter((k) => src.openTypeFeatures[k]);
      if (on.length) f.openType = on;
    }
    const color = solidFromFills(src.fills);
    if (color) f.color = color;
    return f;
  }
  var TEXT_SEG_FIELDS = [
    "fontName",
    "fontSize",
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
    "boundVariables"
  ];
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
    const t = node;
    const out = { text: node.characters };
    let segs;
    try {
      segs = node.getStyledTextSegments(TEXT_SEG_FIELDS);
    } catch (e) {
      segs = void 0;
    }
    if (segs && segs.length > 1) {
      out.runs = await Promise.all(
        segs.map(async (s) => {
          const r = { text: s.characters, font: fontObj(s) };
          inlineExtras(s, r);
          const [ts, fs, bv] = await Promise.all([styleName(s.textStyleId), styleName(s.fillStyleId), resolveBoundMap(s.boundVariables)]);
          if (ts) r.textStyle = ts;
          if (fs) r.fillStyle = fs;
          if (bv) r.tokens = bv;
          return r;
        })
      );
      out.font = fontObj(segs[0]);
    } else {
      const s0 = segs && segs[0];
      out.font = fontObj(s0 ? s0 : node);
      const bv = await resolveBoundMap(s0 ? s0.boundVariables : void 0);
      if (bv) out.textTokens = bv;
      inlineExtras(s0 || t, out);
    }
    if (t.textAlignHorizontal) out.font.align = t.textAlignHorizontal.toLowerCase();
    if (typeof t.paragraphSpacing === "number" && t.paragraphSpacing) out.font.paragraphSpacing = t.paragraphSpacing;
    if (typeof t.paragraphIndent === "number" && t.paragraphIndent) out.font.paragraphIndent = t.paragraphIndent;
    if (typeof t.listSpacing === "number" && t.listSpacing) out.font.listSpacing = t.listSpacing;
    if (t.leadingTrim && t.leadingTrim !== figma.mixed && t.leadingTrim !== "NONE") out.font.leadingTrim = t.leadingTrim.toLowerCase();
    if (t.textAlignVertical && t.textAlignVertical !== "TOP") out.font.valign = t.textAlignVertical.toLowerCase();
    {
      const tw = t.textWrapStyle;
      if (typeof tw === "string" && tw && tw !== "AUTO") out.font.textWrap = tw.toLowerCase();
    }
    if (t.hangingList === true) out.font.hangingList = true;
    if (t.hangingPunctuation === true) out.font.hangingPunctuation = true;
    if (t.textAutoResize && t.textAutoResize !== "NONE") out.autoResize = t.textAutoResize.toLowerCase();
    if (t.textTruncation === "ENDING") out.truncate = true;
    if (typeof t.maxLines === "number" && t.maxLines) out.maxLines = t.maxLines;
    if (t.hasMissingFont === true) {
      out.missingFont = true;
      warnKind("missing font \u2014 Figma is substituting a fallback; the recorded family may differ from the render", node.name + " (" + node.id + ")");
    }
    if (node.width === 0) warnKind("zero-width text node (possible collapsed thread)", node.name + " (" + node.id + ")");
    return out;
  }

  // src/prototype.ts
  function simplifyTransition(tr) {
    const t = { type: tr.type ? tr.type.toLowerCase() : void 0 };
    if (tr.direction) t.direction = tr.direction.toLowerCase();
    if (typeof tr.duration === "number") t.duration = tr.duration;
    if (typeof tr.matchLayers === "boolean") t.matchLayers = tr.matchLayers;
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
    if (v && v.type === "VARIABLE_ALIAS") return { token: await varName(v.id) || v.id };
    return v;
  }
  async function serializeAction(a) {
    if (!a) return null;
    const ao = { type: (a.type || "").toLowerCase() };
    if (a.navigation) ao.navigation = a.navigation.toLowerCase();
    if (a.url) ao.url = a.url;
    if (a.destinationId) {
      ao.destinationId = a.destinationId;
      const dn = await nodeNameLookup(a.destinationId);
      if (dn) ao.destination = dn;
    }
    if (a.preserveScrollPosition === true) ao.preserveScroll = true;
    if (a.resetScrollPosition === true) ao.resetScroll = true;
    if (a.resetVideoPosition === true) ao.resetVideo = true;
    if (a.resetInteractiveComponents === true) ao.resetInteractive = true;
    if (a.overlayRelativePosition) ao.overlayOffset = xy(a.overlayRelativePosition);
    if (a.transition) ao.transition = simplifyTransition(a.transition);
    if (a.type === "SET_VARIABLE") {
      if (a.variableId) ao.variable = await varName(a.variableId) || a.variableId;
      if (a.variableValue != null) ao.value = await simplifyVariableData(a.variableValue);
    } else if (a.type === "SET_VARIABLE_MODE") {
      if (a.variableCollectionId) {
        const c = await getCollection(a.variableCollectionId);
        ao.collection = c ? c.name : a.variableCollectionId;
        if (a.variableModeId) {
          const m = c && Array.isArray(c.modes) ? c.modes.find((x) => x.modeId === a.variableModeId) : null;
          ao.mode = m ? m.name : a.variableModeId;
        }
      }
    } else if (a.type === "UPDATE_MEDIA_RUNTIME") {
      if (a.mediaAction) ao.mediaAction = String(a.mediaAction).toLowerCase();
      if (typeof a.amountToSkip === "number") ao.amountToSkip = a.amountToSkip;
      if (typeof a.newTimestamp === "number") ao.newTimestamp = a.newTimestamp;
    } else if (a.type === "CONDITIONAL" && Array.isArray(a.conditionalBlocks)) {
      ao.conditionalBlocks = await Promise.all(
        a.conditionalBlocks.map(async (blk) => {
          const b = {};
          if (blk.condition) b.condition = await simplifyVariableData(blk.condition);
          if (Array.isArray(blk.actions)) b.actions = (await Promise.all(blk.actions.map(serializeAction))).filter(Boolean);
          return b;
        })
      );
    }
    return ao;
  }
  async function simplifyReactions(node) {
    const reactions = node.reactions;
    if (!("reactions" in node) || !Array.isArray(reactions) || !reactions.length) return void 0;
    const out = [];
    for (const r of reactions) {
      const o = {};
      if (r.trigger) {
        o.trigger = r.trigger.type ? r.trigger.type.toLowerCase() : "unknown";
        if (typeof r.trigger.timeout === "number") o.timeout = r.trigger.timeout;
        if (typeof r.trigger.delay === "number") o.delay = r.trigger.delay;
        if (Array.isArray(r.trigger.keyCodes) && r.trigger.keyCodes.length) o.keyCodes = r.trigger.keyCodes;
        if (r.trigger.device) o.device = String(r.trigger.device).toLowerCase();
        if (typeof r.trigger.mediaHitTime === "number") o.mediaHitTime = r.trigger.mediaHitTime;
      }
      const actions = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
      const acts = (await Promise.all(actions.map(serializeAction))).filter(Boolean);
      if (acts.length) o.actions = acts;
      if (o.trigger || o.actions) out.push(o);
    }
    return out.length ? out : void 0;
  }

  // src/libraries.ts
  var UNKNOWN_LIBRARY = "unknown-library";
  function readRegistry(sink) {
    try {
      const raw = figma.root.getPluginData && figma.root.getPluginData("libraryRegistry");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out = {};
      for (const k of Object.keys(parsed)) if (typeof parsed[k] === "string" && parsed[k]) out[k] = parsed[k];
      return out;
    } catch (e) {
      sink("library registry (document pluginData 'libraryRegistry') is unreadable (" + (0, import_errmsg.errMsg)(e) + ") \u2014 remote components stay unattributed");
      return {};
    }
  }
  async function allInstances(sink) {
    await loadAllPages("library component scan may be incomplete");
    const out = [];
    const prevSkip = figma.skipInvisibleInstanceChildren;
    try {
      try {
        figma.skipInvisibleInstanceChildren = true;
      } catch (e) {
      }
      for (const page2 of figma.root.children) {
        try {
          out.push(...page2.findAllWithCriteria({ types: ["INSTANCE"] }));
        } catch (e) {
          sink("library scan: page '" + page2.name + "' could not be traversed (" + (0, import_errmsg.errMsg)(e) + ") \u2014 its library components are missing");
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
      for (const k of Object.keys(defs)) {
        const d = defs[k];
        const p = { key: k, type: d.type };
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
        const p = props[name] || (props[name] = { key: k, type: v.type, observed: [] });
        if (v.value !== void 0 && p.observed.indexOf(v.value) === -1) p.observed.push(v.value);
      }
    }
    return nonEmpty(props);
  }
  async function collectLibraryComponents(sinkIn) {
    const sink = sinkIn || warn;
    const registry = readRegistry(sink);
    const instances = await allInstances(sink);
    const mains = await Promise.all(instances.map((i) => mainOf(i)));
    const byKey = /* @__PURE__ */ new Map();
    let unkeyed = 0;
    for (let i = 0; i < instances.length; i++) {
      const main = mains[i];
      if (!main) continue;
      if (!main.remote) continue;
      const key = main.key;
      if (!key) {
        unkeyed++;
        continue;
      }
      const bucket = byKey.get(key);
      if (bucket) bucket.instances.push(instances[i]);
      else byKey.set(key, { main, instances: [instances[i]] });
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
        "team-library variables unavailable (" + (0, import_errmsg.errMsg)(e) + ') \u2014 needs manifest permissions:["teamlibrary"] and a plan with shared libraries; library COMPONENTS below are unaffected'
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
          sink("library collection '" + c.name + "': variables could not be listed (" + (0, import_errmsg.errMsg)(e) + ") \u2014 count omitted");
          return void 0;
        }
      })
    );
    for (let i = 0; i < collections.length; i++) {
      const c = collections[i];
      const lib = c.libraryName || UNKNOWN_LIBRARY;
      const entry = { key: c.key, name: c.name };
      if (counts[i] !== void 0) entry.variableCount = counts[i];
      const list = byLibrary.get(lib);
      if (list) list.push(entry);
      else byLibrary.set(lib, [entry]);
    }
    return byLibrary;
  }
  async function listLibraries() {
    const warnings2 = [];
    const sink = (m) => warnings2.push(m);
    const [varsByLibrary, components] = await Promise.all([
      libraryVariableCollections(sink),
      collectLibraryComponents(sink).catch((e) => {
        sink("library component scan failed (" + (0, import_errmsg.errMsg)(e) + ") \u2014 component counts are missing, variable collections below are unaffected");
        return [];
      })
    ]);
    const compBySource = /* @__PURE__ */ new Map();
    for (const c of components) compBySource.set(c.source, (compBySource.get(c.source) || 0) + 1);
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
      sink("local variable collections could not be listed (" + (0, import_errmsg.errMsg)(e) + ")");
    }
    libraries.push({
      key: figma.fileKey || "local",
      name: figma.root && figma.root.name || "(this file)",
      kind: "local",
      variableCollections: localCollections,
      componentCount: void 0,
      // local components are enumerated properly by the design-system catalog
      note: "this file \u2014 its local components are listed in full by the design-system export, not counted here"
    });
    const seenSources = /* @__PURE__ */ new Set();
    for (const [libName, collections] of varsByLibrary) {
      seenSources.add(libName);
      const componentCount = compBySource.get(libName);
      libraries.push({
        key: collections.length ? collections[0].key : libName,
        // libraries themselves have no key — a collection key is the closest stable handle
        name: libName,
        kind: "library",
        variableCollections: collections,
        componentCount,
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
    return { exportedAt: exportedAt(), file: figma.root && figma.root.name || void 0, libraries, warnings: warnings2 };
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
      if (refs[k]) out[k] = propName(refs[k]);
    }
    return nonEmpty(out);
  }
  var OVERRIDE_CAP = 100;
  function instanceOverrides(node) {
    if (node.type !== "INSTANCE") return void 0;
    const overrides = node.overrides;
    if (!Array.isArray(overrides) || !overrides.length) return void 0;
    const list = overrides.filter((o) => o && Array.isArray(o.overriddenFields) && o.overriddenFields.length).map((o) => ({ id: o.id, fields: o.overriddenFields }));
    if (!list.length) return void 0;
    if (list.length > OVERRIDE_CAP) {
      warn("instance '" + node.name + "' has " + list.length + " overrides \u2014 truncated to " + OVERRIDE_CAP);
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
          if (k in node && typeof node[k] === "number" && node[k]) corners[s] = node[k];
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
  async function serializeVariant(main, serialize2) {
    const prevSkipAssets = runOpts.skipAssets;
    try {
      runOpts.skipAssets = true;
      return await serialize2(main, 60 - VARIANT_WALK_DEPTH);
    } finally {
      runOpts.skipAssets = prevSkipAssets;
    }
  }
  async function collectComponentCatalog(hygiene, asLibrary, serialize2) {
    const components = [];
    const pendingPublish = [];
    const seenNames = /* @__PURE__ */ new Set();
    const variantsBySet = /* @__PURE__ */ new Map();
    const entriesBySetId = /* @__PURE__ */ new Map();
    const prevSkip = figma.skipInvisibleInstanceChildren;
    try {
      try {
        figma.skipInvisibleInstanceChildren = true;
      } catch (e) {
      }
      const catalogPages = figma.root.children;
      let catalogIndex = 0;
      for (const page2 of catalogPages) {
        checkCancelled();
        enterPage("design-system", ++catalogIndex, catalogPages.length, page2.name, page2.id, { components: components.length });
        let nodes = [];
        try {
          nodes = page2.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
        } catch (e) {
          warn("component catalog: page '" + page2.name + "' could not be traversed (" + (0, import_errmsg.errMsg)(e) + ") \u2014 its components are missing");
          continue;
        }
        for (const n of nodes) {
          if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") {
            if (runOpts.variantVisuals) {
              const list = variantsBySet.get(n.parent.id);
              if (list) list.push(n);
              else variantsBySet.set(n.parent.id, [n]);
            }
            continue;
          }
          const entry = { name: n.name, id: n.id, type: n.type, page: page2.name, pageId: page2.id };
          if (n.description) entry.description = n.description;
          if (n.remote) entry.remote = true;
          if (n.key) entry.key = n.key;
          if (Array.isArray(n.documentationLinks) && n.documentationLinks.length) entry.docs = n.documentationLinks.map((d) => d.uri).filter(Boolean);
          try {
            const defs = n.componentPropertyDefinitions;
            if (defs && Object.keys(defs).length) {
              entry.props = {};
              let variantCombos = 1;
              const keys = Object.keys(defs);
              const boundPerKey = await Promise.all(keys.map((k) => resolveBoundMap(defs[k].boundVariables)));
              for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const d = defs[k];
                const p = { key: k, type: d.type };
                if (d.type === "VARIANT") {
                  p.options = d.variantOptions;
                  variantCombos *= d.variantOptions ? d.variantOptions.length : 1;
                }
                if (d.defaultValue !== void 0) p.default = d.defaultValue;
                if (d.type === "INSTANCE_SWAP" && Array.isArray(d.preferredValues) && d.preferredValues.length) {
                  p.preferredValues = d.preferredValues.map((v) => ({ type: v.type, key: v.key }));
                }
                if (d.description) p.description = d.description;
                const dbv = boundPerKey[i];
                if (dbv) p.tokens = dbv;
                entry.props[propName(k)] = p;
              }
              if (variantCombos > 30) hygiene.push("variant explosion: '" + n.name + "' has " + variantCombos + " combinations (>30 \u2014 consider boolean/instance-swap props)");
            }
          } catch (e) {
            warn("component '" + n.name + "': property definitions unreadable (" + (0, import_errmsg.errMsg)(e) + ") \u2014 props omitted");
          }
          if (/^(Component|Frame)\s*\d+$/.test(n.name)) hygiene.push("unnamed component: '" + n.name + "'");
          if (seenNames.has(n.name)) hygiene.push("duplicate component name: '" + n.name + "'");
          seenNames.add(n.name);
          try {
            const visuals = await simplifyVisuals(n);
            if (visuals) entry.visuals = visuals;
          } catch (e) {
            warn("component '" + n.name + "': visuals unreadable (" + (0, import_errmsg.errMsg)(e) + ") \u2014 visuals omitted");
          }
          if (asLibrary) pendingPublish.push({ entry, node: n });
          if (runOpts.variantVisuals && n.type === "COMPONENT_SET") entriesBySetId.set(n.id, entry);
          if (runOpts.variantVisuals && n.type === "COMPONENT" && serialize2) {
            try {
              const node = await serializeVariant(n, serialize2);
              if (node) entry.node = node;
            } catch (e) {
              warn("component '" + n.name + "': visuals unreadable (" + (0, import_errmsg.errMsg)(e) + ") \u2014 node tree omitted");
            }
          }
          components.push(entry);
        }
      }
    } finally {
      try {
        figma.skipInvisibleInstanceChildren = prevSkip;
      } catch (e) {
      }
    }
    if (runOpts.variantVisuals && serialize2 && variantsBySet.size) {
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
            warn("component '" + v.name + "': variant visuals unreadable (" + (0, import_errmsg.errMsg)(e) + ") \u2014 omitted");
          }
        }
        if (out.length) entry.variants = out;
      }
    }
    if (pendingPublish.length) {
      const statuses = await Promise.all(pendingPublish.map((p) => publishOf(p.node)));
      for (let i = 0; i < pendingPublish.length; i++) {
        if (statuses[i]) pendingPublish[i].entry.publish = statuses[i];
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
    const [paint, text, effect, grid] = await Promise.all([
      safeList(() => figma.getLocalPaintStylesAsync()),
      safeList(() => figma.getLocalTextStylesAsync()),
      safeList(() => figma.getLocalEffectStylesAsync()),
      safeList(() => figma.getLocalGridStylesAsync ? figma.getLocalGridStylesAsync() : Promise.resolve([]))
    ]);
    const hygiene = [];
    await loadAllPages("component catalog may be incomplete");
    const components = await collectComponentCatalog(hygiene, asLibrary, serialize2);
    if (asLibrary) {
      hygiene.push(
        "library mode: this catalog is the COMPLETE set of components defined in this library file. Publish status is per-object (publish: current | changed | unpublished); Figma exposes no way to list what the last PUBLISHED snapshot contained, so a component deleted here but still live in the library is not visible."
      );
    } else try {
      const seenKeys = new Set(components.map((c) => c.key).filter(Boolean));
      const remote = await collectLibraryComponents((m) => warn(m));
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
      warn("library component catalog failed (" + (0, import_errmsg.errMsg)(e) + ") \u2014 components consumed from published libraries are missing from the catalog");
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
      if (Array.isArray(s.documentationLinks) && s.documentationLinks.length) {
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
      Promise.all(paint.map(async (s) => ({ name: s.name, paints: await simplifyFills(s.paints), tokens: await resolveBoundMap(s.boundVariables), description: s.description || void 0, ...await styleMeta(s) }))),
      Promise.all(
        text.map(async (s) => ({
          name: s.name,
          size: s.fontSize,
          font: s.fontName && s.fontName.family,
          weight: s.fontName && s.fontName.style,
          lineHeight: lineH(s.lineHeight),
          letterSpacing: letterS(s.letterSpacing),
          case: s.textCase && s.textCase !== "ORIGINAL" ? s.textCase.toLowerCase() : void 0,
          decoration: s.textDecoration && s.textDecoration !== "NONE" ? s.textDecoration.toLowerCase() : void 0,
          paragraphSpacing: s.paragraphSpacing || void 0,
          paragraphIndent: s.paragraphIndent || void 0,
          leadingTrim: s.leadingTrim && s.leadingTrim !== "NONE" ? String(s.leadingTrim).toLowerCase() : void 0,
          listSpacing: s.listSpacing || void 0,
          // TextStyle.textWrapStyle (Plugin API 2026-08-14) — AUTO | BALANCE | PRETTY; AUTO is the
          // default and is skipped. Maps 1:1 onto CSS `text-wrap`. Same read as text.ts's per-node
          // one, minus the mixed guard: a TextStyle is uniform by definition.
          textWrap: s.textWrapStyle && s.textWrapStyle !== "AUTO" ? String(s.textWrapStyle).toLowerCase() : void 0,
          tokens: await resolveBoundMap(s.boundVariables),
          description: s.description || void 0,
          ...await styleMeta(s)
        }))
      ),
      Promise.all(effect.map(async (s) => ({ name: s.name, effects: await simplifyEffects(s.effects), tokens: await resolveBoundMap(s.boundVariables), description: s.description || void 0, ...await styleMeta(s) })))
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
          grids: Array.isArray(s.layoutGrids) ? s.layoutGrids.map(simplifyGrid).filter(Boolean) : void 0,
          tokens: await resolveBoundMap(s.boundVariables),
          description: s.description || void 0,
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
        libraryName: opts && opts.asLibrary || figma.root && figma.root.name || void 0,
        fileKey,
        collectionKeys: vars.collections.map((c) => c.key).filter(Boolean)
      };
    }
    return {
      exportedAt: exportedAt(),
      file: figma.root && figma.root.name || void 0,
      source,
      colorProfile,
      // legacy | srgb | display-p3 — whether emitted colors should be sRGB or wide-gamut
      collections: vars.collections,
      variables: vars.variables,
      styles,
      components,
      hygiene: vars.hygiene.concat(hygiene)
      // variable hygiene first, then component hygiene
    };
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
        return kv.value ? xy(kv.value) : void 0;
      case "CIRCLE":
        return kv.value ? { ...xy(kv.value), radius: round(kv.value.radius) } : void 0;
      case "LINE":
        return kv.value ? { ...xy(kv.value), x2: round(kv.value.x2), y2: round(kv.value.y2) } : void 0;
      default:
        return kv.value;
    }
  }
  function motionEasing(ez) {
    if (!ez || !ez.type) return void 0;
    return { type: String(ez.type).toLowerCase(), ...easingCurve(ez) };
  }
  function keyframes(list) {
    if (!Array.isArray(list) || !list.length) return void 0;
    return list.map((k) => {
      const o = { t: round(k.timelinePosition), value: keyframeValue(k.value) };
      const ez = motionEasing(k.easing);
      if (ez) o.easing = ez;
      return o;
    });
  }
  function trackMap(map) {
    if (!map || typeof map !== "object") return void 0;
    const out = {};
    for (const field of Object.keys(map)) {
      const binding = map[field];
      if (!binding || typeof binding !== "object") continue;
      const o = {};
      if (binding.baseValue !== void 0) o.base = keyframeValue(binding.baseValue);
      if (typeof binding.keyframeOperation === "string" && binding.keyframeOperation !== "SET") o.op = binding.keyframeOperation.toLowerCase();
      const kf = keyframes(binding.keyframes);
      if (kf) o.keyframes = kf;
      putNonEmpty(out, field, o);
    }
    return nonEmpty(out);
  }
  function collectMotion(node) {
    const n = node;
    const out = {};
    if (Array.isArray(n.timelines) && n.timelines.length) out.timelines = n.timelines.map((t) => ({ id: t.id, duration: round(t.duration) }));
    const tracks = trackMap(n.manualKeyframeTracks);
    if (tracks) out.manualTracks = tracks;
    const anims = trackMap(n.animations);
    if (anims) out.animations = anims;
    if (Array.isArray(n.animationStyles) && n.animationStyles.length) {
      out.styles = n.animationStyles.map((s) => {
        const o = { name: s.name, styleId: s.styleId };
        if (typeof s.duration === "number") o.duration = round(s.duration);
        if (typeof s.timelineOffset === "number" && s.timelineOffset) o.timelineOffset = round(s.timelineOffset);
        return o;
      });
    }
    return nonEmpty(out);
  }

  // src/serialize.ts
  var MAX_DEPTH = 60;
  var LOWER_ENUMS = [
    ["layoutAlign", "alignSelf", "INHERIT"],
    // FIXED is the default on nearly every node — two keys of pure noise per node. Only FILL/HUG
    // (the values that actually change the generated CSS) are worth emitting.
    ["layoutSizingHorizontal", "widthMode", "FIXED"],
    ["layoutSizingVertical", "heightMode", "FIXED"],
    ["overflowDirection", "scroll", "NONE"]
  ];
  var GRID_SELF_ENUMS = [
    ["gridChildHorizontalAlign", "gridJustifySelf"],
    ["gridChildVerticalAlign", "gridAlignSelf"]
  ];
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
    const n = node;
    if (typeof n.getPluginDataKeys !== "function") return void 0;
    let keys = [];
    try {
      keys = n.getPluginDataKeys();
    } catch (e) {
      return void 0;
    }
    if (!keys || !keys.length) return void 0;
    const out = {};
    for (const k of keys) {
      try {
        const v = n.getPluginData(k);
        if (v) out[k] = v;
      } catch (e) {
      }
    }
    return nonEmpty(out);
  }
  var SHARED_NAMESPACES = ["tokens"];
  function sharedData(node) {
    const n = node;
    if (typeof n.getSharedPluginDataKeys !== "function" || typeof n.getSharedPluginData !== "function") return void 0;
    const out = {};
    for (const ns of SHARED_NAMESPACES) {
      let keys = [];
      try {
        keys = n.getSharedPluginDataKeys(ns) || [];
      } catch (e) {
        continue;
      }
      const bucket = {};
      for (const k of keys) {
        try {
          const v = n.getSharedPluginData(ns, k);
          if (v) bucket[k] = v;
        } catch (e) {
        }
      }
      putNonEmpty(out, ns, bucket);
    }
    return nonEmpty(out);
  }
  async function nodeCss(node) {
    const n = node;
    if (typeof n.getCSSAsync !== "function") return void 0;
    try {
      const css = await n.getCSSAsync();
      return css && Object.keys(css).length ? css : void 0;
    } catch (e) {
      return void 0;
    }
  }
  async function serialize(node, depth, parentControlsLayout) {
    if (depth > MAX_DEPTH) {
      stats.truncated++;
      if (stats.truncated === 1) warn("depth limit " + MAX_DEPTH + " reached \u2014 deep subtrees truncated (first: " + node.name + ")");
      return null;
    }
    stats.nodes++;
    const n = node;
    const out = { type: node.type, name: node.name, id: node.id };
    if (n.visible === false) out.hidden = true;
    if (node.type === "INSTANCE" && node.componentProperties) {
      const props = {};
      const propTokens = {};
      const keys = Object.keys(node.componentProperties);
      const bound = await Promise.all(keys.map((k) => resolveBoundMap(node.componentProperties[k].boundVariables)));
      keys.forEach((k, i) => {
        props[propName(k)] = node.componentProperties[k].value;
        const bv = bound[i];
        if (bv && bv.value) propTokens[propName(k)] = bv.value;
      });
      putNonEmpty(out, "props", props);
      putNonEmpty(out, "propTokens", propTokens);
    }
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") out.component = node.name;
    const lay = layout(node);
    if (lay) out.layout = lay;
    const absoluteInParent = "layoutPositioning" in node && n.layoutPositioning === "ABSOLUTE";
    if (absoluteInParent) out.absolute = true;
    if ("layoutGrow" in node && n.layoutGrow) out.grow = n.layoutGrow;
    for (const [field, key, skip] of LOWER_ENUMS) {
      const v = n[field];
      if (typeof v === "string" && v && v !== skip) out[key] = v.toLowerCase();
    }
    if ("gridColumnSpan" in node && typeof n.gridColumnSpan === "number" && n.gridColumnSpan !== 1) out.gridColumnSpan = n.gridColumnSpan;
    if ("gridRowSpan" in node && typeof n.gridRowSpan === "number" && n.gridRowSpan !== 1) out.gridRowSpan = n.gridRowSpan;
    if ("gridColumnAnchorIndex" in node && typeof n.gridColumnAnchorIndex === "number") out.gridColumnStart = n.gridColumnAnchorIndex;
    if ("gridRowAnchorIndex" in node && typeof n.gridRowAnchorIndex === "number") out.gridRowStart = n.gridRowAnchorIndex;
    for (const [field, key] of GRID_SELF_ENUMS) {
      const v = n[field];
      if (v && v !== "AUTO") out[key] = GRID_SELF[v];
    }
    if ((!parentControlsLayout || absoluteInParent) && "x" in node && typeof n.x === "number") {
      out.x = round(n.x);
      out.y = round(n.y);
    }
    if ("absoluteBoundingBox" in node && n.absoluteBoundingBox) {
      const b = n.absoluteBoundingBox;
      out.box = { w: round(b.width), h: round(b.height) };
      if (!parentControlsLayout || absoluteInParent) {
        out.box.x = round(b.x);
        out.box.y = round(b.y);
      }
      const rb = n.absoluteRenderBounds;
      if (rb && (rb.x !== b.x || rb.y !== b.y || rb.width !== b.width || rb.height !== b.height)) {
        out.renderBox = { ...xy(rb), w: round(rb.width), h: round(rb.height) };
      }
    }
    if ("layoutGrids" in node && Array.isArray(n.layoutGrids) && n.layoutGrids.length) {
      out.layoutGrids = n.layoutGrids.map(simplifyGrid).filter(Boolean);
    }
    if ("annotations" in node && Array.isArray(n.annotations) && n.annotations.length) {
      out.annotations = n.annotations.map((a) => {
        const o = {};
        if (a.label) o.label = a.label;
        if (a.labelMarkdown) o.markdown = a.labelMarkdown;
        if (a.categoryId) o.categoryId = a.categoryId;
        if (Array.isArray(a.properties) && a.properties.length) o.props = a.properties.map((p) => p.type);
        return o;
      });
    }
    if ("devStatus" in node && n.devStatus && n.devStatus.type) {
      out.devStatus = n.devStatus.type.toLowerCase();
      if (n.devStatus.description) out.devStatusNote = n.devStatus.description;
    }
    let sizeLimits;
    for (const k of SIZE_LIMIT_KEYS) {
      if (k in node && typeof n[k] === "number") (sizeLimits || (sizeLimits = {}))[k] = round(n[k]);
    }
    if (sizeLimits) out.sizeLimits = sizeLimits;
    if ("constraints" in node && n.constraints && (n.constraints.horizontal !== "MIN" || n.constraints.vertical !== "MIN")) {
      out.pin = { h: n.constraints.horizontal.toLowerCase(), v: n.constraints.vertical.toLowerCase() };
    }
    if ("numberOfFixedChildren" in node && typeof n.numberOfFixedChildren === "number" && n.numberOfFixedChildren > 0) {
      out.fixedChildren = n.numberOfFixedChildren;
    }
    if ("clipsContent" in node && n.clipsContent) out.clip = true;
    const [fills, strokes, effects] = await Promise.all([
      simplifyFills("fills" in node ? n.fills : void 0),
      simplifyStrokes(node),
      simplifyEffects("effects" in node ? n.effects : void 0)
    ]);
    if (fills) out.fills = fills;
    if (strokes) out.strokes = strokes;
    if ("strokesIncludedInLayout" in node && n.strokesIncludedInLayout) out.strokesInLayout = true;
    if (effects) out.effects = effects;
    if ("cornerRadius" in node) {
      if (n.cornerRadius !== figma.mixed && n.cornerRadius) out.radius = radiusOut(out, n.cornerRadius);
      else if (n.cornerRadius === figma.mixed) {
        const corners = {};
        for (const [k, s] of CORNER_KEYS) {
          if (k in node && typeof n[k] === "number" && n[k]) corners[s] = radiusOut(out, n[k]);
        }
        putNonEmpty(out, "radius", corners);
      }
    }
    if ("opacity" in node && n.opacity < 1) out.opacity = round(n.opacity);
    if ("rotation" in node && n.rotation) out.rotation = round(n.rotation);
    if ("relativeTransform" in node && Array.isArray(n.relativeTransform) && n.relativeTransform.length === 2) {
      const m = n.relativeTransform;
      const a = m[0][0], c = m[0][1], b = m[1][0], d = m[1][1];
      if (a * d - c * b < 0) out.flipped = true;
      const sx = Math.sqrt(a * a + b * b);
      if (sx > 1e-6) {
        const skewDeg = Math.atan2(a * c + b * d, sx * sx) * 180 / Math.PI;
        if (Math.abs(skewDeg) > 0.01) out.skew = round(skewDeg);
      }
    }
    if ("blendMode" in node && n.blendMode && n.blendMode !== "NORMAL" && n.blendMode !== "PASS_THROUGH") out.blendMode = n.blendMode.toLowerCase();
    if ("isMask" in node && n.isMask) out.mask = true;
    if (out.mask && "maskType" in node && n.maskType && n.maskType !== "ALPHA") out.maskType = String(n.maskType).toLowerCase();
    if ("cornerSmoothing" in node && typeof n.cornerSmoothing === "number" && n.cornerSmoothing) out.cornerSmoothing = round(n.cornerSmoothing);
    if ("targetAspectRatio" in node && n.targetAspectRatio && n.targetAspectRatio.y) out.aspectRatio = round(n.targetAspectRatio.x / n.targetAspectRatio.y);
    if (node.type === "ELLIPSE" && n.arcData) {
      const a = n.arcData;
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
      if (typeof n.pointCount === "number") shape.points = n.pointCount;
      if (typeof n.innerRadius === "number") shape.innerRadius = round(n.innerRadius);
      putNonEmpty(out, "shape", shape);
    }
    if (node.type === "POLYGON" && typeof n.pointCount === "number") out.shape = { points: n.pointCount };
    if (node.type === "BOOLEAN_OPERATION" && n.booleanOperation) out.booleanOp = String(n.booleanOperation).toLowerCase();
    if ("exportSettings" in node && Array.isArray(n.exportSettings) && n.exportSettings.length) {
      out.exportSettings = n.exportSettings.map((es) => {
        const o = { format: String(es.format || "").toLowerCase() };
        if (es.suffix) o.suffix = es.suffix;
        const con = es.constraint;
        if (con && typeof con.value === "number" && !(con.type === "SCALE" && con.value === 1)) {
          o.constraint = { type: String(con.type || "").toLowerCase(), value: round(con.value) };
        }
        return o;
      });
    }
    if ("detachedInfo" in node && n.detachedInfo) {
      out.detachedFrom = n.detachedInfo.type === "library" ? { key: n.detachedInfo.componentKey } : { componentId: n.detachedInfo.componentId };
    }
    if (node.type === "INSTANCE" && "exposedInstances" in node) {
      try {
        if (Array.isArray(n.exposedInstances) && n.exposedInstances.length) out.exposedInstances = n.exposedInstances.map((i) => i.id);
      } catch (e) {
      }
    }
    if ("overlayPositionType" in node) {
      const hasScrim = n.overlayBackground && n.overlayBackground.type === "SOLID_COLOR" && n.overlayBackground.color;
      const closeOutside = n.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE";
      const posSet = n.overlayPositionType && n.overlayPositionType !== "CENTER";
      if (hasScrim || closeOutside || posSet) {
        const ov = {};
        if (n.overlayPositionType) ov.position = n.overlayPositionType.toLowerCase();
        if (closeOutside) ov.closeOnClickOutside = true;
        if (hasScrim) ov.background = rgbaToHex(n.overlayBackground.color);
        out.overlay = ov;
      }
    }
    if (node.type === "TEXT" || node.type === "TEXT_PATH") Object.assign(out, await serializeText(node));
    const propRefs = componentPropRefs(node);
    if (propRefs) out.propRefs = propRefs;
    const overrides = instanceOverrides(node);
    if (overrides) out.overrides = overrides;
    if (runOpts.pluginData) {
      const pd = pluginData(node);
      if (pd) out.pluginData = pd;
    }
    if (runOpts.motion) {
      const m = collectMotion(node);
      if (m) out.motion = m;
    }
    if (runOpts.sharedData) {
      const sd = sharedData(node);
      if (sd) out.sharedData = sd;
    }
    const [mainRef, tokens, styles, asset, reactions, varModes, css] = await Promise.all([
      instanceComponentRef(node),
      boundTokens(node),
      nodeStyles(node),
      collectAsset(node),
      simplifyReactions(node),
      variableModes(node),
      runOpts.css ? nodeCss(node) : Promise.resolve(void 0)
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
      out.assetSkipped = true;
      return out;
    }
    if (asset && "geometry" in asset) {
      out.geometry = asset.geometry;
      return out;
    }
    if (asset) {
      out.asset = asset.path;
      return out;
    }
    if (node.type === "TABLE" && typeof n.numRows === "number" && typeof n.numColumns === "number") {
      const grid = await Promise.all(
        Array.from({ length: n.numRows }, (_, r) => Promise.all(
          Array.from({ length: n.numColumns }, async (__, cc) => {
            try {
              const cell = n.cellAt(r, cc);
              if (!cell) return void 0;
              const co = { row: r, col: cc };
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
    const children = "children" in node ? n.children : void 0;
    if (children && children.length) {
      const controlsChildren = "layoutMode" in node && n.layoutMode && n.layoutMode !== "NONE";
      const kids = [];
      for (const c of children) {
        const s = await serialize(c, depth + 1, controlsChildren);
        if (s) kids.push(s);
      }
      if (kids.length) out.children = kids;
    }
    return out;
  }

  // src/collect.ts
  async function serializeWithRefs(node) {
    const tree = await serialize(node, 0);
    if (!tree) return { tree: null };
    const [ref, dev, modes] = await Promise.all([collectReference(node), devResources(node), resolvedModes(node)]);
    if (modes) tree.resolvedModes = modes;
    return { tree, ref: ref || void 0, dev: dev || void 0 };
  }
  async function rootTree(node) {
    const { tree, ref, dev } = await serializeWithRefs(node);
    if (!tree) return null;
    if (ref) tree.reference = ref;
    if (dev) tree.devResources = dev;
    return tree;
  }
  async function screenResult(title, fileBase, nodes, origin) {
    const screen = { exportedAt: exportedAt(), screen: title, nodes, manifest: manifest() };
    const page2 = origin && origin.page;
    if (page2) {
      screen.page = page2.name;
      screen.pageId = page2.id;
    }
    if (origin && origin.nodeId) screen.nodeId = origin.nodeId;
    const measurements = collectMeasurements();
    if (measurements) screen.measurements = measurements;
    const out = { screenName: (0, import_pages_layout.safe)(fileBase), screen, variables: await dumpVariables(), assets: assets.slice() };
    if (page2) {
      out.page = page2.name;
      out.pageId = page2.id;
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
    if (nd.visible === false) o.hidden = true;
    return o;
  }
  async function loadPageSafely(page2, sink, what) {
    if (typeof page2.loadAsync !== "function") return false;
    try {
      await page2.loadAsync();
    } catch (e) {
      sink("page '" + page2.name + "' failed to load" + (what ? " " + what : "") + ": " + (0, import_errmsg.errMsg)(e));
      return false;
    }
    return true;
  }
  function pageChildren(page2, sink, consequence) {
    try {
      return page2.children;
    } catch (e) {
      sink("page '" + page2.name + "' could not be read (not loaded) \u2014 " + consequence + ": " + (0, import_errmsg.errMsg)(e));
      return null;
    }
  }
  async function findNodeById(nodeId, sink) {
    let node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      for (const page2 of figma.root.children) {
        if (!await loadPageSafely(page2, sink, "during node lookup")) continue;
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
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new Error(`page name ${JSON.stringify(sel)} is ambiguous (${matches.length} pages ${how}) \u2014 use its id. Available pages:
  ${avail()}`);
      }
      return null;
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
  function applyOpts(opts) {
    for (const k of Object.keys(runOpts)) runOpts[k] = !!(opts && opts[k]);
  }
  var CSS_AUTO_NODE_CAP = 60;
  function subtreeIsSmall(node) {
    let count = 0;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (++count > CSS_AUTO_NODE_CAP) return false;
      if (n && "children" in n && Array.isArray(n.children)) {
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
    return !f || f.length === 1 && f[0].type === "solid" && DEFAULT_PAGE_BG.indexOf(f[0].color) !== -1;
  }
  async function pageBackground(page2) {
    const p = page2;
    const out = {};
    const bg = await simplifyFills(p.backgrounds);
    if (!isDefaultBg(bg)) out.background = bg;
    const proto = await simplifyFills(p.prototypeBackgrounds);
    if (!isDefaultBg(proto)) out.prototypeBackground = proto;
    return nonEmpty(out);
  }
  function countNodes(tree) {
    let n = 1;
    const kids = tree.children;
    if (Array.isArray(kids)) for (const k of kids) n += countNodes(k);
    return n;
  }
  function collectMeasurements(pages) {
    if (!runOpts.measurements) return void 0;
    const targets = pages && pages.length ? pages : [figma.currentPage];
    const out = [];
    for (const page2 of targets) {
      const p = page2;
      if (typeof p.getMeasurements !== "function") continue;
      try {
        const ms = p.getMeasurements();
        if (!Array.isArray(ms) || !ms.length) continue;
        const side = (e) => e ? { nodeId: e.node && e.node.id, side: e.side } : void 0;
        for (const m of ms) {
          const o = { page: page2.name, pageId: page2.id, start: side(m.start), end: side(m.end) };
          if (m.freeText) o.text = m.freeText;
          if (m.offset != null) o.offset = m.offset;
          out.push(o);
        }
      } catch (e) {
        warn("measurements unavailable for page '" + page2.name + "': " + (0, import_errmsg.errMsg)(e));
      }
    }
    return out.length ? out : void 0;
  }
  async function collectSelection(opts) {
    resetRun();
    const sel = figma.currentPage.selection;
    if (!sel.length) throw new Error("Select at least one frame first.");
    applyOpts(sel.length === 1 ? autoCss(opts, sel[0]) : opts);
    const nodes = [];
    for (const nd of sel) {
      const tree = await rootTree(nd);
      if (tree) nodes.push(tree);
    }
    return screenResult(sel.length === 1 ? sel[0].name : "selection", sel[0].name, nodes, { page: figma.currentPage, nodeId: sel[0].id });
  }
  function pageOf(node) {
    let n = node;
    while (n && n.type !== "PAGE") n = n.parent;
    return n && n.type === "PAGE" ? n : null;
  }
  async function collectNode(rawId, opts) {
    resetRun();
    const nodeId = (0, import_node_id.toNodeId)(rawId);
    if (!nodeId) throw new Error("No node id provided.");
    const node = await findNodeById(nodeId, warn);
    applyOpts(autoCss(opts, node));
    try {
      const page2 = pageOf(node);
      if (page2 && page2 !== figma.currentPage) await figma.setCurrentPageAsync(page2);
      if ("visible" in node && node.parent) figma.currentPage.selection = [node];
      if (figma.viewport && "visible" in node) figma.viewport.scrollAndZoomIntoView([node]);
    } catch (e) {
    }
    const tree = await rootTree(node);
    if (!tree) throw new Error("Node " + nodeId + " is hidden or not exportable.");
    return screenResult(node.name, node.name, [tree], { page: pageOf(node), nodeId });
  }
  async function collectScreenshot(rawId, opts) {
    resetRun();
    const nodeId = (0, import_node_id.toNodeId)(rawId);
    if (!nodeId) throw new Error("No node id provided.");
    const node = await findNodeById(nodeId, warn);
    const reference = await collectReference(node, opts);
    if (!reference) {
      throw new Error("Node " + nodeId + " could not be rendered (hidden, zero-size, or the export failed \u2014 see warnings).");
    }
    return { id: node.id, name: node.name, type: node.type, reference, manifest: manifest(), assets: assets.slice() };
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
    for (const page2 of roots) {
      const entry = { name: page2.name, id: page2.id };
      if (page2.id === currentId) entry.current = true;
      if (depth >= 2) {
        const children = pageChildren(page2, sink, "its frames are NOT listed");
        if (!children) {
          entry.unreadable = true;
          pages.push(entry);
          continue;
        }
        const frames = children.filter((nd) => TOP_LEVEL_TYPES.has(nd.type)).map(summarize);
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
      manifest: { pages: pages.length, frames: depth >= 2 ? frameCount : void 0, warnings: localWarnings }
    };
  }
  async function listChildren(rawId) {
    const nodeId = (0, import_node_id.toNodeId)(rawId);
    if (!nodeId) throw new Error("No node id provided.");
    const localWarnings = [];
    const node = await findNodeById(nodeId, (m) => localWarnings.push(m));
    if (!("children" in node)) throw new Error("Node " + nodeId + " (" + node.type + ") is a leaf \u2014 it has no children to list.");
    let kids;
    try {
      kids = node.children;
    } catch (e) {
      throw new Error("Node " + nodeId + "'s children could not be read: " + (0, import_errmsg.errMsg)(e));
    }
    const children = [];
    for (const nd of kids) {
      const c = summarize(nd);
      if ("children" in nd) c.hasChildren = nd.children.length > 0;
      children.push(c);
    }
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
    resetRun();
    applyOpts(opts);
    const designSystem = await buildDesignSystem(void 0, serialize);
    designSystem.hygiene = [
      "design-system pull: library (remote) variables are limited to what a prior/no page walk referenced \u2014 pull a page for the full set.",
      ...Array.isArray(designSystem.hygiene) ? designSystem.hygiene : []
    ];
    return { designSystem };
  }
  async function collectLibraryFile(opts) {
    resetRun();
    applyOpts(opts);
    const asLibrary = opts && opts.asLibrary || figma.root && figma.root.name || "library";
    const designSystem = await buildDesignSystem({ asLibrary }, serialize);
    designSystem.hygiene = [
      "library pull: this is the COMPLETE local catalog of '" + asLibrary + "' \u2014 variables, styles and components, with full per-mode values. It is a snapshot of the library file's CURRENT state, which is not necessarily what consumers see: `publish` reports each object's own status (current | changed | unpublished).",
      ...Array.isArray(designSystem.hygiene) ? designSystem.hygiene : []
    ];
    return { designSystem };
  }
  async function collectFull(opts) {
    resetRun();
    applyOpts(opts);
    const allPages = !!(opts && opts.allPages);
    if (allPages) await loadAllPages("all-pages export may miss pages");
    const rawWanted = opts && opts.page !== void 0 ? (Array.isArray(opts.page) ? opts.page : [opts.page]).map((s) => String(s).trim()) : [];
    if (rawWanted.length && rawWanted.every((s) => !s)) {
      warn("page selector was empty after trimming \u2014 ignored, exported " + (allPages ? "every page instead" : "the current page instead"));
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
      await Promise.all(picked.map((p) => loadPageSafely(p, warn, "")));
      pages = picked;
    } else {
      pages = [figma.currentPage];
    }
    const layers = [];
    const index = [];
    const flows = [];
    const pageSettings = [];
    let pageIndex = 0;
    for (const page2 of pages) {
      checkCancelled();
      enterPage("pages", ++pageIndex, pages.length, page2.name, page2.id, { nodes: stats.nodes, assets: assets.length });
      const children = pageChildren(page2, warn, "its frames are missing from this export");
      if (!children) continue;
      const bg = await pageBackground(page2);
      if (bg) pageSettings.push({ page: page2.name, pageId: page2.id, ...bg });
      if (Array.isArray(page2.flowStartingPoints)) {
        for (const fp of page2.flowStartingPoints) flows.push({ page: page2.name, pageId: page2.id, nodeId: fp.nodeId, name: fp.name });
      }
      const frames = [];
      for (const nd of children) {
        if (TOP_LEVEL_TYPES.has(nd.type)) frames.push(nd);
        else if (nd.visible !== false) warn("top-level " + nd.type + " '" + nd.name + "' on page '" + page2.name + "' not exported (unhandled top-level type)");
      }
      for (const f of frames) {
        checkCancelled();
        const { tree, ref, dev } = await serializeWithRefs(f);
        if (tree) {
          layers.push({ name: f.name, id: f.id, page: page2.name, pageId: page2.id, tree, reference: ref, devResources: dev });
          index.push({
            name: f.name,
            id: f.id,
            type: f.type,
            page: page2.name,
            pageId: page2.id,
            nodes: countNodes(tree),
            bytes: JSON.stringify(tree).length
          });
        }
        progress("pages", { nodes: stats.nodes, assets: assets.length });
      }
    }
    checkCancelled();
    progress("design-system", { nodes: stats.nodes, assets: assets.length }, true);
    const designSystem = await buildDesignSystem(void 0, serialize);
    const measurements = collectMeasurements(pages);
    const layersDoc = {
      exportedAt: exportedAt(),
      // Three cases, not two. Folding an explicit --page into "current-page" left the consumer unable
      // to tell whether it got the page it asked for, next to a `page` field naming a page that was
      // never exported (the named page is loaded, NOT made current — so figma.currentPage is still
      // whatever the user happens to be looking at).
      scope: allPages ? "all-pages" : wanted.length ? "page" : "current-page",
      page: allPages || pages.length !== 1 ? void 0 : pages[0].name,
      pages: allPages || pages.length > 1 ? pages.map((p) => p.name) : void 0,
      flows: flows.length ? flows : void 0,
      pageSettings: pageSettings.length ? pageSettings : void 0,
      measurements: measurements || void 0,
      index,
      layers,
      manifest: manifest()
    };
    return { designSystem, layersDoc, assets: assets.slice() };
  }

  // src/writes.ts
  function parseHex(hex) {
    let h = (hex || "#000000").replace(/^#/, "").trim();
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const chan = (s) => {
      const v = parseInt(s, 16);
      return Number.isFinite(v) ? v / 255 : 0;
    };
    return {
      color: { r: chan(h.slice(0, 2)), g: chan(h.slice(2, 4)), b: chan(h.slice(4, 6)) },
      opacity: h.length >= 8 ? chan(h.slice(6, 8)) : void 0
    };
  }
  function solidPaint(hex) {
    const { color, opacity } = parseHex(hex);
    const p = { type: "SOLID", color };
    if (opacity !== void 0) p.opacity = opacity;
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
  async function applyWrite(op) {
    switch (op.op) {
      case "createFrame": {
        const parent = await resolveParent(op.parentId);
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
        if (op.fill) f.fills = [solidPaint(op.fill)];
        parent.appendChild(f);
        return { id: f.id };
      }
      case "createText": {
        const parent = await resolveParent(op.parentId);
        const t = figma.createText();
        await figma.loadFontAsync(t.fontName);
        t.characters = op.text || "";
        if (op.fontSize) t.fontSize = op.fontSize;
        if (op.fill) t.fills = [solidPaint(op.fill)];
        parent.appendChild(t);
        return { id: t.id };
      }
      // setFill/setText THROW rather than no-op. getNodeByIdAsync resolves to null for an invalid or
      // removed id (and for invisible instance children when skipInvisibleInstanceChildren is on), and
      // not every node type carries fills/characters. Returning {id} in those cases reported a write
      // that never happened — over MCP the agent reads that as success and builds on a false premise.
      case "setFill": {
        const nd = await figma.getNodeByIdAsync(op.nodeId);
        if (!nd) throw new Error("setFill: no node with id '" + op.nodeId + "' (invalid or removed)");
        if (!("fills" in nd)) throw new Error("setFill: node '" + nd.name + "' (" + nd.type + ") has no fills");
        nd.fills = [solidPaint(op.color)];
        return { id: op.nodeId };
      }
      case "setText": {
        const nd = await figma.getNodeByIdAsync(op.nodeId);
        if (!nd) throw new Error("setText: no node with id '" + op.nodeId + "' (invalid or removed)");
        if (nd.type !== "TEXT") throw new Error("setText: node '" + nd.name + "' is a " + nd.type + ", not TEXT");
        await loadNodeFonts(nd);
        nd.characters = op.text || "";
        return { id: op.nodeId };
      }
      default:
        throw new Error("unknown write op: " + op.op);
    }
  }
  async function applyWrites(ops) {
    const list = Array.isArray(ops) ? ops : [];
    const applied = [];
    if (list.length && figma.editorType === "dev") {
      return {
        ok: false,
        applied,
        failedAt: 0,
        failedOp: list[0] && list[0].op,
        error: "the file is open in Dev Mode, which is read-only for plugins \u2014 switch to Design mode (Shift+D) and re-run the plugin to write. Reads and exports work in Dev Mode."
      };
    }
    for (let i = 0; i < list.length; i++) {
      try {
        applied.push(await applyWrite(list[i]));
      } catch (e) {
        return {
          ok: false,
          applied,
          failedAt: i,
          failedOp: list[i] && list[i].op,
          error: (0, import_errmsg.errMsg)(e)
        };
      }
    }
    return { ok: true, applied };
  }

  // src/bridge.ts
  var bridgeRun = (cmd) => ({ source: "bridge", label: cmd });
  var INSTANCE_ID = "fig-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  var INSTANCE_STARTED_AT = Date.now();
  async function handleBridge(cmd, args) {
    switch (cmd) {
      // The probe for the multi-file question: run it in two files at once and compare `instanceId`.
      // UNQUEUED (like ping/getSelection) on purpose — it must stay answerable DURING a long export,
      // since "is the other file's connection still alive while this one works?" is half of what it
      // exists to measure.
      //
      // It answers four things in one call:
      //   instanceId / startedAt / uptimeMs — two distinct ids => two instances really do coexist; a
      //     CHANGED id on a later call => Figma tore the plugin runtime down and re-ran it (the
      //     southleft/figma-console-mcp#67 failure), which a reconnect alone would not reveal.
      //   fileKey                          — undefined => `enablePrivatePluginApi` is not in effect for
      //     a locally-imported plugin, so routing must fall back to a server-minted connection id.
      //   file / page                      — human labels for a connection listing, never routing keys.
      case "whoami": {
        const r = {
          instanceId: INSTANCE_ID,
          startedAt: INSTANCE_STARTED_AT,
          uptimeMs: Date.now() - INSTANCE_STARTED_AT,
          file: figma.root.name,
          page: figma.currentPage.name,
          pageId: figma.currentPage.id,
          editorType: figma.editorType
        };
        try {
          r.fileKey = typeof figma.fileKey !== "undefined" ? figma.fileKey : null;
        } catch (e) {
          r.fileKey = null;
        }
        r.fileKeyAvailable = typeof r.fileKey === "string" && r.fileKey.length > 0;
        return r;
      }
      case "ping": {
        const r = { pong: true, page: figma.currentPage.name, file: figma.root.name };
        try {
          if (typeof figma.fileKey !== "undefined") r.fileKey = figma.fileKey;
        } catch (e) {
        }
        return r;
      }
      // The extraction/write commands mutate shared per-run state (and the document), so they go through
      // serializeRun — this is the same chain the UI's manual runs use, so a bridge pull and a manual
      // export can never overlap. ping/getSelection are read-only and stay responsive (unqueued).
      case "exportFull":
        return await serializeRun(() => collectFull(args), bridgeRun(cmd));
      // The tokens/styles/components-only pull — no page/frame walk, no assets. See collect.ts's
      // collectDesignSystemOnly for the one tradeoff (library-variable completeness).
      case "exportDesignSystem":
        return await serializeRun(() => collectDesignSystemOnly(args), bridgeRun(cmd));
      // The library-file pull. QUEUED like its export siblings (not unqueued like listLibraries): it runs
      // the full catalog build and mutates the same per-run state they do.
      case "exportLibrary":
        return await serializeRun(() => collectLibraryFile(args), bridgeRun(cmd));
      case "exportSelection":
        return await serializeRun(() => collectSelection(args), bridgeRun(cmd));
      case "exportNode":
        return await serializeRun(() => collectNode(args && args.nodeId, args), bridgeRun(cmd));
      // The on-demand single-node screenshot — deliberately its own op rather than a mode of exportNode:
      // it skips serialize() and the recursive asset walk entirely (see collectScreenshot's comment), so
      // routing it through exportNode's shape would mislead a caller into thinking it got a tree back.
      case "screenshot":
        return await serializeRun(() => collectScreenshot(args && args.nodeId, { scale: args && args.scale }), bridgeRun(cmd));
      case "getSelection":
        return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
      // UNQUEUED on purpose, both of them. These are the cheap maps you consult to decide WHICH deep
      // pull to run, so routing them through serializeRun would queue them behind the very export they
      // exist to avoid — a 12-minute --all-pages would block "what's in this file?" for 12 minutes.
      // They only READ page/child metadata and mutate none of the per-run state serializeRun protects.
      case "listPages":
        return await listPages(args || {});
      case "listChildren":
        return await listChildren(args && args.nodeId);
      // UNQUEUED for the same reason as the two above: it is the cheap "which libraries feed this file?"
      // map you consult BEFORE deciding what to pull, it mutates no per-run state, and queueing it
      // behind a long export would defeat the point of asking. Its document walk is one
      // findAllWithCriteria per page with skipInvisibleInstanceChildren on — the same cost class as
      // listPages depth 2, not that of an export.
      case "listLibraries":
        return await listLibraries();
      case "write":
        return await serializeRun(() => applyWrites(args && args.ops), bridgeRun(cmd));
      default:
        throw new Error("unknown cmd: " + cmd);
    }
  }

  // src/main.ts
  globalThis.__designExport = { serialize, collectSelection, collectNode, collectScreenshot, collectFull, collectDesignSystemOnly, collectLibraryFile, listPages, listChildren, buildDesignSystem, applyWrites, listLibraries, collectLibraryComponents, serializeRun, requestCancel };
  figma.showUI(__html__, { width: 360, height: 380, themeColors: true });
  console.log("[export] main.ts loaded (main thread)");
  async function runExport(label, collect, toFiles) {
    let r;
    try {
      r = await serializeRun(collect, { source: "ui", label });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: (0, import_errmsg.errMsg)(e) });
      return;
    }
    const { files, layerFiles, summary, warnings: warnings2 } = toFiles(r);
    figma.ui.postMessage({ type: "files", files, layerFiles, assets: r.assets, summary, warnings: warnings2 ? warnings2.length : 0 });
    releaseAssets();
  }
  var runSelection = () => runExport("current selection", collectSelection, (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: JSON.stringify(r.screen, null, 2), copyable: true },
      { name: "variables.json", content: JSON.stringify(r.variables, null, 2) }
    ],
    summary: `${r.screenName} \u2014 ${r.assets.length} asset(s)`,
    warnings: r.screen.manifest && r.screen.manifest.warnings
  }));
  var SEP = "__";
  var runFull = () => runExport("design system + page frames", collectFull, (r) => {
    const { meta, layerFiles, indexFiles, rootIndex } = (0, import_pages_layout2.buildPageLayout)(r.layersDoc, SEP);
    const ds = (0, import_design_system_layout.buildDesignSystemLayout)(r.designSystem, SEP);
    const dsParts = ds.files.filter((f) => f.path !== "design-system.json");
    const batch = [...layerFiles, ...indexFiles, ...dsParts].map((f) => ({ name: f.path, content: JSON.stringify(f.data, null, 2) }));
    return {
      files: [
        { name: "design-system.json", content: JSON.stringify(ds.manifest, null, 2) },
        { name: rootIndex, content: JSON.stringify(meta, null, 2) }
      ],
      layerFiles: batch,
      summary: `${layerFiles.length} layer(s) across ${meta.pageDirs.length} page(s), ${r.designSystem.variables.length} vars, ${r.designSystem.components.length} components, ${r.assets.length} asset(s)`,
      warnings: r.layersDoc.manifest && r.layersDoc.manifest.warnings
    };
  });
  function notifySelection() {
    const sel = figma.currentPage.selection;
    figma.ui.postMessage({ type: "selection", count: sel.length, name: sel.length ? sel[0].name : null });
  }
  figma.ui.onmessage = async (msg) => {
    if (!msg) return;
    if (msg.type === "get-token") {
      const token = await figma.clientStorage.getAsync("bridgeToken");
      figma.ui.postMessage({ type: "token", token: token || "" });
    } else if (msg.type === "set-token") {
      await figma.clientStorage.setAsync("bridgeToken", msg.token || "");
    } else if (msg.type === "get-identity") {
      let identity = {};
      try {
        identity = await handleBridge("whoami", {});
      } catch (e) {
        identity = { error: (0, import_errmsg.errMsg)(e) };
      }
      figma.ui.postMessage({ type: "identity", identity });
    } else if (msg.type === "run-selection") {
      await runSelection();
    } else if (msg.type === "run-full") {
      await runFull();
    } else if (msg.type === "cancel") {
      const hit = requestCancel();
      figma.ui.postMessage({ type: "cancel-ack", accepted: !!hit, label: hit ? hit.label : null });
    } else if (msg.type === "bridge") {
      let result;
      let error;
      try {
        result = await handleBridge(msg.cmd, msg.args);
      } catch (e) {
        error = (0, import_errmsg.errMsg)(e);
      }
      figma.ui.postMessage({ type: "bridge-result", id: msg.id, ok: !error, result, error });
      releaseAssets();
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
