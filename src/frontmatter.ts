import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { VFile } from 'vfile';
import { matter } from 'vfile-matter';

import type { FrontmatterParseResult } from './types.ts';

interface MatterData {
  matter?: Record<string, unknown>;
}

export function parseFrontmatter(content: string): FrontmatterParseResult {
  const file = new VFile({ value: content });
  const warnings: string[] = [];
  let hasFrontmatter = false;

  try {
    const tree = remark().use(remarkFrontmatter, ['yaml']).parse(file);
    visit(tree, 'yaml', () => {
      hasFrontmatter = true;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      hasFrontmatter: false,
      warnings: [`Failed to parse markdown frontmatter structure: ${message}`],
    };
  }

  if (!hasFrontmatter) {
    return {
      hasFrontmatter: false,
      warnings,
    };
  }

  try {
    matter(file, { strip: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to parse YAML frontmatter: ${message}`);
  }

  const parsedMatter = (file.data as MatterData).matter;
  const publicValue = typeof parsedMatter?.public === 'boolean' ? parsedMatter.public : undefined;

  return {
    hasFrontmatter: true,
    publicValue,
    warnings,
  };
}
