#!/usr/bin/env node
/**
 * convert-tokens.js — Design Tokens → CSS Custom Properties
 * =====================================================================
 *
 * Converts the Tokens Studio / Figma design-token export found in
 * `design-tokens.tokens.json` into a single `design-tokens.css` file that
 * exposes every token as a CSS custom property (a.k.a. CSS variable) under
 * the `:root` selector.
 *
 * ---------------------------------------------------------------------
 * HOW TO RUN
 * ---------------------------------------------------------------------
 *   node convert-tokens.js
 *
 *   # custom paths (both optional):
 *   node convert-tokens.js my-tokens.json my-tokens.css
 *
 * ---------------------------------------------------------------------
 * WHAT IT GENERATES
 * ---------------------------------------------------------------------
 * Primitive colors     --color-primitive-*              foundation palette
 * Color roles          --color-role-*                   semantic, UI-facing
 * Effects (shadows)    --effect-*                       drop shadow values
 * Spacing              --space-*                        dimension values (px)
 * Typography           --typography-<name>-*            text style parts + shorthand
 * Font families        --font-*                         quoted font-family stacks
 *
 * ---------------------------------------------------------------------
 * THE COLOR SYSTEM (IMPORTANT)
 * ---------------------------------------------------------------------
 * The token file separates colors into two layers:
 *
 *   1. PRIMITIVE COLORS  (--color-primitive-*)
 *        Raw material: hues, shades and neutrals such as
 *        `primary50`, `neutral20`, `error40`. These are the FOUNDATION of
 *        the system. They contain no design intent on their own and should
 *        NOT be applied directly to UI elements. They are the single source
 *        of truth that the roles below resolve to.
 *
 *   2. COLOR ROLES       (--color-role-*)
 *        Semantic, purpose-driven colors such as `primary`, `surface color`,
 *        `error container`, `on surface color`. These describe *what the
 *        color is for* in the interface and are the ONLY tokens that should
 *        be consumed directly by components/styles.
 *
 *        Role values are written as references to the primitives, e.g.
 *          --color-role-primary: var(--color-primitive-...-primary-key-color);
 *        so roles inherit their value from the palette but stay swappable
 *        (e.g. for theming/dark mode) without touching UI code.
 *
 * RULE OF THUMB:
 *   Components reference `--color-role-*`. They never reference
 *   `--color-primitive-*`. If no role exists for the intent you need,
 *   add a role — don't reach for a primitive.
 *
 * ---------------------------------------------------------------------
 * OTHER CONVERSION RULES
 * ---------------------------------------------------------------------
 * - Token references written as `{path.to.token}` (Tokens Studio syntax)
 *   are rewritten to `var(--<token>)` so the dependency chain is preserved.
 * - 8-digit hex colors such as `#2563ebff` are valid CSS Color 4 values and
 *   are emitted unchanged (RRGGBBAA — the trailing pair is the alpha channel).
 * - Dimensions (spacing, font sizes, line heights, letter spacing) are
 *   numeric in the source and are converted to `px`.
 * - Custom shadows are expanded to the standard `box-shadow` syntax:
 *   `offsetX offsetY radius spread color`.
 *
 * =====================================================================
 */

"use strict";

const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------ */
/*  Runtime configuration                                              */
/* ------------------------------------------------------------------ */

/**
 * Token paths that indicate a leaf token (has no children).
 * Any object carrying one of these `type` values plus a `value` is treated
 * as an individual design token.
 */
const LEAF_TYPES = new Set([
  "color",
  "dimension",
  "number",
  "string",
  "custom-shadow",
]);

/**
 * Maps each top-level token group to its CSS variable category prefix.
 *
 * "primitive colors" → `color-primitive` and "color roles" → `color-role`
 * makes the two-layer color system explicit in every emitted variable name,
 * so it is impossible to mistake a foundation color for a UI color.
 */
const GROUP_PREFIX = {
  effect: "effect",
  "primitive colors": "color-primitive",
  "color roles": "color-role",
  "spacing collection": "space",
  typography: "typography",
  fontFamilies: "font",
};

/**
 * Section banner shown above each group in the generated CSS.
 */
const SECTION_COMMENTS = {
  "primitive colors":
    "PRIMITIVE COLORS — foundation palette. Consumed by COLOR ROLES only. " +
    "Do not apply these directly to UI elements.",
  "color roles":
    "COLOR ROLES — semantic colors. These are the tokens components should use.",
  effect: "EFFECTS — drop shadows, expanded to standard box-shadow syntax.",
  "spacing collection": "SPACING — dimension tokens, converted to px.",
  typography: "TYPOGRAPHY — text style tokens (parts + ready-to-use font shorthand).",
  fontFamilies: "FONT FAMILIES — quoted font-family stacks.",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Converts a single token-name segment into a lowercase kebab-case
 * CSS identifier.
 *
 * @param {string} input - raw token segment, e.g. "Primary Key Color",
 *                         "fontFamilies" or "primary100".
 * @returns {string} kebab-case identifier, e.g. "primary-key-color".
 */
function toKebabCase(input) {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds the CSS custom-property name for a token from its path segments.
 *
 * @param {string[]} parts - token path, e.g. ["color roles", "primary"].
 * @returns {string} the CSS variable name, e.g. "--color-role-primary".
 */
function cssVarFor(parts) {
  const [group, ...rest] = parts;
  const prefix = GROUP_PREFIX[group] || toKebabCase(group);
  const suffix = rest.map(toKebabCase).join("-");
  return `--${prefix}${suffix ? `-${suffix}` : ""}`;
}

/**
 * Predicate: does this node represent a single leaf token?
 *
 * @param {*} node - any value encountered while walking the tree.
 * @returns {boolean} true if the node is a `{ type, value }` token record.
 */
function isLeaf(node) {
  return (
    node !== null &&
    typeof node === "object" &&
    typeof node.type === "string" &&
    LEAF_TYPES.has(node.type) &&
    "value" in node
  );
}

/**
 * Replaces Tokens Studio reference strings with CSS var() references.
 *
 * A reference such as `{primitive colors.primary color palette.primary100}`
 * uses dots as path separators (spaces are part of the names). It is
 * rewritten to the matching CSS variable so every role stays linked to the
 * primitive(s) it is built from.
 *
 * @param {*} value - raw token value (string for references).
 * @returns {*} the value with all `{...}` references replaced by `var(--x)`.
 */
function resolveReferences(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\{([^}]+)\}/g, (_match, refPath) => {
    return `var(${cssVarFor(refPath.split("."))})`;
  });
}

/**
 * Renders the CSS value for a single leaf token.
 *
 * @param {object} leaf - `{ path, type, value }` token record.
 * @returns {string} the CSS value to place after the colon.
 */
function renderValue(leaf) {
  switch (leaf.type) {
    case "custom-shadow": {
      const s = leaf.value;
      return `${s.offsetX}px ${s.offsetY}px ${s.radius}px ${s.spread}px ${resolveReferences(s.color)}`;
    }
    case "dimension":
      return `${resolveReferences(leaf.value)}px`;
    case "color":
      return resolveReferences(leaf.value);
    case "number":
      return String(resolveReferences(leaf.value));
    case "string": {
      const key = leaf.path[leaf.path.length - 1];
      const isFontFamily = key === "fontFamily" || leaf.path[0] === "fontFamilies";
      return isFontFamily ? `"${leaf.value}"` : leaf.value;
    }
    default:
      return String(leaf.value);
  }
}

/* ------------------------------------------------------------------ */
/*  Typography                                                         */
/* ------------------------------------------------------------------ */

/**
 * CSS property emitted for each typography sub-token, keyed by the token
 * name found in the source file.
 */
const TYPOGRAPHY_FIELDS = {
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  fontFamily: "font-family",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textDecoration: "text-decoration",
  textCase: "text-transform",
};

/**
 * Emits the typography variables for a single text style (e.g. display large).
 *
 * Produces one variable per text property (`--typography-display-large-font-size`,
 * `--typography-display-large-letter-spacing`, ...) plus a condensed
 * `--typography-display-large-font` shorthand so a style can be applied as
 * `font: var(--typography-display-large-font)`.
 *
 * @param {object[]} styleLeaves - the sub-tokens of one text style.
 * @returns {string[]} CSS declaration lines.
 */
function renderTypography(styleLeaves) {
  const props = Object.fromEntries(
    styleLeaves.map((leaf) => [leaf.path[2], leaf])
  );
  const base = cssVarFor(["typography", styleLeaves[0].path[1]]);
  const lines = [];

  for (const [sourceKey, cssProperty] of Object.entries(TYPOGRAPHY_FIELDS)) {
    const token = props[sourceKey];
    if (token) {
      lines.push(`  ${base}-${cssProperty}: ${renderValue(token)};`);
    }
  }

  const size = props.fontSize ? renderValue(props.fontSize) : null;
  const lineHeight = props.lineHeight ? renderValue(props.lineHeight) : null;
  const family = props.fontFamily ? renderValue(props.fontFamily) : null;
  const weight = props.fontWeight ? props.fontWeight.value : 400;
  const style = props.fontStyle && props.fontStyle.value !== "normal"
    ? `${props.fontStyle.value} `
    : "";

  if (size && family) {
    const sizeLine = lineHeight ? `${size}/${lineHeight}` : size;
    lines.push(`  ${base}-font: ${style}${weight} ${sizeLine} ${family};`);
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

/**
 * Walks the token tree and flattens every leaf token into a list of
 * `{ path, type, value }` records, in document order.
 *
 * @param {object} tree - parsed design-tokens.tokens.json.
 * @returns {object[]} every leaf token found.
 */
function collectTokens(tree) {
  const leaves = [];
  (function walk(node, parts) {
    if (isLeaf(node)) {
      leaves.push({ path: parts, type: node.type, value: node.value });
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        walk(child, parts.concat(key));
      }
    }
  })(tree, []);
  return leaves;
}

/**
 * Builds the full CSS file text.
 *
 * @param {object[]} leaves - flattened leaf tokens from collectTokens().
 * @returns {string} the generated CSS document.
 */
function buildCss(leaves) {
  const lines = [":root {"];
  const emittedTypography = new Set();
  let currentGroup = null;

  for (const leaf of leaves) {
    if (leaf.path[0] === "typography") {
      const style = leaf.path[1];
      if (!emittedTypography.has(style)) {
        emittedTypography.add(style);
        const styleLeaves = leaves.filter(
          (l) => l.path[0] === "typography" && l.path[1] === style
        );
        lines.push(...renderTypography(styleLeaves));
      }
      continue;
    }

    if (currentGroup !== leaf.path[0]) {
      currentGroup = leaf.path[0];
      lines.push("");
      lines.push(
        `  /* ${"=".repeat(72)}`,
        `   * ${SECTION_COMMENTS[currentGroup] || currentGroup}`,
        `   * ${"=".repeat(72)}`,
        "   */"
      );
    }
    lines.push(`  ${cssVarFor(leaf.path)}: ${renderValue(leaf)};`);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

const inputPath = process.argv[2] || path.join(__dirname, "design-tokens.tokens.json");
const outputPath = process.argv[3] || path.join(__dirname, "design-tokens.css");

if (!fs.existsSync(inputPath)) {
  console.error(`[convert-tokens] Input file not found: ${inputPath}`);
  process.exit(1);
}

const tree = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const leaves = collectTokens(tree);
const css = buildCss(leaves);

fs.writeFileSync(outputPath, css, "utf8");
console.log(`[convert-tokens] Wrote ${leaves.length} tokens -> ${outputPath}`);