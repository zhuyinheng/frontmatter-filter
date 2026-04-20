import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import wikiLinkPlugin from '@flowershow/remark-wiki-link';
import { visit } from 'unist-util-visit';

export type MarkdownReferenceSyntax =
  | 'wikilink'
  | 'embed'
  | 'link'
  | 'image'
  | 'linkReference'
  | 'imageReference';

export interface MarkdownReference {
  rawTarget: string;
  syntax: MarkdownReferenceSyntax;
}

export interface MarkdownReferenceParseResult {
  references: MarkdownReference[];
  warnings: string[];
}

interface NodeLike {
  type: string;
  identifier?: string;
  url?: string;
  value?: string;
}

export function parseMarkdownReferences(content: string): MarkdownReferenceParseResult {
  const warnings: string[] = [];
  const references: MarkdownReference[] = [];
  const seen = new Set<string>();
  const definitions = new Map<string, string>();

  try {
    const tree = remark()
      .use(remarkFrontmatter, ['yaml'])
      .use(remarkGfm)
      .use(wikiLinkPlugin)
      .parse(content);

    visit(tree, 'definition', (node) => {
      const definition = node as NodeLike;
      if (typeof definition.identifier !== 'string' || typeof definition.url !== 'string') {
        return;
      }

      definitions.set(normalizeDefinitionIdentifier(definition.identifier), definition.url);
    });

    visit(tree, (node) => {
      const candidate = node as NodeLike;

      switch (candidate.type) {
        case 'wikiLink':
          addReference(candidate.value, 'wikilink');
          break;
        case 'embed':
          addReference(candidate.value, 'embed');
          break;
        case 'link':
          addReference(candidate.url, 'link');
          break;
        case 'image':
          addReference(candidate.url, 'image');
          break;
        case 'linkReference':
          addReference(
            definitions.get(normalizeDefinitionIdentifier(candidate.identifier)),
            'linkReference',
          );
          break;
        case 'imageReference':
          addReference(
            definitions.get(normalizeDefinitionIdentifier(candidate.identifier)),
            'imageReference',
          );
          break;
        default:
          break;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to parse markdown references: ${message}`);
  }

  return {
    references,
    warnings,
  };

  function addReference(rawTarget: string | undefined, syntax: MarkdownReferenceSyntax): void {
    if (typeof rawTarget !== 'string') {
      return;
    }

    const normalized = rawTarget.trim();
    if (normalized.length === 0) {
      return;
    }

    const dedupeKey = `${syntax}:${normalized}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);

    references.push({
      rawTarget: normalized,
      syntax,
    });
  }
}

function normalizeDefinitionIdentifier(identifier: string | undefined): string {
  return typeof identifier === 'string' ? identifier.trim().toUpperCase() : '';
}
