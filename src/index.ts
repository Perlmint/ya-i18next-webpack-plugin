import wp = require("webpack");
import fs = require("fs");
import path = require("path");
import util = require('util');
import readline = require('readline');
import _ = require("lodash");
import i18next = require('i18next');
import Backend = require('i18next-node-fs-backend');
import { ReadableStreamBuffer } from 'stream-buffers';
import { SourceMapConsumer, Position, MappedPosition, NullableMappedPosition, NullablePosition } from 'source-map';
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

export interface Value {
    key: string;
    line: number;
    column: number;
}
export interface Literal {
    type: "literal";
    value: Value
}
export interface Identifier {
    type: "identifier";
    name: string;
}
export interface Or {
    type: "or";
    value: Arg[];
}
export interface And {
    type: "and";
    value: Arg[];
}
export interface Empty {
    type: "empty";
}
export type Arg = Literal | Identifier | Or | And | Empty;

function extractArgs(arg: any, warning?: (node: any) => void): Arg {
    switch (arg.type) {
    case 'Literal':
        return { type: "literal", value: {
            key: arg.value,
            line: arg.loc.start.line,
            column: arg.loc.start.column
         } };
    case 'Identifier':
        return { type: "identifier", name: arg.name };
    case 'ObjectExpression':
        return { type: "empty" };
    case 'ConditionalExpression':
        return {
            type: "and",
            value: [
                extractArgs(arg.consequent, warning),
                extractArgs(arg.alternate, warning)
            ]
        };
    case 'ArrayExpression':
        return {
            type: "or",
            value: _.map(arg.elements, element => extractArgs(element, warning))
        };
    case 'BinaryExpression':
        const operator = arg.operator as string;
        const left = extractArgs(arg.left, warning);
        const right = extractArgs(arg.right, warning);

        if (operator !== "+" || left.type !== "literal" || right.type !== "literal") {
            if (warning) {
                warning(arg);
            }

            return { type: "empty" };
        }

        return {
            type: "literal",
            value: {
                key: left.value.key + right.value.key,
                line: left.value.line,
                column: left.value.column
            }
        };
    default:
        if (warning) {
            warning(arg);
        }
        return { type: "empty" };
    }
}

class DummySourceMapConsumer implements SourceMapConsumer {
    public file: string;
    public sourceRoot: string;
    public sources: string[];
    public sourcesContent: string[];
    public constructor(module: wp.Module) {
        this.file = module.resource;
        this.sourceRoot = module.resource;
        this.sources = [this.file];
        this.sourcesContent = [module._source._value];
    }

    computeColumnSpans() {}
    originalPositionFor(generatedPosition: Position & { bias?: number }): NullableMappedPosition {
        return _.assign({
            source: this.file,
            name: ""
        }, generatedPosition);
    }
    generatedPositionFor(originalPosition: MappedPosition & { bias?: number }): NullablePosition {
        return _.assign({
            lastColumn: originalPosition.column
        }, originalPosition);
    }
    allGeneratedPositionsFor(originalPosition: MappedPosition): NullablePosition[] {
        return [this.generatedPositionFor(originalPosition)];
    }
    hasContentsOfAllSources() { return true; }
    sourceContentFor(source: string, returnNullOnMissing?: boolean): string {
        const index = this.sources.indexOf(source);
        if (index === -1) {
            if (returnNullOnMissing) {
                return "";
            } else {
                throw new Error("never");
            }
        }
        return this.sourcesContent[index];
    }
    eachMapping(): void {}
    destroy(): void {}
}

export interface Option {
    defaultLanguage: string;
    /**
     * languages to emit
     */
    languages: string[];
    defaultNamespace?: string;
    namespaceSeparator?: string;
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
    protected compilation!: wp.Compilation;
    protected option: InternalOption;
    protected context!: string;
    protected missingKeys: CollectedKeys = {};
    protected startTime = Date.now();
    protected prevTimestamps: {[file: string]: number} = {};
    protected sourceMaps: {[key: string]: SourceMapConsumer} = {};
    protected missingDirInitialized = false;

    public constructor(option: Option) {
        this.option = _.defaults(option, {
            functionName: "__",
            defaultNamespace: "translation",
            namespaceSeparator: ":",
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
    DEFAULT_NAMESPACE: "${this.option.defaultNamespace}",
    NS_SEPARATOR: "${this.option.namespaceSeparator}",
};`
        }));

        i18next.init({
            preload: this.option.languages,
            ns: this.option.namespaces,
            fallbackLng: false,
            defaultNS: this.option.defaultNamespace,
            saveMissing: true,
            parseMissingKeyHandler: this.onKeyMissing.bind(this),
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
                if (!await exists(resourceDir)) {
                    compilation.missingDependencies.push(resourceDir);
                    return [];
                }

                return Promise.all(_.map(this.option.namespaces, async ns => {
                    const resourcePath = getPath(resourceTemplate, undefined, ns);
                    const outPath = getPath(this.outPath, lng, ns);

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

    protected get outPath() {
        if (path.isAbsolute(this.option.outPath)) {
            return path.relative(this.context, this.option.outPath);
        }
        return this.option.outPath;
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

                return await Promise.all(_.map(namespaces, (values, ns) => new Promise<void>(resolve => {
                    delete remains[lng][ns];
                    const missingPath = getPath(resourceTemplate, undefined, ns);
                    const stream = fs.createWriteStream(missingPath, {
                        encoding: "utf-8"
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
                })));
            }));
            // remove previous missings
            await Promise.all(_.map(remains, (namespaces, lng) =>
                Promise.all(_.map(namespaces, async (__, ns) => {
                    const missingPath = path.resolve(this.context, getPath(this.option.pathToSaveMissing, lng, ns));
                    if (await exists(missingPath)) {
                        await unlink(missingPath);
                    }
                }))
            ));
            callback();
        } catch (e) {
            callback(e);
        }
    }

    protected argsToSource(sourceMap: SourceMapConsumer, arg: wp.Expression): Promise<string | null> {
        const beginPos = sourceMap.originalPositionFor(arg.loc.start);
        const endPos = sourceMap.originalPositionFor(arg.loc.end);
        if (beginPos.source !== null) {
            const originalSource = sourceMap.sourceContentFor(beginPos.source);
            const sourceLines: string[] = [];
            if (originalSource !== null) {
                const buffer = new ReadableStreamBuffer();
                buffer.put(originalSource);
                buffer.put("\n");
                let lineIdx = 0;
                return new Promise<string>(resolve => {
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
                        resolve(sourceLines.join("\n"));
                    });
                });
            }
        }
        return Promise.resolve(null);
    }

    protected static async onTranslateFunctionCall(this: wp.Parser, plugin: I18nextPlugin, expr: wp.Expression) {
        const resource = this.state.current.resource;
        if (plugin.sourceMaps[resource] === undefined && this.state.current._source._sourceMap !== undefined) {
            plugin.sourceMaps[resource] = await new SourceMapConsumer(this.state.current._source._sourceMap);
        } else {
            plugin.sourceMaps[resource] = new DummySourceMapConsumer(this.state.current);
        }
        const sourceMap = plugin.sourceMaps[resource];
        const arg = extractArgs(expr.arguments[0], arg => plugin.argsToSource(sourceMap, arg).then(originalSource => {
            const beginPos = sourceMap.originalPositionFor(arg.loc.start);
            if (originalSource !== null) {
                plugin.warningOnCompilation(`unable to parse arg ${originalSource} at ${resource}:(${beginPos.line}, ${beginPos.column})`);
            } else {
                plugin.warningOnCompilation(`unable to parse node at ${resource}:(${beginPos.line}, ${beginPos.column})`);
            }
        }));

        for (const lng of plugin.option.languages) {
            for (const failed of plugin.testArg(arg, lng,)) {
                const [ns, k] = plugin.separateNamespace(failed.key);
                const startPos = sourceMap !== undefined ? sourceMap.originalPositionFor(failed) : failed;
                plugin.addToMissingKey(lng, ns, k, [resource, startPos.line!, startPos.column!]);
            }
        }
    }

    protected separateNamespace(key: string) {
        const ret = key.split(this.option.namespaceSeparator!, 2);
        if (ret.length === 1) {
            ret.unshift(this.option.defaultNamespace);
        }

        return ret;
    }

    protected testArg(arg: Arg, lng: string) {
        let faileds: Value[] = [];
        switch (arg.type) {
            case "empty":
                break;
            case "and":
                for (const key of arg.value) {
                    faileds.push(...this.testArg(key, lng));
                }
                break;
            case "or":
                for (const key of arg.value) {
                    const result = this.testArg(key, lng);
                    if (result.length === 0) {
                        return [];
                    } else {
                        faileds.push(...result);
                    }
                }
                break;
            case "literal":
                if (i18next.t(arg.value.key, { lng }) === false) {
                    faileds.push(arg.value);
                }
                break;
        }
        return faileds;
    }

    protected addToMissingKey(lng: string, ns: string, key: string, pos: [string, number, number]) {
        const p = [lng, ns, key, pos[0]];
        let arr: [number, number][] = _.get(this.missingKeys, p);
        if (arr === undefined) {
            _.set(this.missingKeys, p, []);
            arr = _.get(this.missingKeys, p);
        }
        arr.push([pos[1], pos[2]]);
    }

    protected onKeyMissing() {
        return false;
    }

    protected warningOnCompilation(msg: string) {
        if (this.compilation) {
            this.compilation.warnings.push(msg);
        }
    }
}
