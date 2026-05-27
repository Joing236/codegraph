"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.objcExtractor = void 0;
const tree_sitter_helpers_1 = require("../tree-sitter-helpers");
function findCompoundStatement(node) {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'compound_statement') {
            return child;
        }
    }
    return null;
}
/** Build ObjC selector: `greet`, `doThing:`, or `doThing:with:`. */
function extractObjcMethodName(node, source) {
    if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
        return undefined;
    }
    const identifiers = node.namedChildren.filter((c) => c.type === 'identifier');
    if (identifiers.length === 0)
        return undefined;
    const hasParameters = node.namedChildren.some((c) => c.type === 'method_parameter');
    const firstIdentifier = identifiers[0];
    if (!firstIdentifier)
        return undefined;
    if (!hasParameters) {
        return (0, tree_sitter_helpers_1.getNodeText)(firstIdentifier, source);
    }
    return identifiers.map((id) => `${(0, tree_sitter_helpers_1.getNodeText)(id, source)}:`).join('');
}
function extractObjcPropertyName(node, source) {
    if (node.type !== 'property_declaration')
        return null;
    const structDecl = node.namedChildren.find((c) => c.type === 'struct_declaration');
    if (!structDecl)
        return null;
    const structDeclarator = structDecl.namedChildren.find((c) => c.type === 'struct_declarator');
    if (!structDeclarator)
        return null;
    let current = structDeclarator;
    while (current) {
        const inner = (0, tree_sitter_helpers_1.getChildByField)(current, 'declarator') ||
            current.namedChildren.find((c) => c.type === 'identifier' || c.type === 'pointer_declarator');
        if (!inner)
            break;
        if (inner.type === 'identifier') {
            return (0, tree_sitter_helpers_1.getNodeText)(inner, source);
        }
        current = inner;
    }
    return null;
}
exports.objcExtractor = {
    functionTypes: ['function_definition'],
    // Only @interface emits a class node; @implementation reuses it via visitNode.
    classTypes: ['class_interface'],
    methodTypes: ['method_definition'],
    interfaceTypes: ['protocol_declaration'],
    interfaceKind: 'protocol',
    structTypes: ['struct_specifier'],
    enumTypes: ['enum_specifier'],
    enumMemberTypes: ['enumerator'],
    typeAliasTypes: ['type_definition'],
    importTypes: ['preproc_include'],
    callTypes: ['call_expression', 'message_expression'],
    variableTypes: ['declaration'],
    propertyTypes: ['property_declaration'],
    nameField: 'declarator',
    bodyField: 'body',
    paramsField: 'parameters',
    resolveName: extractObjcMethodName,
    extractPropertyName: extractObjcPropertyName,
    resolveBody: (node, bodyField) => {
        const fromField = (0, tree_sitter_helpers_1.getChildByField)(node, bodyField);
        if (fromField) {
            return fromField;
        }
        return findCompoundStatement(node);
    },
    resolveTypeAliasKind: (node, _source) => {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (!child)
                continue;
            if (child.type === 'enum_specifier' && (0, tree_sitter_helpers_1.getChildByField)(child, 'body'))
                return 'enum';
            if (child.type === 'struct_specifier' && (0, tree_sitter_helpers_1.getChildByField)(child, 'body'))
                return 'struct';
        }
        return undefined;
    },
    isStatic: (node) => /^\s*\+/.test(node.text),
    visitNode: (node, ctx) => {
        if (node.type !== 'class_implementation')
            return false;
        const classNameNode = node.namedChildren.find((c) => c.type === 'identifier');
        if (!classNameNode)
            return true;
        const className = (0, tree_sitter_helpers_1.getNodeText)(classNameNode, ctx.source);
        const classNode = ctx.nodes.find((n) => n.name === className && n.filePath === ctx.filePath && n.kind === 'class') ?? ctx.createNode('class', className, node, {});
        if (!classNode)
            return true;
        ctx.pushScope(classNode.id);
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child?.type === 'implementation_definition') {
                for (let j = 0; j < child.namedChildCount; j++) {
                    const implChild = child.namedChild(j);
                    if (implChild)
                        ctx.visitNode(implChild);
                }
            }
        }
        ctx.popScope();
        return true;
    },
    extractImport: (node, source) => {
        const importText = source.substring(node.startIndex, node.endIndex).trim();
        const systemLib = node.namedChildren.find((c) => c.type === 'system_lib_string');
        if (systemLib) {
            return { moduleName: (0, tree_sitter_helpers_1.getNodeText)(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
        }
        const stringLiteral = node.namedChildren.find((c) => c.type === 'string_literal');
        if (stringLiteral) {
            const stringContent = stringLiteral.namedChildren.find((c) => c.type === 'string_content');
            if (stringContent) {
                return { moduleName: (0, tree_sitter_helpers_1.getNodeText)(stringContent, source), signature: importText };
            }
        }
        return null;
    },
};
//# sourceMappingURL=objc.js.map