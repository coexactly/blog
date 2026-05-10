#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const blogDir = join(repoRoot, "src/content/blog");
const assetsDir = join(repoRoot, "src/assets");

function parseArgs(argv) {
  const options = {
    published: true,
    tags: [],
    force: false,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const readValue = () => inlineValue ?? argv[++i];

    switch (key) {
      case "title":
        options.title = readValue();
        break;
      case "description":
        options.description = readValue();
        break;
      case "date":
        options.pubDate = readValue();
        break;
      case "slug":
        options.slug = readValue();
        break;
      case "tags":
        options.tags = readValue()
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        break;
      case "hero-image":
        options.heroImage = readValue();
        break;
      case "hide-hero":
        options.hideHero = readValue() !== "false";
        break;
      case "draft":
        options.published = false;
        break;
      case "published":
        options.published = readValue() !== "false";
        break;
      case "force":
        options.force = true;
        break;
      case "help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  if (positionals.length !== 1) {
    printHelp();
    process.exit(1);
  }

  return { inputPath: positionals[0], options };
}

function printHelp() {
  console.log(`Usage: node scripts/format-post.mjs <draft.md> [options]

Options:
  --title <title>            Frontmatter title. Defaults to the file name.
  --description <text>       Frontmatter description. Defaults to first paragraph.
  --date <date>              Publication date. Defaults to today.
  --slug <slug>              Output slug. Defaults to slugified title.
  --tags <a,b,c>             Comma-separated tags.
  --hero-image <path>        Hero image path, e.g. ../../assets/example.png.
  --hide-hero [false]        Hide the hero image on the post page.
  --draft                    Set published: false.
  --published false          Set published: false.
  --force                    Overwrite an existing output file.
`);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleFromFilename(path) {
  return basename(path).replace(/\.[^.]+$/, "");
}

function firstParagraph(markdown) {
  const withoutCallouts = markdown.replace(/^>\s?\[![^\]]+\][+-]?\s*$[\s\S]*?(?=\n\S|\n*$)/gm, "");
  const paragraph = withoutCallouts
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .find((paragraph) => paragraph && !paragraph.startsWith("#"));

  if (!paragraph || paragraph.length <= 180) return paragraph;
  return `${paragraph.slice(0, 177).replace(/\s+\S*$/, "")}...`;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function frontmatter(options) {
  const tags = `[${options.tags.map((tag) => yamlString(tag)).join(", ")}]`;
  const lines = [
    "---",
    `title: ${yamlString(options.title)}`,
    `description: ${yamlString(options.description)}`,
    `pubDate: ${yamlString(options.pubDate)}`,
    `published: ${options.published}`,
    `tags: ${tags}`,
  ];

  if (options.heroImage) lines.push(`heroImage: ${yamlString(options.heroImage)}`);
  if (options.hideHero !== undefined) lines.push(`hideHero: ${options.hideHero}`);

  lines.push(`---`);
  return `${lines.join("\n")}

`;
}

function convertObsidianCallouts(markdown) {
  const lines = markdown.split("\n");
  const output = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^>\s?\[!([^\]]+)\]([+-])?\s*$/);
    if (!match) {
      output.push(lines[i]);
      continue;
    }

    const title = match[1].trim();
    const marker = match[2];
    const open = marker === "+" ? " open" : "";
    const body = [];

    while (i + 1 < lines.length && lines[i + 1].startsWith(">")) {
      i += 1;
      body.push(lines[i].replace(/^>\s?/, ""));
    }

    output.push(`<details className="callout"${open}>`);
    output.push(`<summary>${escapeHtml(title)}</summary>`);
    output.push("");
    output.push(...body);
    output.push("");
    output.push("</details>");
  }

  return output.join("\n");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function convertObsidianImages(markdown, warnings) {
  return markdown.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, imageName, altText) => {
    const trimmedName = imageName.trim();
    const assetPath = join(assetsDir, trimmedName);
    if (!existsSync(assetPath)) {
      warnings.push(
        `Missing image asset: ${trimmedName}. Add it to src/assets/ or update the generated image path.`
      );
      return `<span className="missing-embed">[Missing image: ${escapeHtml(trimmedName)}]</span>`;
    }

    const alt = (altText ?? trimmedName.replace(/\.[^.]+$/, "")).trim();
    const src = `../../assets/${trimmedName.replace(/ /g, "%20")}`;
    return `![${alt}](${src})`;
  });
}

function escapeTexForMdx(tex) {
  let escaped = "";
  for (const char of tex) {
    if (char === "\\") escaped += "\\\\";
    else if (char === "{") escaped += "\\{";
    else if (char === "}") escaped += "\\}";
    else if (char === "_") escaped += "\\_";
    else if (char === "<") escaped += "\\<";
    else escaped += char;
  }
  return escaped;
}

function escapeMath(markdown) {
  let output = "";
  let i = 0;

  while (i < markdown.length) {
    if (markdown[i] !== "$" || isEscaped(markdown, i)) {
      output += markdown[i];
      i += 1;
      continue;
    }

    const delimiter = markdown[i + 1] === "$" ? "$$" : "$";
    const start = i + delimiter.length;
    const end = findMathEnd(markdown, start, delimiter);

    if (end === -1) {
      output += markdown[i];
      i += 1;
      continue;
    }

    output += delimiter;
    output += escapeTexForMdx(markdown.slice(start, end));
    output += delimiter;
    i = end + delimiter.length;
  }

  return output;
}

function findMathEnd(markdown, start, delimiter) {
  for (let i = start; i < markdown.length; i += 1) {
    if (
      markdown.startsWith(delimiter, i) &&
      !isEscaped(markdown, i) &&
      (delimiter === "$$" || markdown[i + 1] !== "$")
    ) {
      return i;
    }
  }
  return -1;
}

function isEscaped(value, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function main() {
  const { inputPath, options } = parseArgs(process.argv.slice(2));
  const absoluteInputPath = join(process.cwd(), inputPath);
  const draft = readFileSync(absoluteInputPath, "utf8").replace(/\r\n/g, "\n");
  const title = options.title ?? titleFromFilename(inputPath);
  const pubDate = options.pubDate ?? new Date().toISOString().slice(0, 10);
  const description = options.description ?? firstParagraph(draft) ?? title;
  const slug = options.slug ?? slugify(title);
  const outputPath = join(blogDir, `${slug}.mdx`);
  const warnings = [];

  if (existsSync(outputPath) && !options.force) {
    throw new Error(`${relative(repoRoot, outputPath)} already exists. Pass --force to overwrite it.`);
  }

  const body = escapeMath(convertObsidianImages(convertObsidianCallouts(draft), warnings));
  writeFileSync(
    outputPath,
    frontmatter({ ...options, title, description, pubDate }) + body.trim() + "\n"
  );

  console.log(`Wrote ${relative(repoRoot, outputPath)}`);
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

main();
