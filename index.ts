import wp = require("webpack");
import fs = require("fs");
import path = require("path");
import util = require('util');
import _ = require("lodash");
import i18next = require('i18next');
import Backend = require('i18next-node-fs-backend');
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

function extractArgs(arg: any, warning?: (msg: string) => void) {
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
            warning(`unable to parse arg ${arg}`);
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

export default class I18nextPlugin {
    protected compilation: wp.Compilation;
    protected option: InternalOption;
    protected context: string;
    protected missingKeys: {[language: string]: {[namespace: string]: string[]}};

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

        compiler.plugin("compilation", (compilation, data) => {
            // reset for new compliation
            this.missingKeys = {};

            i18next.reloadResources(this.option.languages);
            this.compilation = compilation;
            data.normalModuleFactory.plugin(
                "parser",
                (parser: any) => {
                    parser.plugin(`call ${this.option.functionName}`, this.onTranslateFunctionCall.bind(this));
                }
            );
        });
        compiler.plugin("emit", this.onEmit.bind(this));
        compiler.plugin("after-emit", this.onAfterEmit.bind(this));
    }

    protected async onEmit(compilation: wp.Compilation, callback: (err?: Error) => void) {
        // emit translation files
        try {
            await Promise.all(_.map(this.option.languages, lng => {
                const resourceTemplate = path.join(this.context, getPath(this.option.resourcePath, lng));
                const resourceDir = path.dirname(resourceTemplate);
                if (!exists(resourceDir)) {
                    compilation.missingDependencies.push(resourceDir);
                }

                return _.map(this.option.namespaces, async ns => {
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
                });
            }));

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
            await Promise.all(_.map(this.missingKeys, async (namespaces, lng) => {
                const resourceTemplate = path.join(this.context, getPath(this.option.pathToSaveMissing, lng));
                const resourceDir = path.dirname(resourceTemplate);
                try {
                    await mkdir(resourceDir);
                } catch (e) {
                    if (e.code !== 'EEXIST') {
                        throw e;
                    }
                }

                return _.map(namespaces, async (keys, ns) => new Promise<void>(resolve => {
                    delete remains[lng][ns];
                    const missingPath = getPath(resourceTemplate, undefined, ns);
                    const stream = fs.createWriteStream(missingPath, {
                        defaultEncoding: "utf-8"
                    });
                    keys = _.sortedUniq(_.sortBy(keys));
                    stream.write("{\n");
                    stream.write(_.map(keys, key => `\t"${key}": "${key}"`).join(",\n"));
                    stream.write("\n}");

                    stream.on("close", () => resolve());

                    compilation.warnings.push(`missing translation ${keys.length} keys in ${lng}/${ns}`);
                }));
            }));
            // remove previous missings
            await Promise.all(_.map(remains, async (namespaces, lng) =>
                _.map(namespaces, async (__, ns) => {
                    const missingPath = path.join(this.context, getPath(this.option.pathToSaveMissing, lng, ns));
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

    protected onTranslateFunctionCall(expr: any) {
        const args = expr.arguments.map((arg: any) => extractArgs(arg, this.warningOnCompilation.bind(this)));

        for (const lng of this.option.languages) {
            const keyOrKeys: string | string[] = args[0];
            const option: i18next.TranslationOptionsBase = Object.assign(_.defaults(args[1], {}), {
                lng,
                defaultValue: null
            });
            i18next.t(keyOrKeys, option);
        }
    }

    protected onKeyMissing(lng: string, ns: string, key: string, __: string) {
        const p = [lng, ns];
        let arr: string[] = _.get(this.missingKeys, p);
        if (arr === undefined) {
            _.set(this.missingKeys, p, []);
            arr = _.get(this.missingKeys, p);
        }
        arr.push(key);
    }

    protected warningOnCompilation(msg: string) {
        if (this.compilation) {
            this.compilation.warnings.push(msg);
        }
    }
}