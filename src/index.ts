import wp = require("webpack");
import fs = require("fs");
import path = require("path");
import util = require('util');
import readline = require('readline');
import _ = require("lodash");
import i18next = require('i18next');
import Backend = require('i18next-node-fs-backend');
import { ReadableStreamBuffer } from 'stream-buffers';
import { SourceMapConsumer } from 'source-map';
const VirtualModulePlugin = require('virtual-module-webpack-plugin');

const readFile = util.promisify(fs.readFile);
const unlink = util.promisify(fs.unlink);
const stat = util.promisify(fs.stat);
const mkdir = util.promisify(fs.mkdir);

async function exists(path: fs.PathLike) {
    try {
        await stat(path);

        return true;
    } catch (e) {
        if (e.code === 'ENOENT') {
            return false;
        }
        throw e;
    }
}

function extractArgs(arg: any, warning?: (node: any) => void) {
    switch (arg.type) {
    case 'Literal':
        return arg.value;
    case 'Identifier':
        return arg.name;
    case 'ObjectExpression':
        const res: {[key: string]: string} = {};
        for (const i in arg.properties) {
            res[extractArgs(arg.properties[i].key)] = extractArgs(arg.properties[i].value);
        }
        return res;
    default:
        if (warning) {
            warning(arg);
        }
        return null;
    }
}

export interface Option {
    defaultLanguage: string;
    /**
     * languages to emit
     */
    languages: string[];
    defaultNamespace?: string;
    namespaces?: string[];
    /**
     * Scanning function name
     *
     * @default "__"
     */
    functionName?: string;
    resourcePath: string;
    /**
     * save missing translations to...
     */
    pathToSaveMissing: string;
    /**
     * change emit path
     * if this value is not set, emit to resourcePath
     */
    outPath?: string;
}

export interface InternalOption extends Option {
    defaultNamespace: string;
    namespaces: string[];
    outPath: string;
}

function getPath(template: string, language?: string, namespace?: string) {
    if (language !== undefined) {
        template = template.replace("{{lng}}", language);
    }
    if (namespace !== undefined) {
        template = template.replace("{{ns}}", namespace);
    }

    return template;
}

export type CollectedKeys = {[language: string]: {[namespace: string]: {[key: string]: {[module: string]: [number, number]}}}};

function removeMap<T>(obj: _.Dictionary<T>, keys: (string | undefined)[]) {
    for (const emptyKey of keys) {
        if (emptyKey !== undefined) {
            delete obj[emptyKey];
        }
    }

    return obj;
}

export default class I18nextPlugin {
    protected compilation: wp.Compilation;
    protected option: InternalOption;
    protected context: string;
    protected missingKeys: CollectedKeys = {};
    protected startTime = Date.now();
    protected prevTimestamps: {[file: string]: number} = {};
    protected sourceMaps: {[key: string]: SourceMapConsumer} = {};
    protected missingDirInitialized = false;

    public constructor(option: Option) {
        this.option = _.defaults(option, {
            functionName: "__",
            defaultNamespace: "translation",
            namespaces: [option.defaultNamespace || "translation"],
            outPath: option.resourcePath
        });

        i18next.use(Backend);
    }

    public apply(compiler: wp.Compiler) {
        // provide config via virtual module plugin
        compiler.apply(new VirtualModulePlugin({
            moduleName: path.join(__dirname, "config.js"),
            contents: `exports = module.exports = {
                __esModule: true,
                RESOURCE_PATH: "${this.option.outPath}",
                LANGUAGES: ${JSON.stringify(this.option.languages)},
                DEFAULT_NAMESPACE: "${this.option.defaultNamespace}"
};`
        }));

        i18next.init({
            preload: this.option.languages,
            ns: this.option.namespaces,
            fallbackLng: false,
            defaultNS: this.option.defaultNamespace,
            saveMissing: true,
            missingKeyHandler: this.onKeyMissing.bind(this),
            backend: {
                loadPath: this.option.resourcePath
            }
        });
        this.context = compiler.options.context || "";
        this.initMissingDir();

        compiler.plugin("compilation", (compilation, data) => {
            // reset for new compliation
            i18next.reloadResources(this.option.languages);
            this.compilation = compilation;
            const changedFiles = _.keys(compilation.fileTimestamps).filter(
                watchfile => (this.prevTimestamps[watchfile] || this.startTime) < (compilation.fileTimestamps[watchfile] || Infinity)
            );

            for (const changed of changedFiles) {
                delete this.sourceMaps[changed];
            }
            removeMap(this.missingKeys, _.map(this.missingKeys, (namespaces, lng) =>
                _.isEmpty(removeMap(namespaces, _.map(namespaces, (values, ns) =>
                    _.isEmpty(removeMap(values, _.map(values, (deps, key) => {
                        for (const changed of changedFiles) {
                            delete deps[changed];
                        }

                        return _.isEmpty(deps) ? key : undefined;
                    }))) ? ns : undefined
                ))) ? lng : undefined
            ));

            data.normalModuleFactory.plugin(
                "parser",
                (parser: any) => {
                    const that = this;
                    parser.plugin(`call ${this.option.functionName}`, function(this: wp.Parser, arg: wp.Expression) {
                        return I18nextPlugin.onTranslateFunctionCall.call(this, that, arg);
                    });
                }
            );
        });
        compiler.plugin("emit", this.onEmit.bind(this));
        compiler.plugin("after-emit", this.onAfterEmit.bind(this));
    }

    protected async initMissingDir() {
        if (this.missingDirInitialized) {
            return;
        }

        const template = path.resolve(this.context, this.option.pathToSaveMissing);
        await Promise.all(this.option.namespaces.map(ns => this.option.languages.map(async lng => {
            const dirPath = path.dirname(getPath(template, lng, ns));
            if (!await exists(dirPath)) {
                await mkdir(dirPath);
            }
        })));
        this.missingDirInitialized = true;
    }

    protected async onEmit(compilation: wp.Compilation, callback: (err?: Error) => void) {
        // emit translation files
        this.prevTimestamps = compilation.fileTimestamps;

        try {
            await Promise.all(_.flatten(_.map(this.option.languages, async lng => {
                const resourceTemplate = path.resolve(this.context, getPath(this.option.resourcePath, lng));
                const resourceDir = path.dirname(resourceTemplate);
                if (!exists(resourceDir)) {
                    compilation.missingDependencies.push(resourceDir);
                    return [];
                }

                return Promise.all(_.map(this.option.namespaces, async ns => {
                    const resourcePath = getPath(resourceTemplate, undefined, ns);
                    const outPath = getPath(this.option.outPath, lng, ns);

                    try {
                        const v = await readFile(resourcePath);
                        compilation.assets[outPath] = {
                            size() { return v.length; },
                            source() { return v; }
                        };

                        compilation.fileDependencies.push(path.resolve(resourcePath));
                    } catch (e) {
                        compilation.missingDependencies.push(resourcePath);
                        compilation.warnings.push(`Can't emit ${outPath}. It looks like ${resourcePath} is not exists.`);
                    }
                }));
            })));

            callback();
        } catch (e) {
            callback(e);
        }
    }

    protected async onAfterEmit(compilation: wp.Compilation, callback: (err?: Error) => void) {
        const remains: _.Dictionary<_.Dictionary<any>> = _.fromPairs(_.map(
            this.option.languages, lng => [
                lng,
                _.fromPairs(_.map(
                    this.option.namespaces, ns => [ns, null]
                ))
            ]
        ));
        try {
            // write missing
            await this.initMissingDir();
            await Promise.all(_.map(this.missingKeys, async (namespaces, lng) => {
                const resourceTemplate = path.resolve(this.context, getPath(this.option.pathToSaveMissing, lng));
                const resourceDir = path.dirname(resourceTemplate);
                try {
                    await mkdir(resourceDir);
                } catch (e) {
                    if (e.code !== 'EEXIST') {
                        throw e;
                    }
                }

                return _.map(namespaces, async (values, ns) => new Promise<void>(resolve => {
                    delete remains[lng][ns];
                    const missingPath = getPath(resourceTemplate, undefined, ns);
                    const stream = fs.createWriteStream(missingPath, {
                        defaultEncoding: "utf-8"
                    });
                    const keys = _.sortedUniq(_.sortBy(_.keys(values)));
                    stream.write("{\n");
                    stream.write(_.map(
                        keys,
                        key => `\t"${key}": [\n${_.map(
                            values[key], (pos, module) => `\t\t"${_.trim(JSON.stringify(path.relative(this.context, module)), '"')}(${pos})"`).join(",\n")
                        }\n\t]`).join(",\n")
                    );
                    stream.end("\n}");
                    stream.on("close", () => resolve());

                    compilation.warnings.push(`missing translation ${_.size(values)} keys in ${lng}/${ns}`);
                }));
            }));
            // remove previous missings
            await Promise.all(_.map(remains, async (namespaces, lng) =>
                _.map(namespaces, async (__, ns) => {
                    const missingPath = path.resolve(this.context, getPath(this.option.pathToSaveMissing, lng, ns));
                    if (await exists(missingPath)) {
                        await unlink(missingPath);
                    }
                })
            ));
            callback();
        } catch (e) {
            callback(e);
        }
    }

    protected static onTranslateFunctionCall(this: wp.Parser, plugin: I18nextPlugin, expr: wp.Expression) {
        const resource = this.state.current.resource;
        if (plugin.sourceMaps[resource] === undefined) {
            plugin.sourceMaps[resource] = new SourceMapConsumer(this.state.current._source._sourceMap);
        }
        const sourceMap = plugin.sourceMaps[resource];
        const args = expr.arguments.map((arg: any) => extractArgs(arg, (arg) => {
            const beginPos = sourceMap.originalPositionFor(arg.loc.start);
            const endPos = sourceMap.originalPositionFor(arg.loc.end);
            if (beginPos.source !== null) {
                const originalSource = sourceMap.sourceContentFor(beginPos.source);
                const sourceLines: string[] = [];
                if (originalSource !== null) {
                    const buffer = new ReadableStreamBuffer();
                    buffer.put(originalSource);
                    let lineIdx = 0;
                    const lineInterface = readline.createInterface(buffer).on("line", (line: string) => {
                        lineIdx++;
                        let beginCol = 0, endCol = line.length;
                        if (lineIdx === beginPos.line) {
                            beginCol = beginPos.column as number;
                        }
                        if (lineIdx === endPos.line) {
                            endCol = endPos.column as number;
                        }
                        if (lineIdx >= (beginPos.line as number) && lineIdx <= (endPos.line as number)) {
                            sourceLines.push(line.substring(beginCol, endCol));
                        }

                        if (lineIdx === endPos.line) {
                            lineInterface.close();
                        }
                    }).on("close", () => {
                        plugin.warningOnCompilation(`unable to parse arg ${sourceLines.join("\n")} at ${resource}:(${beginPos.line}, ${beginPos.column})`);
                    });
                    return;
                }
            }
            plugin.warningOnCompilation(`unable to parse node at ${resource}:(${beginPos.line}, ${beginPos.column})`);
        }));
        const startPos = sourceMap.originalPositionFor(expr.loc.start);
        const pos = [resource, startPos.line, startPos.column];

        for (const lng of plugin.option.languages) {
            const keyOrKeys: string | string[] = args[0];
            const option: i18next.TranslationOptionsBase = Object.assign(_.defaults(args[1], {}), {
                lng,
                defaultValue: pos
            } as i18next.TranslationOptionsBase);
            i18next.t(keyOrKeys, option);
        }
    }

    protected onKeyMissing(lng: string, ns: string, key: string, pos: [string, number, number]) {
        const p = [lng, ns, key, pos[0]];
        let arr: [number, number][] = _.get(this.missingKeys, p);
        if (arr === undefined) {
            _.set(this.missingKeys, p, []);
            arr = _.get(this.missingKeys, p);
        }
        arr.push([pos[1], pos[2]]);
    }

    protected warningOnCompilation(msg: string) {
        if (this.compilation) {
            this.compilation.warnings.push(msg);
        }
    }
}