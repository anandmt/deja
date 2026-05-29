import type { GrammarManager } from "./grammar";

const DECLARATION_KEYWORDS = [
  "function", "method", "class", "struct",
  "interface", "enum", "trait", "type", "module", "impl",
];

const BODY_CONTAINER_KEYWORDS = ["class", "struct", "impl", "module"];

function isDeclaration(nodeType: string): boolean {
  return DECLARATION_KEYWORDS.some((kw) => nodeType.includes(kw));
}

function isBodyContainer(nodeType: string): boolean {
  return BODY_CONTAINER_KEYWORDS.some((kw) => nodeType.includes(kw));
}

function visit(node: any, symbols: string[], depth: number): void {
  if (isDeclaration(node.type)) {
    const name = node.childForFieldName("name");
    if (name) {
      symbols.push(name.text);
    } else {
      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j)!;
        const childName = child.childForFieldName("name");
        if (childName) symbols.push(childName.text);
      }
    }
  }

  if (isBodyContainer(node.type)) {
    const body = node.childForFieldName("body");
    if (body) {
      for (let j = 0; j < body.childCount; j++) {
        visit(body.child(j)!, symbols, depth + 1);
      }
    }
  }

  // Recurse into wrapper nodes (export_statement, decorated_definition, etc.)
  if (!isDeclaration(node.type) && !isBodyContainer(node.type) && depth < 2) {
    for (let j = 0; j < node.childCount; j++) {
      visit(node.child(j)!, symbols, depth + 1);
    }
  }
}

export async function extractAst(
  content: string,
  filePath: string,
  manager: GrammarManager,
): Promise<string[] | null> {
  if (!content || content.length === 0) return null;

  const parser = await manager.getParser(filePath);
  if (!parser) return null;

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return null;
  }
  if (!tree) return null;

  const symbols: string[] = [];
  const root = tree.rootNode;

  for (let i = 0; i < root.childCount; i++) {
    visit(root.child(i)!, symbols, 0);
  }

  return [...new Set(symbols)];
}
