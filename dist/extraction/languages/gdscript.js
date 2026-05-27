"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gdscriptExtractor = void 0;
const tree_sitter_helpers_1 = require("../tree-sitter-helpers");
exports.gdscriptExtractor = {
    // --- 节点类型映射（基于 tree-sitter-gdscript 的 nodeTypeInfo）---
    /** 函数定义（包括普通函数和类方法） */
    functionTypes: ['function_definition'],
    /** 类定义 */
    classTypes: ['class_definition'],
    /** 方法也是 function_definition（在类内部时） */
    methodTypes: ['function_definition'],
    /** GDScript 没有接口 */
    interfaceTypes: [],
    /** GDScript 没有结构体 */
    structTypes: [],
    /** 枚举定义 */
    enumTypes: ['enum_definition'],
    /** 枚举成员（GDScript 中是 enumerator） */
    enumMemberTypes: ['enumerator'],
    /** GDScript 没有类型别名 */
    typeAliasTypes: [],
    /** 导入类型：GDScript 使用 preload/load 和 class_name */
    importTypes: ['extends_statement'],
    /** 函数调用 */
    callTypes: ['call', 'attribute_call'],
    /** 变量声明 */
    variableTypes: [
        'variable_statement',
        'const_statement',
        'onready_variable_statement',
        'export_variable_statement',
    ],
    /** 类属性（类中的变量声明） */
    propertyTypes: [
        'variable_statement',
        'const_statement',
        'onready_variable_statement',
        'export_variable_statement',
    ],
    // --- 字段名映射 ---
    /** 名称字段 */
    nameField: 'name',
    /** 函数/类体字段 */
    bodyField: 'body',
    /** 参数字段 */
    paramsField: 'parameters',
    /** 返回类型字段（GDScript 4 支持 -> Type） */
    returnField: 'return_type',
    // --- 钩子函数 ---
    /**
     * 提取函数签名
     * 例如：func my_func(param1: int, param2: String) -> void:
     */
    getSignature: (node, source) => {
        const params = (0, tree_sitter_helpers_1.getChildByField)(node, 'parameters');
        const returnType = (0, tree_sitter_helpers_1.getChildByField)(node, 'return_type');
        if (!params)
            return undefined;
        let sig = (0, tree_sitter_helpers_1.getNodeText)(params, source);
        if (returnType) {
            sig += ' -> ' + (0, tree_sitter_helpers_1.getNodeText)(returnType, source);
        }
        return sig;
    },
    /**
     * 检查是否是异步函数
     * GDScript 没有真正的 async，但可能有 @coroutine 注解
     */
    isAsync: (node) => {
        const prev = node.previousNamedSibling;
        if (prev?.type === 'annotation') {
            const text = prev.text;
            return text.includes('@coroutine') || text.includes('@async');
        }
        return false;
    },
    /**
     * 检查是否是静态函数
     * GDScript 使用 static 关键字
     */
    isStatic: (node) => {
        const prev = node.previousSibling;
        return prev?.type === 'static';
    },
    /**
     * 检查变量是否是常量
     */
    isConst: (node) => {
        return node.type === 'const_statement';
    },
    /**
     * 提取导入信息
     * 处理 extends 和 class_name 语句
     */
    extractImport: (node, source) => {
        if (node.type === 'extends_statement') {
            const importText = source.substring(node.startIndex, node.endIndex).trim();
            // extends Node2D 或 extends "res://path/to/script.gd"
            const className = importText.replace(/^extends\s+/, '').replace(/"/g, '');
            return {
                moduleName: className,
                signature: importText,
            };
        }
        return null;
    },
    /**
     * 提取变量声明信息
     * 处理 GDScript 特有的变量声明模式
     */
    extractVariables: (node, source) => {
        const variables = [];
        if (node.type === 'variable_statement' ||
            node.type === 'const_statement' ||
            node.type === 'onready_variable_statement' ||
            node.type === 'export_variable_statement') {
            const nameNode = (0, tree_sitter_helpers_1.getChildByField)(node, 'name');
            if (nameNode) {
                const name = nameNode.text;
                const isConst = node.type === 'const_statement';
                // 提取类型信息（如果有）
                const typeNode = (0, tree_sitter_helpers_1.getChildByField)(node, 'type');
                let signature = name;
                if (typeNode) {
                    signature += ': ' + (0, tree_sitter_helpers_1.getNodeText)(typeNode, source);
                }
                variables.push({
                    name,
                    kind: isConst ? 'constant' : 'variable',
                    signature,
                    positionNode: nameNode,
                });
            }
        }
        return variables;
    },
    /**
     * 解析类名（处理 class_name 语句）
     * GDScript 可以用 class_name 语句声明类名，而不是在 class_definition 中
     */
    resolveName: (node, _source) => {
        if (node.type === 'class_name_statement') {
            const nameNode = (0, tree_sitter_helpers_1.getChildByField)(node, 'name');
            return nameNode?.text;
        }
        return undefined;
    },
    /**
     * 提取可见性
     * GDScript 使用下划线前缀约定表示私有
     */
    getVisibility: (node) => {
        const nameNode = (0, tree_sitter_helpers_1.getChildByField)(node, 'name');
        if (nameNode) {
            const name = nameNode.text;
            // 以 _ 开头的变量/函数默认视为私有
            if (name.startsWith('_')) {
                return 'private';
            }
        }
        return 'public';
    },
    /**
     * 方法可以在顶层（GDScript 允许顶层函数）
     */
    methodsAreTopLevel: true,
    /**
     * 自定义节点访问器
     * 处理 GDScript 特有的节点类型
     */
    visitNode: (node, ctx) => {
        // 处理 signal_statement（信号声明）
        if (node.type === 'signal_statement') {
            const nameNode = (0, tree_sitter_helpers_1.getChildByField)(node, 'name');
            if (nameNode) {
                ctx.createNode('function', nameNode.text, node, {
                // 信号可以看作特殊的函数
                });
                return true; // 已处理
            }
        }
        // 处理 class_name_statement（类名声明）
        if (node.type === 'class_name_statement') {
            const nameNode = (0, tree_sitter_helpers_1.getChildByField)(node, 'name');
            if (nameNode) {
                ctx.createNode('class', nameNode.text, node);
                return true;
            }
        }
        return false; // 未处理，使用默认逻辑
    },
};
//# sourceMappingURL=gdscript.js.map