import { Result, Schema, SchemaIssue } from 'effect';

import { HarnessConfigSchema } from './src/Core/Shared/Domain/HarnessConfig.ts';

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type EstreeNode = {
  type: string;
  expression?: EstreeNode;
  argument?: EstreeNode;
  operator?: string;
  prefix?: boolean;
  value?: EstreeNode | string | number | boolean | bigint | null;
  properties?: readonly EstreeNode[];
  elements?: ReadonlyArray<EstreeNode | null>;
  key?: EstreeNode;
  computed?: boolean;
  name?: string;
};

const isEstreeNode = (value: EstreeNode['value']): value is EstreeNode =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';

const unwrap = (node: EstreeNode | null | undefined): EstreeNode | undefined => {
  let current = node ?? undefined;
  while (
    current !== undefined &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression;
  }
  return current;
};

const propertyName = (property: EstreeNode): string | undefined => {
  if (property.type !== 'Property' || property.computed === true) {
    return undefined;
  }
  const key = property.key;
  if (key === undefined) {
    return undefined;
  }
  if (key.type === 'Identifier') {
    return key.name;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }
  return undefined;
};

const objectProperty = (objectExpression: EstreeNode, name: string): EstreeNode | undefined =>
  objectExpression.properties?.find((property) => property.type === 'Property' && propertyName(property) === name);

const extract = (node: EstreeNode | null | undefined): { readonly value: unknown } | undefined => {
  const current = unwrap(node);
  if (current === undefined) {
    return undefined;
  }
  if (current.type === 'Literal') {
    return { value: current.value };
  }
  if (
    current.type === 'UnaryExpression' &&
    current.prefix === true &&
    current.operator === '-' &&
    current.argument !== undefined
  ) {
    const argument = extract(current.argument);
    return argument !== undefined && typeof argument.value === 'number' ? { value: -argument.value } : undefined;
  }
  if (current.type === 'ArrayExpression') {
    const elements: unknown[] = [];
    for (const element of current.elements ?? []) {
      const item = extract(element);
      if (item === undefined) {
        return undefined;
      }
      elements.push(item.value);
    }
    return { value: elements };
  }
  if (current.type === 'ObjectExpression') {
    const record: Record<string, unknown> = {};
    for (const property of current.properties ?? []) {
      const name = propertyName(property);
      if (name === undefined) {
        return undefined;
      }
      const item = extract(isEstreeNode(property.value) ? property.value : undefined);
      if (item === undefined) {
        return undefined;
      }
      record[name] = item.value;
    }
    return { value: record };
  }
  return undefined;
};

const pathKey = (segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey =>
  typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment;

const nodeAtPath = (root: EstreeNode, path: readonly (PropertyKey | { readonly key: PropertyKey })[]): EstreeNode => {
  let current = root;
  for (const segment of path.map(pathKey)) {
    const next = unwrap(current);
    if (next === undefined) {
      return root;
    }
    if (typeof segment === 'number') {
      if (next.type !== 'ArrayExpression' || next.elements === undefined) {
        return next;
      }
      const element = next.elements[segment];
      if (element === null || element === undefined) {
        return next;
      }
      current = element;
      continue;
    }
    if (next.type !== 'ObjectExpression') {
      return next;
    }
    const property = objectProperty(next, String(segment));
    if (property === undefined) {
      return next;
    }
    current = isEstreeNode(property.value) ? property.value : next;
  }
  return unwrap(current) ?? root;
};

export const consistentAgentPriorities = {
  meta: {
    type: 'problem',
    docs: {
      description: 'harnessFileConfig must satisfy HarnessConfigSchema',
    },
  },
  create(context: { report(descriptor: { node: EstreeNode; message: string }): void }) {
    return {
      VariableDeclarator(node: { id: EstreeNode; init?: EstreeNode }) {
        if (node.id.type !== 'Identifier' || node.id.name !== 'harnessFileConfig') {
          return;
        }

        const init = unwrap(node.init);
        if (init?.type !== 'ObjectExpression') {
          return;
        }

        const extracted = extract(init);
        if (extracted === undefined) {
          return;
        }

        const decoded = Schema.decodeUnknownResult(HarnessConfigSchema)(extracted.value);
        if (Result.isSuccess(decoded)) {
          return;
        }

        for (const issue of formatIssues(decoded.failure.issue).issues) {
          context.report({
            node: nodeAtPath(init, issue.path ?? []),
            message: issue.message,
          });
        }
      },
    };
  },
};

export default {
  meta: { name: 'harness' },
  rules: {
    'consistent-agent-priorities': consistentAgentPriorities,
  },
};
