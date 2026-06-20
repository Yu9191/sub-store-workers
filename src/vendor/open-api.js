/** Sub-Store Workers OpenAPI 适配层 */

import { Base64 } from 'js-base64';
import { installConsoleLogCapture } from '@/utils/debug-logs';

// 平台检测
const isQX = false;
const isLoon = false;
const isSurge = false;
const isNode = false;
const isStash = false;
const isShadowRocket = false;
const isEgern = false;
const isLanceX = false;
const isGUIforCores = false;
const isWorker = true;

function isPlainObject(obj) {
    return (
        obj !== null &&
        typeof obj === 'object' &&
        [null, Object.prototype].includes(Object.getPrototypeOf(obj))
    );
}

export class OpenAPI {
    constructor(name = 'untitled', debug = false) {
        this.name = name;
        this.debug = debug;

        this.http = HTTP();
        this.env = ENV();

        this.node = null;

        // 内存缓存
        this.cache = {};
        this.root = {};

        this._kvBinding = null; // set by initFromKV()
        this._dirty = false;
        this._rootDirty = false;
        this._cacheSnapshot = '';
        this._rootSnapshot = '';

        const delay = (t, v) =>
            new Promise(function (resolve) {
                setTimeout(resolve.bind(null, v), t);
            });

        Promise.prototype.delay = async function (t) {
            const v = await this;
            return await delay(t, v);
        };
    }

    /** 从 KV 初始化 */
    async initFromKV(kvBinding) {
        this._kvBinding = kvBinding;
        this._dirty = false;
        this._rootDirty = false;

        // 加载主缓存
        try {
            const raw = await kvBinding.get(this.name, 'text', { cacheTtl: 60 });
            if (raw) {
                this.cache = JSON.parse(raw);
                if (!isPlainObject(this.cache)) {
                    this.cache = {};
                }
                this._cacheSnapshot = raw;
            } else {
                this.cache = {};
                this._cacheSnapshot = '{}';
            }
        } catch (e) {
            this.error(`Failed to load cache from KV: ${e.message}`);
            this.cache = {};
            this._cacheSnapshot = '{}';
        }

        // 加载根数据
        try {
            const raw = await kvBinding.get('root', 'text', { cacheTtl: 60 });
            if (raw) {
                this.root = JSON.parse(raw);
                if (!isPlainObject(this.root)) {
                    this.root = {};
                }
                this._rootSnapshot = raw;
            } else {
                this.root = {};
                this._rootSnapshot = '{}';
            }
        } catch (e) {
            this.error(`Failed to load root from KV: ${e.message}`);
            this.root = {};
        }

        installConsoleLogCapture(this);
    }

    // 同步初始化（空操作）
    initCache() {
        // 由 initFromKV 处理
    }

    // 回写缓存到 KV
    async persistCache() {
        if (!this._kvBinding) return;
        const promises = [];
        if (this._dirty) {
            const current = JSON.stringify(this.cache, null, 2);
            if (current !== this._cacheSnapshot) {
                promises.push(this._kvBinding.put(this.name, current));
                this._cacheSnapshot = current;
            }
            this._dirty = false;
        }
        if (this._rootDirty) {
            const current = JSON.stringify(this.root, null, 2);
            if (current !== this._rootSnapshot) {
                promises.push(this._kvBinding.put('root', current));
                this._rootSnapshot = current;
            }
            this._rootDirty = false;
        }
        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    write(data, key) {
        this.log(`SET ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            this.root[key] = data;
            this._rootDirty = true;
        } else {
            this.cache[key] = data;
            this._dirty = true;
        }
        // 请求结束时回写
    }

    read(key) {
        this.log(`READ ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            return this.root[key];
        } else {
            return this.cache[key];
        }
    }

    delete(key) {
        this.log(`DELETE ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            delete this.root[key];
            this._rootDirty = true;
        } else {
            delete this.cache[key];
            this._dirty = true;
        }
    }

    // 通知：日志 + HTTP URL 推送（支持 Bark、Pushover 等）
    notify(title, subtitle = '', content = '', options = {}) {
        const openURL = options['open-url'];
        const mediaURL = options['media-url'];
        const content_ =
            content +
            (openURL ? `\n点击跳转: ${openURL}` : '') +
            (mediaURL ? `\n多媒体: ${mediaURL}` : '');
        console.log(`[Notify] ${title}\n${subtitle}\n${content_}`);

        const push = this.workerEnv?.SUB_STORE_PUSH_SERVICE;
        if (push && /^https?:\/\//.test(push)) {
            const url = push
                .replace('[推送标题]', encodeURIComponent(title || 'Sub-Store'))
                .replace('[推送内容]', encodeURIComponent([subtitle, content_].filter(Boolean).join('\n')));
            const pushPromise = fetch(url)
                .then((resp) => {
                    console.log(`[Push Service] URL: ${url}\nRES: ${resp.status}`);
                })
                .catch((e) => {
                    console.log(`[Push Service] URL: ${url}\nERROR: ${e}`);
                });
            // 收集到 pendingPushes，由 ctx.waitUntil 保证完成
            if (!this.pendingPushes) this.pendingPushes = [];
            this.pendingPushes.push(pushPromise);
        }
    }

    log(msg) {
        if (this.debug) console.log(`[${this.name}] LOG: ${msg}`);
    }

    info(msg) {
        console.log(`[${this.name}] INFO: ${msg}`);
    }

    warn(msg) {
        console.log(`[${this.name}] WARN: ${msg}`);
    }

    error(msg) {
        console.log(`[${this.name}] ERROR: ${msg}`);
    }

    wait(millisec) {
        return new Promise((resolve) => setTimeout(resolve, millisec));
    }

    done(value = {}) {
        // 空操作
    }
}

export function ENV() {
    return {
        isQX,
        isLoon,
        isSurge,
        isNode,
        isStash,
        isShadowRocket,
        isEgern,
        isLanceX,
        isGUIforCores,
        isWorker,
    };
}

export function HTTP(defaultOptions = { baseURL: '' }) {
    const methods = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'HEAD',
        'OPTIONS',
        'PATCH',
    ];
    const URL_REGEX =
        /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

    function send(method, options) {
        options = typeof options === 'string' ? { url: options } : options;
        const baseURL = defaultOptions.baseURL;
        if (baseURL && !URL_REGEX.test(options.url || '')) {
            options.url = baseURL ? baseURL + options.url : options.url;
        }
        options = { ...defaultOptions, ...options };
        const timeout = options.timeout;
        const events = {
            ...{
                onRequest: () => {},
                onResponse: (resp) => resp,
                onTimeout: () => {},
            },
            ...options.events,
        };

        events.onRequest(method, options);

        // 原生 fetch 请求
        const controller = new AbortController();
        const fetchOptions = {
            method: method.toUpperCase(),
            headers: options.headers || {},
            signal: controller.signal,
        };

        if (
            options.body &&
            !['GET', 'HEAD'].includes(method.toUpperCase())
        ) {
            fetchOptions.body =
                typeof options.body === 'string'
                    ? options.body
                    : JSON.stringify(options.body);
        }

        const worker = fetch(options.url, fetchOptions).then(async (resp) => {
            let body;
            if (options.encoding === null) {
                body = await resp.arrayBuffer();
            } else {
                body = await resp.text();
            }
            // 转换响应头
            const headers = {};
            resp.headers.forEach((value, key) => {
                headers[key] = value;
            });
            return {
                statusCode: resp.status,
                headers,
                body,
            };
        });

        let timeoutid;
        const timer = timeout
            ? new Promise((_, reject) => {
                  timeoutid = setTimeout(() => {
                      controller.abort();
                      events.onTimeout();
                      return reject(
                          `${method} URL: ${options.url} exceeds the timeout ${timeout} ms`,
                      );
                  }, timeout);
              })
            : null;

        return (
            timer
                ? Promise.race([timer, worker]).then((res) => {
                      clearTimeout(timeoutid);
                      return res;
                  })
                : worker
        ).then((resp) => events.onResponse(resp));
    }

    const http = {};
    methods.forEach(
        (method) =>
            (http[method.toLowerCase()] = (options) => send(method, options)),
    );
    return http;
}
