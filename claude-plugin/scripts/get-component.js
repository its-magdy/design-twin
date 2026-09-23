// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/catalog-input.js
var require_catalog_input = __commonJS({
  "design-to-code/catalog-input.js"(exports2, module2) {
    function isManifest(doc, payloadKey) {
      return !!(doc && doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) && !Array.isArray(doc[payloadKey]));
    }
    function assertNotManifest2(doc, givenPath, payloadKey, wantFile) {
      if (isManifest(doc, payloadKey)) {
        console.error(
          `error  '${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.
       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.
       Pass the split file instead \u2014 e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile} (relative to the export dir that holds ${givenPath}).`
        );
        process.exit(2);
      }
    }
    function readJsonFile(file, what, hint) {
      const fs2 = require("fs");
      let raw;
      try {
        raw = fs2.readFileSync(file, "utf8");
      } catch (e) {
        const why = e && e.code === "ENOENT" ? "does not exist" : e && e.code === "EISDIR" ? "is a directory, not a file" : e && e.code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${e && e.code || e})`;
        console.error(`error  ${what}: '${file}' ${why}.` + (hint ? `
       ${hint}` : ""));
        process.exit(2);
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error(`error  ${what}: '${file}' is not valid JSON \u2014 ${e && e.message || e}`);
        process.exit(2);
      }
    }
    var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull design --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull design --design-system` to create it.";
    module2.exports = { assertNotManifest: assertNotManifest2, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
  }
});

// bridge/pages-layout.js
var require_pages_layout = __commonJS({
  "bridge/pages-layout.js"(exports2, module2) {
    "use strict";
    function safe(id) {
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
    function buildPageLayout(layersDoc, sep) {
      const { layers, index, ...meta } = layersDoc || {};
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
          bucket = { page: pageName, pageId: l.pageId, dir: uniqueDir(pageName), entries: [] };
          byPage.set(key, bucket);
          bucket.index = join(bucket.dir, "index.json");
          pages.push(bucket);
        }
        const base = safe(l.name || "layer") + "__" + safe(l.id) + ".json";
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
      const page = screenDoc.page || screenDoc.screen && screenDoc.screen.page;
      const pageId = screenDoc.pageId || screenDoc.screen && screenDoc.screen.pageId;
      const dir = page ? safe(page) : NO_PAGE_DIR;
      const nodeId = screenDoc.nodeId || screenDoc.screen && screenDoc.screen.nodeId;
      const base = safe(screenDoc.screenName || "screen") + (nodeId ? "__" + safe(nodeId) : "");
      return {
        page: page || null,
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
    module2.exports = { buildPageLayout, screenPaths, mergeScreenIndex, mergeRootIndex, deriveTitle, collectTexts, firstByName, firstText, safe, NO_PAGE_DIR };
  }
});

// bridge/design-system-layout.js
var require_design_system_layout = __commonJS({
  "bridge/design-system-layout.js"(exports2, module2) {
    "use strict";
    var { safe } = require_pages_layout();
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
    function buildDesignSystemLayout(ds, sep) {
      const d = ds || {};
      const join = (name) => DIR + (sep || "/") + name;
      const stamp = { exportedAt: d.exportedAt, file: d.file, colorProfile: d.colorProfile };
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
      const manifest = {
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
        manifest.files.componentsDir = DIR + (sep || "/") + COMPONENTS_DIR;
      }
      files.push({ path: MANIFEST, data: manifest });
      return { files, manifest, counts, dir: DIR };
    }
    module2.exports = {
      buildDesignSystemLayout,
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

// design-to-code/get-component.js
var fs = require("fs");
var path = require("path");
var { assertNotManifest } = require_catalog_input();
var { DESIGN_SYSTEM_DIR } = require_design_system_layout();
function findComponent(catalog, handle) {
  const comps = catalog && catalog.components || [];
  const byKey = comps.find((c) => c.key === handle);
  if (byKey) return byKey;
  const byId = comps.find((c) => c.id === handle);
  if (byId) return byId;
  const byName = comps.filter((c) => c.name === handle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const err = new Error(`'${handle}' matches ${byName.length} components by name \u2014 use its key or id instead (${byName.map((c) => c.key || c.id).join(", ")})`);
    err.code = "ambiguous-name";
    throw err;
  }
  return null;
}
function resolveVariantsFile(catalogFile, variantsFile) {
  const catalogDir = path.dirname(catalogFile);
  const root = path.basename(catalogDir) === DESIGN_SYSTEM_DIR ? path.dirname(catalogDir) : catalogDir;
  return path.join(root, variantsFile);
}
function getComponent(catalogFile, handle) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const comp = findComponent(catalog, handle);
  if (!comp) return { found: false };
  const pointer = comp.variantsFile || comp.nodeFile;
  if (!pointer) return { found: true, component: comp, detail: null };
  const detailPath = resolveVariantsFile(catalogFile, pointer);
  const detail = JSON.parse(fs.readFileSync(detailPath, "utf8"));
  return { found: true, component: comp, detail, detailPath };
}
module.exports = { getComponent, findComponent, resolveVariantsFile };
if (require.main === module) {
  const [catalogFile, handle] = process.argv.slice(2);
  if (!catalogFile || !handle) {
    console.error("usage: node design-to-code/get-component.js <design-system/components.local.json> <key|id|name>");
    process.exit(2);
  }
  try {
    const res = getComponent(catalogFile, handle);
    if (!res.found) {
      console.error(`error  no component matches '${handle}' in ${catalogFile}`);
      process.exit(1);
    }
    if (!res.detail) {
      console.error(`warn   '${handle}' has no variantsFile/nodeFile (no node trees were exported for it \u2014 re-run the export with variantVisuals:true) \u2014 printing the catalog entry only`);
      process.stdout.write(JSON.stringify(res.component, null, 2) + "\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(res.detail, null, 2) + "\n");
  } catch (e) {
    console.error(`error  ${e.message}`);
    process.exit(2);
  }
}
