// GENERATED from src/*.ts by build.js — do not edit by hand. Run `npm run build`.
"use strict";
(() => {
  // src/util.ts
  var round = (n) => typeof n === "number" ? Math.round(n * 100) / 100 : n;
  var safe = (id) => id.replace(/[^a-zA-Z0-9]/g, "_");
  var propName = (k) => k.split("#")[0];
  var errMsg = (e) => String(e && e.message || e);
  var nonEmpty = (o) => Object.keys(o).length ? o : void 0;
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

  // src/state.ts
  var assets = [];
  var runOpts = { css: false, measurements: false, pluginData: false, motion: false, sharedData: false };
  var imageSizeCache = /* @__PURE__ */ new Map();
  var warnings = [];
  var stats = { nodes: 0, assetsFailed: 0, truncated: 0 };
  function warn(msg) {
    warnings.push(msg);
  }
  function manifest() {
    return { ...stats, skipped: stats.truncated, warnings: warnings.slice() };
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
  var collectionCache = /* @__PURE__ */ new Map();
  function getCollection(id) {
    let p = collectionCache.get(id);
    if (!p) {
      try {
        p = figma.variables && figma.variables.getVariableCollectionByIdAsync ? Promise.resolve(figma.variables.getVariableCollectionByIdAsync(id)).catch(() => null) : Promise.resolve(null);
      } catch (e) {
        p = Promise.resolve(null);
      }
      collectionCache.set(id, p);
    }
    return p;
  }
  var runChain = Promise.resolve();
  function serializeRun(fn) {
    const next = runChain.then(() => fn(), () => fn());
    runChain = next.then(() => {
    }, () => {
    });
    return next;
  }
  function releaseAssets() {
    assets.length = 0;
  }
  function resetRun() {
    assets.length = 0;
    warnings = [];
    stats = { nodes: 0, assetsFailed: 0, truncated: 0 };
    varName.reset();
    styleNameLookup.reset();
    nodeNameLookup.reset();
    collectionCache.clear();
    imageSizeCache.clear();
  }

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
  async function dumpVariables() {
    const [collections, localVars] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync()
    ]);
    const collById = new Map(collections.map((c) => [c.id, c]));
    const collOf = (cid) => collById.get(cid);
    const localIds = new Set(localVars.map((v) => v.id));
    const variables = [];
    const hygiene = [];
    const referenced = varName.ids().filter((id) => !localIds.has(id));
    const remoteVars = (await Promise.all(referenced.map((id) => varName.obj(id)))).filter(Boolean);
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
      for (const modeId of Object.keys(v.valuesByMode)) {
        const raw = v.valuesByMode[modeId];
        if (raw && raw.type === "VARIABLE_ALIAS") {
          hasAlias = true;
          if (!resolvedIds.has(raw.id)) hygiene.push("broken alias in '" + v.name + "' \u2014 target " + raw.id + " could not be resolved");
        }
        values[modeName[modeId] || modeId] = await resolveModeValue(raw, v.resolvedType);
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
      if (v.codeSyntax && Object.keys(v.codeSyntax).length) rec.codeSyntax = v.codeSyntax;
      if (v.description) rec.description = v.description;
      if (v.remote) rec.remote = true;
      if (v.hiddenFromPublishing) rec.hiddenFromPublishing = true;
      if (v.key) rec.key = v.key;
      variables.push(rec);
      if (v.scopes && v.scopes.indexOf("ALL_SCOPES") !== -1) hygiene.push("ALL_SCOPES on '" + v.name + "' (pollutes every picker)");
      const modeCount = (collOf(v.variableCollectionId) || { modes: [] }).modes.length || 1;
      if (!hasAlias && v.resolvedType === "COLOR" && modeCount > 1) {
        hygiene.push("semantic color '" + v.name + "' holds a raw value in a multi-mode collection (breaks theming)");
      }
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
        key: c.key || void 0
        // durable cross-file collection identity
      })),
      variables,
      hygiene
    };
  }

  // src/assets.ts
  var ASSET_DIR = "assets/";
  function register(a) {
    const file = safe(a.id) + "." + safe(a.format);
    assets.push({ ...a, file });
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
      warn("source image unavailable for hash " + hash + " (" + errMsg(e) + ")");
    }
    return size;
  }
  var VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON", "ELLIPSE"];
  var ICON_CONTAINER_TYPES = ["FRAME", "INSTANCE", "GROUP", "COMPONENT"];
  async function collectAsset(node) {
    const isVector = VECTOR_TYPES.includes(node.type);
    const n = node;
    const fills = "fills" in node && Array.isArray(n.fills) ? n.fills : null;
    const kids = "children" in node && Array.isArray(n.children) ? n.children : null;
    const hasImage = !!fills && fills.some((f) => f.type === "IMAGE" && f.visible !== false) && !(kids && kids.length > 0);
    let iconLike = false;
    if (ICON_CONTAINER_TYPES.includes(node.type) && node.name && /icon|logo|illustration|avatar/i.test(node.name) && "width" in node && Math.max(n.width, n.height) <= 96) {
      try {
        iconLike = !n.findOne((x) => x.type === "TEXT");
      } catch (e) {
        iconLike = false;
      }
    }
    try {
      if (isVector || iconLike) {
        const svg = await node.exportAsync({ format: "SVG_STRING" });
        if (!svg || svg.indexOf("<svg") === -1) {
          warn("asset export empty/invalid: " + node.name);
          stats.assetsFailed++;
          return void 0;
        }
        return register({ id: node.id, name: node.name, format: "svg", text: svg });
      }
      if (hasImage) {
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 }, useAbsoluteBounds: true });
        if (!bytes || !bytes.length) {
          warn("asset export empty: " + node.name);
          stats.assetsFailed++;
          return void 0;
        }
        return register({ id: node.id, name: node.name, format: "png", base64: toBase64(bytes) });
      }
    } catch (e) {
      warn("asset export failed: " + node.name + " (" + errMsg(e) + ")");
      stats.assetsFailed++;
    }
    return void 0;
  }
  async function collectReference(node) {
    const n = node;
    if (!node || !("exportAsync" in node) || !("width" in node)) return void 0;
    try {
      const maxDim = Math.max(n.width || 0, n.height || 0) || 1;
      const value = Math.min(2, 2048 / maxDim);
      const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
      if (!bytes || !bytes.length) {
        warn("reference screenshot empty: " + node.name);
        return void 0;
      }
      return register({ id: node.id + ":ref", name: node.name + " (reference)", format: "png", base64: toBase64(bytes), kind: "reference" });
    } catch (e) {
      warn("reference screenshot failed: " + node.name + " (" + errMsg(e) + ")");
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
      warn("dev resources unavailable for '" + node.name + "' (" + errMsg(e) + ")");
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
    if (!("strokes" in node) || !Array.isArray(node.strokes)) return void 0;
    const vis = node.strokes.filter((s) => s.visible !== false);
    if (!vis.length) return void 0;
    const out = {};
    const solids = vis.filter((s) => s.type === "SOLID");
    if (solids.length) out.colors = solids.map(solidHex);
    if (vis.some((s) => s.type !== "SOLID")) {
      const paints = await simplifyFills(vis);
      if (paints) out.paints = paints;
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
      if (Object.keys(sides).length) out.weights = sides;
    }
    const n = node;
    if (n.strokeAlign) out.align = String(n.strokeAlign).toLowerCase();
    if (n.dashPattern && n.dashPattern.length) out.dash = n.dashPattern;
    if ("strokeCap" in node && n.strokeCap && n.strokeCap !== figma.mixed && n.strokeCap !== "NONE") out.cap = String(n.strokeCap).toLowerCase();
    if ("strokeJoin" in node && n.strokeJoin && n.strokeJoin !== figma.mixed && n.strokeJoin !== "MITER") out.join = String(n.strokeJoin).toLowerCase();
    if ("strokeMiterLimit" in node && typeof n.strokeMiterLimit === "number" && n.strokeMiterLimit !== 4) out.miter = n.strokeMiterLimit;
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
    if (t.hangingList === true) out.font.hangingList = true;
    if (t.hangingPunctuation === true) out.font.hangingPunctuation = true;
    if (t.textAutoResize && t.textAutoResize !== "NONE") out.autoResize = t.textAutoResize.toLowerCase();
    if (t.textTruncation === "ENDING") out.truncate = true;
    if (typeof t.maxLines === "number" && t.maxLines) out.maxLines = t.maxLines;
    if (t.hasMissingFont === true) {
      out.missingFont = true;
      warn("missing font on text '" + node.name + "' \u2014 Figma is substituting a fallback; recorded family may differ from render");
    }
    if (node.width === 0) warn("zero-width text node (possible collapsed thread): " + node.name);
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

  // src/components.ts
  async function instanceComponent(node) {
    if (node.type !== "INSTANCE") return void 0;
    try {
      const main = await node.getMainComponentAsync();
      return main ? main.name : void 0;
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
  async function collectComponentCatalog(hygiene) {
    const components = [];
    const seenNames = /* @__PURE__ */ new Set();
    const prevSkip = figma.skipInvisibleInstanceChildren;
    try {
      try {
        figma.skipInvisibleInstanceChildren = true;
      } catch (e) {
      }
      for (const page of figma.root.children) {
        let nodes = [];
        try {
          nodes = page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
        } catch (e) {
          warn("component catalog: page '" + page.name + "' could not be traversed (" + errMsg(e) + ") \u2014 its components are missing");
          continue;
        }
        for (const n of nodes) {
          if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
          const entry = { name: n.name, id: n.id, type: n.type, page: page.name };
          if (n.description) entry.description = n.description;
          if (n.remote) entry.remote = true;
          if (n.key) entry.key = n.key;
          if (Array.isArray(n.documentationLinks) && n.documentationLinks.length) entry.docs = n.documentationLinks.map((d) => d.uri).filter(Boolean);
          try {
            const defs = n.componentPropertyDefinitions;
            if (defs && Object.keys(defs).length) {
              entry.props = {};
              let variantCombos = 1;
              for (const k of Object.keys(defs)) {
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
                const dbv = await resolveBoundMap(d.boundVariables);
                if (dbv) p.tokens = dbv;
                entry.props[propName(k)] = p;
              }
              if (variantCombos > 30) hygiene.push("variant explosion: '" + n.name + "' has " + variantCombos + " combinations (>30 \u2014 consider boolean/instance-swap props)");
            }
          } catch (e) {
            warn("component '" + n.name + "': property definitions unreadable (" + errMsg(e) + ") \u2014 props omitted");
          }
          if (/^(Component|Frame)\s*\d+$/.test(n.name)) hygiene.push("unnamed component: '" + n.name + "'");
          if (seenNames.has(n.name)) hygiene.push("duplicate component name: '" + n.name + "'");
          seenNames.add(n.name);
          components.push(entry);
        }
      }
    } finally {
      try {
        figma.skipInvisibleInstanceChildren = prevSkip;
      } catch (e) {
      }
    }
    return components;
  }
  async function buildDesignSystem() {
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
    if (figma.loadAllPagesAsync) {
      try {
        await figma.loadAllPagesAsync();
      } catch (e) {
        warn("loadAllPagesAsync failed (component catalog may be incomplete): " + errMsg(e));
      }
    }
    const components = await collectComponentCatalog(hygiene);
    let colorProfile;
    try {
      if (figma.root && figma.root.documentColorProfile) colorProfile = String(figma.root.documentColorProfile).toLowerCase();
    } catch (e) {
    }
    const [paintStyles, textStyles, effectStyles] = await Promise.all([
      // Paint styles carry their ACTUAL colors, not just a name.
      Promise.all(paint.map(async (s) => ({ name: s.name, paints: await simplifyFills(s.paints), description: s.description || void 0 }))),
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
          tokens: await resolveBoundMap(s.boundVariables),
          description: s.description || void 0
        }))
      ),
      Promise.all(effect.map(async (s) => ({ name: s.name, effects: await simplifyEffects(s.effects), description: s.description || void 0 })))
    ]);
    const styles = {
      paint: paintStyles,
      text: textStyles,
      effect: effectStyles,
      // Layout-grid styles (column/row grids) — the responsive grid tokens. Sync, so no await needed.
      grid: grid.map((s) => ({ name: s.name, grids: Array.isArray(s.layoutGrids) ? s.layoutGrids.map(simplifyGrid).filter(Boolean) : void 0, description: s.description || void 0 }))
    };
    const vars = await dumpVariables();
    return {
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      file: figma.root && figma.root.name || void 0,
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
      if (Object.keys(o).length) out[field] = o;
    }
    return Object.keys(out).length ? out : void 0;
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
    return Object.keys(out).length ? out : void 0;
  }

  // src/serialize.ts
  var MAX_DEPTH = 60;
  var LOWER_ENUMS = [
    ["layoutAlign", "alignSelf", "INHERIT"],
    ["layoutSizingHorizontal", "widthMode"],
    ["layoutSizingVertical", "heightMode"],
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
  async function resolveInferred(node, alreadyBound) {
    const inf = node.inferredVariables;
    if (!inf || typeof inf !== "object") return void 0;
    const out = {};
    for (const field of Object.keys(inf)) {
      if (alreadyBound && field in alreadyBound) continue;
      let candidates = inf[field];
      if (Array.isArray(candidates) && Array.isArray(candidates[0])) candidates = candidates.flat();
      if (!Array.isArray(candidates)) candidates = [candidates];
      const names = (await Promise.all(candidates.map((a) => resolveVar(a)))).filter(Boolean);
      if (names.length) out[field] = names.length === 1 ? names[0] : names;
    }
    return nonEmpty(out);
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
      if (Object.keys(bucket).length) out[ns] = bucket;
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
      if (Object.keys(props).length) out.props = props;
      if (Object.keys(propTokens).length) out.propTokens = propTokens;
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
      out.box = { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height) };
      const rb = n.absoluteRenderBounds;
      if (rb && (rb.x !== b.x || rb.y !== b.y || rb.width !== b.width || rb.height !== b.height)) {
        out.renderBox = { x: round(rb.x), y: round(rb.y), w: round(rb.width), h: round(rb.height) };
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
    if ("clipsContent" in node && n.clipsContent) out.clip = true;
    const fills = await simplifyFills("fills" in node ? n.fills : void 0);
    if (fills) out.fills = fills;
    const strokes = await simplifyStrokes(node);
    if (strokes) out.strokes = strokes;
    if ("strokesIncludedInLayout" in node && n.strokesIncludedInLayout) out.strokesInLayout = true;
    const effects = await simplifyEffects("effects" in node ? n.effects : void 0);
    if (effects) out.effects = effects;
    if ("cornerRadius" in node) {
      if (n.cornerRadius !== figma.mixed && n.cornerRadius) out.radius = n.cornerRadius;
      else if (n.cornerRadius === figma.mixed) {
        const corners = {};
        for (const [k, s] of CORNER_KEYS) {
          if (k in node && typeof n[k] === "number" && n[k]) corners[s] = n[k];
        }
        if (Object.keys(corners).length) out.radius = corners;
      }
    }
    if ("opacity" in node && n.opacity < 1) out.opacity = round(n.opacity);
    if ("rotation" in node && n.rotation) out.rotation = round(n.rotation);
    if ("relativeTransform" in node && Array.isArray(n.relativeTransform) && n.relativeTransform.length === 2) {
      const m = n.relativeTransform;
      const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
      if (det < 0) out.flipped = true;
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
        if (Object.keys(arc).length) out.arc = arc;
      }
    }
    if (node.type === "STAR") {
      const shape = {};
      if (typeof n.pointCount === "number") shape.points = n.pointCount;
      if (typeof n.innerRadius === "number") shape.innerRadius = round(n.innerRadius);
      if (Object.keys(shape).length) out.shape = shape;
    }
    if (node.type === "POLYGON" && typeof n.pointCount === "number") out.shape = { points: n.pointCount };
    if (node.type === "BOOLEAN_OPERATION" && n.booleanOperation) out.booleanOp = String(n.booleanOperation).toLowerCase();
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
    const [componentName, tokens, styles, asset, reactions, varModes, css] = await Promise.all([
      instanceComponent(node),
      boundTokens(node),
      nodeStyles(node),
      collectAsset(node),
      simplifyReactions(node),
      variableModes(node),
      runOpts.css ? nodeCss(node) : Promise.resolve(void 0)
    ]);
    if (componentName) out.component = componentName;
    if (tokens) out.tokens = tokens;
    if (styles) out.styles = styles;
    if (reactions) out.reactions = reactions;
    if (varModes) out.variableModes = varModes;
    if (css) out.css = css;
    const inferred = await resolveInferred(node, tokens);
    if (inferred) out.inferredTokens = inferred;
    if (asset) {
      out.asset = asset;
      return out;
    }
    if (node.type === "TABLE" && typeof n.numRows === "number" && typeof n.numColumns === "number") {
      const rows = [];
      for (let r = 0; r < n.numRows; r++) {
        const row = [];
        for (let cc = 0; cc < n.numColumns; cc++) {
          try {
            const cell = n.cellAt(r, cc);
            if (!cell) continue;
            const co = { row: r, col: cc };
            if (cell.text) Object.assign(co, await serializeText(cell.text));
            const cfills = await simplifyFills(cell.fills);
            if (cfills) co.fills = cfills;
            row.push(co);
          } catch (e) {
          }
        }
        if (row.length) rows.push(row);
      }
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
  async function screenResult(title, fileBase, nodes) {
    const screen = { exportedAt: (/* @__PURE__ */ new Date()).toISOString(), screen: title, nodes, manifest: manifest() };
    const measurements = collectMeasurements();
    if (measurements) screen.measurements = measurements;
    return { screenName: safe(fileBase), screen, variables: await dumpVariables(), assets: assets.slice() };
  }
  function applyOpts(opts) {
    for (const k of Object.keys(runOpts)) runOpts[k] = !!(opts && opts[k]);
  }
  var CSS_AUTO_NODE_CAP = 60;
  function subtreeSize(node, cap) {
    let count = 0;
    const stack = [node];
    while (stack.length && count <= cap) {
      const n = stack.pop();
      count++;
      if (n && "children" in n && Array.isArray(n.children)) {
        for (const c of n.children) stack.push(c);
      }
    }
    return count;
  }
  function autoCss(opts, node) {
    const o = { ...opts };
    if (o.css === void 0 && subtreeSize(node, CSS_AUTO_NODE_CAP) <= CSS_AUTO_NODE_CAP) o.css = true;
    return o;
  }
  function collectMeasurements() {
    const p = figma.currentPage;
    if (!runOpts.measurements || typeof p.getMeasurements !== "function") return void 0;
    try {
      const ms = p.getMeasurements();
      if (!Array.isArray(ms) || !ms.length) return void 0;
      const side = (e) => e ? { nodeId: e.node && e.node.id, side: e.side } : void 0;
      return ms.map((m) => {
        const o = { start: side(m.start), end: side(m.end) };
        if (m.freeText) o.text = m.freeText;
        if (m.offset != null) o.offset = m.offset;
        return o;
      });
    } catch (e) {
      warn("measurements unavailable (Dev Mode only): " + errMsg(e));
      return void 0;
    }
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
    return screenResult(sel.length === 1 ? sel[0].name : "selection", sel[0].name, nodes);
  }
  function pageOf(node) {
    let n = node;
    while (n && n.type !== "PAGE") n = n.parent;
    return n && n.type === "PAGE" ? n : null;
  }
  async function collectNode(rawId, opts) {
    resetRun();
    const nodeId = String(rawId || "").replace(/-/g, ":");
    if (!nodeId) throw new Error("No node id provided.");
    let node = await figma.getNodeByIdAsync(nodeId);
    if (!node && figma.loadAllPagesAsync) {
      try {
        await figma.loadAllPagesAsync();
      } catch (e) {
        warn("loadAllPagesAsync failed (cross-page node lookup may miss): " + errMsg(e));
      }
      node = await figma.getNodeByIdAsync(nodeId);
    }
    if (!node) throw new Error("Node " + nodeId + " is not in the open file \u2014 open the Figma file this link points to, then retry.");
    applyOpts(autoCss(opts, node));
    try {
      const page = pageOf(node);
      if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
      if ("visible" in node && node.parent) figma.currentPage.selection = [node];
      if (figma.viewport && "visible" in node) figma.viewport.scrollAndZoomIntoView([node]);
    } catch (e) {
    }
    const tree = await rootTree(node);
    if (!tree) throw new Error("Node " + nodeId + " is hidden or not exportable.");
    return screenResult(node.name, node.name, [tree]);
  }
  var FRAME_TYPES = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION"];
  var TOP_LEVEL_TYPES = FRAME_TYPES.concat(["TEXT", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE", "VECTOR", "BOOLEAN_OPERATION", "TABLE"]);
  async function collectFull(opts) {
    resetRun();
    applyOpts(opts);
    const allPages = !!(opts && opts.allPages);
    if (allPages && figma.loadAllPagesAsync) {
      try {
        await figma.loadAllPagesAsync();
      } catch (e) {
        warn("loadAllPagesAsync failed (all-pages export may miss pages): " + errMsg(e));
      }
    }
    const pages = allPages ? figma.root.children : [figma.currentPage];
    const screens = [];
    const index = [];
    const flows = [];
    for (const page of pages) {
      let children;
      try {
        if (Array.isArray(page.flowStartingPoints)) {
          for (const fp of page.flowStartingPoints) flows.push({ page: page.name, nodeId: fp.nodeId, name: fp.name });
        }
        children = page.children;
      } catch (e) {
        warn("page '" + page.name + "' could not be read (not loaded) \u2014 its frames are missing from this export: " + errMsg(e));
        continue;
      }
      const frames = [];
      for (const nd of children) {
        if (TOP_LEVEL_TYPES.includes(nd.type)) frames.push(nd);
        else if (nd.visible !== false) warn("top-level " + nd.type + " '" + nd.name + "' on page '" + page.name + "' not exported (unhandled top-level type)");
      }
      for (const f of frames) {
        const { tree, ref, dev } = await serializeWithRefs(f);
        if (tree) {
          screens.push({ name: f.name, id: f.id, page: page.name, tree, reference: ref, devResources: dev });
          index.push({ name: f.name, id: f.id, type: f.type, page: page.name });
        }
      }
    }
    const designSystem = await buildDesignSystem();
    const measurements = collectMeasurements();
    const screensDoc = {
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      scope: allPages ? "all-pages" : "current-page",
      page: allPages ? void 0 : figma.currentPage.name,
      pages: allPages ? pages.map((p) => p.name) : void 0,
      flows: flows.length ? flows : void 0,
      measurements: measurements || void 0,
      index,
      screens,
      manifest: manifest()
    };
    return { designSystem, screensDoc, assets: assets.slice() };
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
    for (let i = 0; i < list.length; i++) {
      try {
        applied.push(await applyWrite(list[i]));
      } catch (e) {
        return {
          ok: false,
          applied,
          failedAt: i,
          failedOp: list[i] && list[i].op,
          error: errMsg(e)
        };
      }
    }
    return { ok: true, applied };
  }

  // src/bridge.ts
  async function handleBridge(cmd, args) {
    switch (cmd) {
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
        return await serializeRun(() => collectFull(args));
      case "exportSelection":
        return await serializeRun(() => collectSelection(args));
      case "exportNode":
        return await serializeRun(() => collectNode(args && args.nodeId, args));
      case "getSelection":
        return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
      case "write":
        return await serializeRun(() => applyWrites(args && args.ops));
      default:
        throw new Error("unknown cmd: " + cmd);
    }
  }

  // src/main.ts
  globalThis.__designExport = { serialize, collectSelection, collectNode, collectFull, buildDesignSystem, applyWrites };
  figma.showUI(__html__, { width: 360, height: 380 });
  console.log("[export] main.ts loaded (main thread)");
  async function runExport(collect, toFiles) {
    let r;
    try {
      r = await serializeRun(collect);
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: errMsg(e) });
      return;
    }
    const { files, summary } = toFiles(r);
    figma.ui.postMessage({ type: "files", files, assets: r.assets, summary });
    releaseAssets();
  }
  var runSelection = () => runExport(collectSelection, (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: JSON.stringify(r.screen, null, 2), copyable: true },
      { name: "variables.json", content: JSON.stringify(r.variables, null, 2) }
    ],
    summary: `${r.screenName} \u2014 ${r.assets.length} asset(s)`
  }));
  var runFull = () => runExport(collectFull, (r) => ({
    files: [
      { name: "design-system.json", content: JSON.stringify(r.designSystem, null, 2) },
      { name: "screens.json", content: JSON.stringify(r.screensDoc, null, 2) }
    ],
    summary: `${r.screensDoc.screens.length} screen(s), ${r.designSystem.variables.length} vars, ${r.designSystem.components.length} components, ${r.assets.length} asset(s)`
  }));
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
    } else if (msg.type === "run-selection") {
      await runSelection();
    } else if (msg.type === "run-full") {
      await runFull();
    } else if (msg.type === "bridge") {
      let result;
      let error;
      try {
        result = await handleBridge(msg.cmd, msg.args);
      } catch (e) {
        error = errMsg(e);
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
