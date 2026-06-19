/**
 * QuickJS WASM 脚本执行引擎
 *
 * 在 Cloudflare Workers 中以沙箱方式执行用户 JavaScript 脚本，
 * 替代 Node.js 环境下使用 new Function() / eval() 的方案。
 *
 * 依赖：
 *   - quickjs-emscripten (RELEASE_SYNC 变体)
 *   - Wrangler 原生 WASM module import
 *
 * Cloudflare Workers 禁止运行时 WebAssembly.compile(bytes)，
 * 因此必须让 Wrangler 把 .wasm 作为 WebAssembly.Module 上传。
 *
 * 上游执行模式（来自 Sub-Store processors/index.js）：
 *   1. func 模式：createDynamicFunction 返回函数 → fn(proxies, targetPlatform, context)
 *      用户脚本定义 function filter(proxies, ...) 返回 boolean[]
 *   2. nodeFunc 模式（回退）：将用户脚本包装为快捷脚本遍历
 *      const fn = async ($server) => { <script> }
 *      for await (let $server of proxies) { list.push(await fn($server)) }
 *      用户脚本直接操作 $server（单个节点），不需要 function 包裹
 *
 * QuickJS 复刻策略：
 *   1. 将上游的函数参数注入为沙箱全局变量
 *   2. 用 IIFE 包裹脚本返回目标函数（func 模式）
 *   3. 若 func 模式失败且含 "$server is not defined"，回退 nodeFunc 模式
 */

import quickjsWasmModule from './quickjs.wasm';

// 使用全局作用域缓存，避免跨请求重复编译 WASM
if (typeof globalThis.__quickjsModule === 'undefined') {
    globalThis.__quickjsModule = null;
}
if (typeof globalThis.__quickjsRuntime === 'undefined') {
    globalThis.__quickjsRuntime = null;
}
if (typeof globalThis.__quickjsContext === 'undefined') {
    globalThis.__quickjsContext = null;
}

/**
 * 从 QuickJS 错误 handle 中提取可读的错误消息
 *
 * context.dump(errorHandle) 会对 QuickJS Error 对象调用 JSON.stringify，
 * 但 Error 对象的 name/message 属性通常是不可枚举的，
 * 导致 dump 返回 {} 或类空对象，再经字符串拼接变成 "[object Object]"。
 *
 * 正确做法：读取 errorHandle.message 属性并转为 JS 字符串。
 *
 * @param {object} context - QuickJSContext 实例
 * @param {object} errorHandle - QuickJS error handle
 * @returns {string} 错误消息文本
 */
function getErrorMessage(context, errorHandle) {
    try {
        var msgHandle = context.getProp(errorHandle, 'message');
        var msg = context.getString(msgHandle);
        msgHandle.dispose();
        if (msg) return msg;
    } catch (e) {
        // getProp/getString 可能失败（非标准 Error 对象），回退到 dump
    }
    try {
        var dumped = context.dump(errorHandle);
        if (typeof dumped === 'string') return dumped;
        if (dumped && typeof dumped === 'object' && dumped.message) return String(dumped.message);
        return String(dumped);
    } catch (e2) {
        return 'Unknown QuickJS error';
    }
}

/**
 * 懒初始化 QuickJS
 */
async function initQuickJS() {
    if (globalThis.__quickjsContext) return {
        context: globalThis.__quickjsContext,
        runtime: globalThis.__quickjsRuntime,
        QuickJS: globalThis.__quickjsModule,
    };

    const {
        newQuickJSWASMModule,
        newVariant,
        RELEASE_SYNC,
    } = require('quickjs-emscripten');

    // 正确模式：传入 Wrangler 预编译好的 WebAssembly.Module
    const adaptVariant = newVariant(RELEASE_SYNC, {
        wasmModule: quickjsWasmModule,
    });

    const QuickJS = await newQuickJSWASMModule(adaptVariant);
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(1024 * 512);       // 512KB 内存限制
    runtime.setMaxStackSize(1024 * 256);      // 256KB 栈限制
    // 每 5000 条指令中断检查，防止死循环
    var __interruptCounter = 0;
    runtime.setInterruptHandler(function () {
        __interruptCounter++;
        if (__interruptCounter >= 5000) {
            __interruptCounter = 0;
            return true;
        }
        return false;
    });

    const context = runtime.newContext();

    globalThis.__quickjsModule = QuickJS;
    globalThis.__quickjsRuntime = runtime;
    globalThis.__quickjsContext = context;

    return { context, runtime, QuickJS };
}

/**
 * 创建新的隔离 context（用于不可信的脚本）
 */
async function newSandboxContext() {
    const { runtime, QuickJS } = await initQuickJS();
    const context = runtime.newContext();
    return { context, runtime, QuickJS };
}

/**
 * 向沙箱注入 API 全局变量和基础工具
 *
 * @param {object} context - QuickJSContext
 * @param {object} api - 要注入的键值对
 */
function injectAPI(context, api) {
    var apiKeys = Object.keys(api);
    for (var i = 0; i < apiKeys.length; i++) {
        var key = apiKeys[i];
        var value = api[key];
        if (value === undefined) continue;

        var jsonValue = JSON.stringify(value);
        var setResult = context.evalCode(
            'var ' + key + ' = JSON.parse(' + JSON.stringify(jsonValue) + ');'
        );
        if (setResult.error) {
            var errMsg = getErrorMessage(context, setResult.error);
            setResult.error.dispose();
            throw new Error('Failed to inject API ' + key + ': ' + errMsg);
        }
        if (setResult.value) {
            setResult.value.dispose();
        }
    }

    // 注入基础工具（模拟上游环境中的工具函数）
    var baseResult = context.evalCode(
        'var b64d = function(s) { return atob(s); };\n' +
        'var b64e = function(s) { return btoa(s); };\n' +
        'var console = { log: function(){}, warn: function(){}, error: function(){} };\n' +
        'var Buffer = { from: function(s) { return s; } };'
    );
    if (baseResult.error) {
        var errMsg2 = getErrorMessage(context, baseResult.error);
        baseResult.error.dispose();
        throw new Error('Failed to inject base API: ' + errMsg2);
    }
    if (baseResult.value) {
        baseResult.value.dispose();
    }
}

/**
 * 在 QuickJS 沙箱中执行脚本，返回函数句柄
 *
 * 复刻上游 createDynamicFunction 的 IIFE 包裹行为：
 *   body = `${script}\n return ${name}`
 *   → (function(){ <script>; return <name>; })()
 *
 * 注意：不释放 context，由调用方负责清理。
 *
 * @param {string} script - 用户脚本
 * @param {string} name - 要返回的函数名（如 'filter'、'operator'）
 * @param {object} api - 注入到沙箱的 API 对象
 * @returns {{context, fnHandle, runtime, QuickJS}}
 */
async function executeInSandbox(script, name, api) {
    api = api || {};
    var result = await newSandboxContext();
    var context = result.context;
    var runtime = result.runtime;
    var QuickJS = result.QuickJS;

    try {
        injectAPI(context, api);

        // 复刻上游 new Function() 行为：
        //   body = `${script}\n return ${name}`
        //
        // 用 IIFE 包裹：先执行 script（定义函数），再返回名为 name 的函数
        // 添加分号确保 script 语句结束，避免 ASI 陷阱
        var wrappedScript = '(function(){\n' + script + ';\nreturn ' + name + ';\n})()';
        var evalResult = context.evalCode(wrappedScript);

        if (evalResult.error) {
            var errMsg = getErrorMessage(context, evalResult.error);
            evalResult.error.dispose();
            throw new Error('Script evaluation failed: ' + errMsg);
        }

        var fnHandle = evalResult.value;
        var fnType = context.typeof(fnHandle);

        if (fnType !== 'function') {
            var actualValue = context.dump(fnHandle);
            fnHandle.dispose();
            context.dispose();
            throw new Error(
                '\'' + name + '\' is not a function (got ' + fnType +
                (actualValue !== undefined ? ': ' + JSON.stringify(actualValue).slice(0, 200) : '') + ')'
            );
        }

        return { context: context, runtime: runtime, fnHandle: fnHandle, QuickJS: QuickJS };
    } catch (e) {
        context.dispose();
        throw e;
    }
}

/**
 * 清理所有 QuickJS 资源（Durable Object 销毁时调用）
 */
function cleanup() {
    var ctx = globalThis.__quickjsContext;
    if (ctx) {
        try { ctx.dispose(); } catch (e) { /* ignore */ }
        globalThis.__quickjsContext = null;
    }
    var rt = globalThis.__quickjsRuntime;
    if (rt) {
        try { rt.dispose(); } catch (e) { /* ignore */ }
        globalThis.__quickjsRuntime = null;
    }
    globalThis.__quickjsModule = null;
}

/**
 * 在沙箱中调用函数并返回宿主环境结果
 *
 * 处理同步/异步返回值：async function 返回 Promise，需跑完 pending jobs。
 *
 * @param {object} context - QuickJSContext
 * @param {object} runtime - QuickJSRuntime
 * @param {object} fnHandle - 要调用的函数句柄
 * @param {Array} callArgs - QuickJS 值参数数组
 * @returns {*} 宿主环境结果
 */
async function callSandboxFunction(context, runtime, fnHandle, callArgs) {
    var callResult = context.callFunction(fnHandle, context.null, callArgs);

    // 释放输入参数
    for (var k = 0; k < callArgs.length; k++) {
        if (callArgs[k] !== context.null) {
            try { callArgs[k].dispose(); } catch (e) { /* ignore */ }
        }
    }

    if (callResult.error) {
        var callErrMsg = getErrorMessage(context, callResult.error);
        callResult.error.dispose();
        throw new Error('Script execution failed: ' + callErrMsg);
    }

    // async function 会返回 Promise，需要跑完 QuickJS 的 pending jobs
    var finalValue = callResult.value;
    if (context.typeof(finalValue) === 'object') {
        var resolvedPromise = context.resolvePromise(finalValue);
        runtime.executePendingJobs();
        var resolvedResult = await resolvedPromise;
        if (resolvedResult.error) {
            var asyncErrMsg = getErrorMessage(context, resolvedResult.error);
            resolvedResult.error.dispose();
            finalValue.dispose();
            throw new Error('Script async execution failed: ' + asyncErrMsg);
        }
        finalValue.dispose();
        finalValue = resolvedResult.value;
    }

    // 将结果序列化回 host 环境
    var resultStr = context.dump(finalValue);
    finalValue.dispose();

    if (resultStr === undefined || resultStr === 'undefined') {
        return undefined;
    }

    try {
        return JSON.parse(resultStr);
    } catch (e) {
        return resultStr;
    }
}

/**
 * 将宿主环境参数序列化为 QuickJS 值
 *
 * @param {object} context - QuickJSContext
 * @param {Array} args - 宿主环境参数
 * @returns {Array} QuickJS 值数组
 */
function serializeArgs(context, args) {
    var callArgs = [];
    for (var j = 0; j < args.length; j++) {
        if (args[j] === undefined || args[j] === null) {
            callArgs.push(context.null);
        } else {
            var jsonStr = JSON.stringify(args[j]);
            var argResult = context.evalCode(
                'JSON.parse(' + JSON.stringify(jsonStr) + ')'
            );
            if (argResult.error) {
                var argErrMsg = getErrorMessage(context, argResult.error);
                argResult.error.dispose();
                throw new Error('Failed to serialize argument ' + j + ': ' + argErrMsg);
            }
            callArgs.push(argResult.value);
        }
    }
    return callArgs;
}

/**
 * Script Operator / Script Filter 执行器
 *
 * 替代 createDynamicFunction 的 new Function() 方案。
 * 返回的 async function 与上游签名单测兼容：
 *   function(proxies, targetPlatform, context, ...extraArgs)
 *
 * 执行策略（复刻上游 ApplyFilter / ApplyOperator）：
 *   1. 先尝试 func 模式：IIFE 包裹脚本 → fn(proxies, targetPlatform, context)
 *      用户脚本应定义 function filter(proxies, ...) 返回 boolean[]
 *   2. 若 func 模式失败且错误含 "$server is not defined"，
 *      回退 nodeFunc 模式：将用户脚本包装为快捷脚本遍历
 *      每个 $server 是单个 proxy 节点
 *
 * @param {string} script - 用户脚本
 * @param {string} name - 函数名（'filter' / 'operator' / 'transformFunction'）
 * @param {object} $arguments - 用户参数
 * @param {object} $options - 扩展选项
 * @returns {function} async function
 */
function createScriptFunction(script, name, $arguments, $options) {
    return async function () {
        var args = arguments;
        var api = {
            $arguments: $arguments || {},
            $options: $options || {},
        };

        // 上游调用约定: fn(proxies, targetPlatform, context, ...extraArgs)
        // extraArgs 依次对应: $substore, lodash, ...
        var extraNames = [
            '$substore', 'lodash', '$persistentStore', '$httpClient',
            '$notification', 'ProxyUtils', 'yaml', 'Buffer', 'b64d', 'b64e',
            'DOMAIN_RESOLVERS', 'scriptResourceCache', 'flowUtils', 'produceArtifact', 'require',
        ];
        for (var i = 0; i < extraNames.length; i++) {
            var extraIndex = i + 3; // 跳过 proxies, targetPlatform, context
            if (extraIndex < args.length && args[extraIndex] !== undefined) {
                api[extraNames[i]] = args[extraIndex];
            }
        }

        // ========== func 模式（仅支持函数式脚本） ==========
        // 用户脚本必须定义 function filter(proxies, targetPlatform, context)
        // 返回的函数通过 IIFE 包裹后调用：fn(proxies, targetPlatform, context)
        // 上游 nodeFunc 模式不做过滤回退（nodeFunc 仅用于修改节点），
        // 脚本过滤只支持函数式写法。
        try {
            var sandbox = await executeInSandbox(script, name, api);
            var context = sandbox.context;
            var runtime = sandbox.runtime;
            var fnHandle = sandbox.fnHandle;

            try {
                var callArgs = serializeArgs(context, args);
                var result = await callSandboxFunction(context, runtime, fnHandle, callArgs);
                return result;
            } finally {
                try { fnHandle.dispose(); } catch (e) { /* ignore */ }
                try { context.dispose(); } catch (e) { /* ignore */ }
            }
        } catch (err) {
            var errMsg = (err && err.message) ? err.message : String(err);
            throw new Error('脚本执行失败：' + errMsg);
        }
    };
}

module.exports = {
    createScriptFunction: createScriptFunction,
    executeInSandbox: executeInSandbox,
    cleanup: cleanup,
    getErrorMessage: getErrorMessage,
};
