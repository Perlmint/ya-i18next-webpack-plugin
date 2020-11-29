import wp, { Compilation } from "webpack";
import fs, { existsSync, readFileSync } from "fs";
import path from "path";
import util from 'util';
import _ from "lodash";
import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import { SourceMapConsumer, Position, MappedPosition, NullableMappedPosition, NullablePosition } from 'source-map';
import VirtualModulePlugin from 'webpack-virtual-modules';
import estree from 'estree';

const unlink = util.promisify(fs.unlink);
const stat = util.promisify(fs.stat);
const mkdir = util.promisify(fs.mkdir);

// expose webpack internal types
namespace wp_internal {
    export type WebpackError = typeof wp.Compilation.prototype.warnings[0];
    export type SourcePosition = Extract<WebpackError['loc'], { start: Object }>['start'];
}

interface CompilationExt {
    fileTimestamps?: {[key: string]: number};
}

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

function extractArgs(arg: estree.Expression, warning: (node: estree.Expression, reason: string) => void): Arg {
    switch (arg.type) {
    case 'Literal':
        if (typeof arg.value != 'string') {
            warning(arg, 'Non string literal');

            return { type: "empty" };
        } else {
            return { type: "literal", value: {
                key: arg.value as any,
                line: arg.loc!.start.line,
                column: arg.loc!.start.column
            } };
        }
    case 'Identifier':
        return { type: "identifier", name: arg.name };
    case 'ObjectExpression':
    case 'MemberExpression':
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
            value: _.map(arg.elements, element => extractArgs(element as any, warning))
        };
    case 'BinaryExpression':
        const operator = arg.operator as string;
        const left = extractArgs(arg.left, warning);
        const right = extractArgs(arg.right, warning);

        if (operator !== "+" || left.type !== "literal" || right.type !== "literal") {
            warning(arg, 'This binary expression could not be evaluated as literal');

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
    case 'TemplateLiteral':
        const values = arg.expressions.map(v => [extractArgs(v, warning), v]);
        let hasNonLiteralExpr = false;
        for (const [expr, arg] of values) {
            if (expr.type != 'literal') {
                warning(arg as estree.Expression, 'This is non literal value in template literal');
                hasNonLiteralExpr = true;
            }
        }

        if (hasNonLiteralExpr) {
            // Can't evaluate
            return {
                type: 'empty',
            };
        }

        const literals = values.map(([expr]) => expr as Literal);
        literals.push(...arg.quasis.map(v => ({
            type: 'literal',
            value: {
                key: v.value.cooked,
                line: 0,
                column: v.loc!.start.column,
            },
        } as Literal)));

        literals.sort((a, b) => a.value.column - b.value.column);

        return {
            type: 'literal',
            value: {
                key: literals.map(v => v.value.key).join(''),
                ...arg.loc!.start,
            }
        }
    default:
        warning(arg, `Unknown type(${arg.type}) of argument`);
        return { type: "empty" };
    }
}

class DummySourceMapConsumer implements SourceMapConsumer {
    public file: string;
    public sourceRoot: string;
    public sources: string[];
    public sourcesContent: string[];
    public constructor(module: wp.NormalModule) {
        this.file = module.resource;
        this.sourceRoot = module.resource;
        this.sources = [this.file];
        this.sourcesContent = [/*module.source().buffer().buffer*/];
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
     * Path to save used but missing in translations.
     * 
     * Set undefined to disable
     */
    pathToSaveMissing?: string;
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

function removeMap<T>(obj: Record<string, T>, keys: (string | undefined)[]) {
    for (const emptyKey of keys) {
        if (emptyKey !== undefined) {
            delete obj[emptyKey];
        }
    }

    return obj;
}

class PluginWarning<D> extends Error implements wp_internal.WebpackError {
    loc: {
        start: wp_internal.SourcePosition;
        end?: wp_internal.SourcePosition;
    };
    hideStack = false;
    file: string;
    chunk!: wp.Chunk;

    constructor(public module: wp.NormalModule, message: string, [startPos, endPos]: [MappedPosition, MappedPosition?], public details: D) {
        super(message);

        this.file = module.resource;
        this.loc = {
            start: {
                line: startPos.line,
                column: startPos.column,
            },
            end: endPos ? {
                line: endPos.line,
                column: endPos.column,
            } : undefined,
        };
    }

    serialize(__0: { write: any }): void {

    }
	deserialize(__0: { read: any }): void {

    }
}

class MissingTranslationWarning extends PluginWarning<{
    language: string;
    namespace?: string;
    key: string;
}> {
    constructor(module: wp.NormalModule, pos: [MappedPosition, MappedPosition?], language: string, key: string, namespace?: string) {
        super(module, `missing translation "${key}" in ${language}/${namespace}`, pos, {
            language,
            namespace,
            key,
        });

        this.name = 'MissingTranslationWarning';
    }
}

class ParsingFailureWarning extends PluginWarning<{
    reason: string,
}> {

    constructor(module: wp.NormalModule, reason: string, pos: [MappedPosition, MappedPosition?]) {
        super(module, `unable to parse translaction key: ${reason}`, pos, {
            reason,
        });

        this.name = 'ParsingFailureWarning';
    }
}

export default class I18nextPlugin {
    protected compilation!: Compilation;
    protected option: InternalOption;
    protected context!: string;
    protected startTime = Date.now();
    protected prevTimestamps: {[file: string]: number} = {};
    protected sourceMaps: {[key: string]: SourceMapConsumer} = {};

    static TAP_NAME: Readonly<string> = 'YaI18nextWebpackPlugin';

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
        const virtualModulePlugin = new VirtualModulePlugin();
        virtualModulePlugin.apply(compiler);

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

        compiler.hooks.compilation.tap(I18nextPlugin.TAP_NAME, (compilation: Compilation & CompilationExt, data) => {
            // provide config via virtual module plugin
            virtualModulePlugin.writeModule(
                path.join(__dirname, "config.js"),
                `exports = module.exports = {
    __esModule: true,
    RESOURCE_PATH: "${this.option.outPath}",
    LANGUAGES: ${JSON.stringify(this.option.languages)},
    DEFAULT_NAMESPACE: "${this.option.defaultNamespace}",
    NS_SEPARATOR: "${this.option.namespaceSeparator}",
};`
            );

            // reset for new compliation
            i18next.reloadResources(this.option.languages);
            this.compilation = compilation;
            const changedFiles = _.keys(compilation.fileTimestamps).filter(
                watchfile => (this.prevTimestamps[watchfile] || this.startTime) < (compilation.fileTimestamps![watchfile] || Infinity)
            );

            for (const changed of changedFiles) {
                delete this.sourceMaps[changed];
            }
            const missingKeys: CollectedKeys = {}
            removeMap(missingKeys, _.map(missingKeys, (namespaces, lng) =>
                _.isEmpty(removeMap(namespaces, _.map(namespaces, (values, ns) =>
                    _.isEmpty(removeMap(values, _.map(values, (deps, key) => {
                        for (const changed of changedFiles) {
                            delete deps[changed];
                        }

                        return _.isEmpty(deps) ? key : undefined;
                    }))) ? ns : undefined
                ))) ? lng : undefined
            ));

            this.addTranslations(compilation);

            data.normalModuleFactory.hooks.parser.for('javascript/auto').tap(I18nextPlugin.TAP_NAME, (parser: wp.javascript.JavascriptParser) => {
                const that = this;
                parser.hooks.call.for(this.option.functionName).tap(I18nextPlugin.TAP_NAME, (expr) => {
                    if (expr.type != 'CallExpression') {
                        return;
                    }
                    I18nextPlugin.onTranslateFunctionCall.call(parser, that, expr, missingKeys);
                });
            });

            if (this.option.pathToSaveMissing != null) {
                compilation.hooks.processAssets.tapPromise(I18nextPlugin.TAP_NAME, async () => this.writeMissingKeys(compilation, missingKeys));
            }
        });
    }

    /**
     * Add translations as asset
     * @param compilation 
     */
    protected addTranslations(compilation: wp.Compilation) {
        for (const lng of this.option.languages) {
            const resourceTemplate = path.resolve(this.context!, getPath(this.option.resourcePath, lng));
            const resourceDir = path.dirname(resourceTemplate);

            if (!existsSync(resourceDir)) {
                compilation.missingDependencies.add(resourceDir);
                continue;
            }

            for (const ns of this.option.namespaces) {
                const resourcePath = getPath(resourceTemplate, undefined, ns);
                const outPath = getPath(this.outPath, lng, ns);

                try {
                    const source = readFileSync(resourcePath);
                    compilation.emitAsset(outPath, new wp.sources.RawSource(source, false));
    
                    compilation.fileDependencies.add(path.resolve(resourcePath));
                } catch (e) {
                    compilation.missingDependencies.add(resourcePath);
                    compilation.warnings.push(new Error(`Can't emit ${outPath}. It looks like ${resourcePath} is not exists.`) as any);
                }
            }
        }
    }

    protected makeRelative(targetPath: string) {
        return path.relative(this.context, targetPath);
    }

    protected get outPath() {
        if (path.isAbsolute(this.option.outPath)) {
            return this.makeRelative(this.option.outPath);
        }
        return this.option.outPath;
    }

    protected async writeMissingKeys(_compilation: wp.Compilation, missingKeys: CollectedKeys) {
        const pathToSaveMissing = this.option.pathToSaveMissing!;
        const context = this.context!;

        const remains: Record<string, Record<string, any>> = _.fromPairs(_.map(
            this.option.languages, lng => [
                lng,
                _.fromPairs(_.map(
                    this.option.namespaces, ns => [ns, null]
                ))
            ]
        ));

        // write missing
        await Promise.all(_.map(missingKeys, async (namespaces, lng) => {
            const resourceTemplate = path.resolve(context, getPath(pathToSaveMissing, lng));
            const resourceDir = path.dirname(resourceTemplate);

            if (_.isEmpty(namespaces)) {
                return;
            }

            if (_.reduce(namespaces, (acc, values) => acc && _.isEmpty(values), true)) {
                return;
            }

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
                fs.writeFileSync(path.join(resourceDir, 'debug'), missingPath, { encoding: 'utf-8' });
                const stream = fs.createWriteStream(missingPath, {
                    encoding: "utf-8"
                });
                const keys = _.sortedUniq(_.sortBy(_.keys(values)));
                stream.write("{\n");
                stream.write(_.map(
                    keys,
                    key => `\t"${key}": [\n${_.map(
                        values[key], (pos, module) => `\t\t"${_.trim(JSON.stringify(this.makeRelative(module)), '"')}(${pos})"`).join(",\n")
                    }\n\t]`).join(",\n")
                );
                stream.end("\n}");
                stream.on("close", () => resolve());
            })));
        }));
        // remove previous missings
        await Promise.all(_.map(remains, (namespaces, lng) =>
            Promise.all(_.map(namespaces, async (__, ns) => {
                const missingPath = path.resolve(context, getPath(pathToSaveMissing, lng, ns));
                if (await exists(missingPath)) {
                    await unlink(missingPath);
                }
            }))
        ));
    }

    protected argsToSource(sourceMap: SourceMapConsumer, arg: estree.Expression): string | null {
        const beginPos = sourceMap.originalPositionFor(arg.loc!.start);
        const endPos = sourceMap.originalPositionFor(arg.loc!.end);
        if (beginPos.source === null) {
            return null;
        }
        const originalSource = sourceMap.sourceContentFor(beginPos.source);
        const sourceLines: string[] = [];
        if (originalSource == null) {
            return null;
        }
        
        let last_pos = 0;
        let line_end = 0;
        let lineIdx = 0;
        while (true) {
            line_end = originalSource.indexOf("\n", last_pos);
            lineIdx++;
            let beginCol = 0, endCol = line_end - last_pos;
            if (lineIdx === beginPos.line) {
                beginCol = beginPos.column as number;
            }
            if (lineIdx === endPos.line) {
                endCol = endPos.column as number;
            }
            if (lineIdx >= (beginPos.line as number) && lineIdx <= (endPos.line as number)) {
                sourceLines.push(originalSource.substring(last_pos + beginCol, last_pos + endCol));
            }

            if (lineIdx === endPos.line || line_end === -1) {
                break;
            }
        }

        return sourceLines.join("\n");
    }

    protected static async onTranslateFunctionCall(this: wp.javascript.JavascriptParser, plugin: I18nextPlugin, expr: estree.CallExpression, missingKeys: CollectedKeys) {
        const module = this.state.current;
        const resource = module.resource;
        if (plugin.sourceMaps[resource] === undefined && (module as any)._source._sourceMap !== undefined) {
            plugin.sourceMaps[resource] = await new SourceMapConsumer((module as any)._source._sourceMap);
        } else {
            plugin.sourceMaps[resource] = new DummySourceMapConsumer(module);
        }
        const sourceMap = plugin.sourceMaps[resource];
        const arg = extractArgs(expr.arguments[0] as any, (arg, reason) => {
            const beginPos = sourceMap.originalPositionFor(arg.loc!.start);
            const endPos = sourceMap.originalPositionFor(arg.loc!.end);
            module.addWarning(new ParsingFailureWarning(module, reason, [beginPos, endPos] as any) as any);
        });

        for (const lng of plugin.option.languages) {
            for (const failed of plugin.testArg(arg, lng)) {
                const [ns, k] = plugin.separateNamespace(failed.key);
                const startPos = sourceMap.originalPositionFor(failed);
                I18nextPlugin.addToMissingKey(missingKeys, lng, ns, k, [resource, startPos.line, startPos.column]);
                module.addWarning(new MissingTranslationWarning(module, [startPos, null] as any, lng, k, ns) as any);
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
                if (i18next.exists(arg.value.key, { lng }) === false) {
                    faileds.push(arg.value);
                }
                break;
        }
        return faileds;
    }

    protected static addToMissingKey(missingKeys: CollectedKeys, lng: string, ns: string, key: string, [filename, line, column]: [string, number | null, number | null]) {
        const p = [lng, ns, key, filename];
        let arr: [number, number][] = _.get(missingKeys, p);
        if (arr === undefined) {
            _.set(missingKeys, p, []);
            arr = _.get(missingKeys, p);
        }
        arr.push([line!, column!]);
    }

    protected onKeyMissing() {
        return false;
    }
}
