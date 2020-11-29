import 'source-map-support/register';
import { dir } from 'tmp';
import { readFile as readFileAsync, PathLike, stat as statAsync } from 'fs';
import { promisify } from 'util';
import { join } from 'path';
import 'mocha';
import webpack from 'webpack';
import { assert } from 'chai';
import _ from 'lodash';
import Plugin from '../src/index';

const tmpdir = (name: string) => new Promise<[string, () => void]>((resolve, reject) => dir({
    prefix: 'YaI18nextWebpackPlugin-',
    postfix: `-${name}`,
}, (err, path, cleanup) => {
    if (err != null) {
        return reject(err);
    }
    resolve([path, cleanup]);
}));
const readFile = promisify(readFileAsync);
const readJSONFile = (path: string) => readFile(path, {
    encoding: "utf-8"
}).then(d => JSON.parse(d));
const stat = promisify(statAsync);

async function exists(path: PathLike) {
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

async function initplugin(this: Mocha.Context, functionName: string, transltationPath: string, languages: string[], namespaces?: string[]) {
    const [path, cleanup] = await tmpdir(this.test!.fullTitle());
    return {
        plugin: new Plugin({
            defaultLanguage: languages[0],
            languages,
            defaultNamespace: namespaces === undefined ? undefined : namespaces[0],
            namespaces,
            functionName,
            resourcePath: join(__dirname, transltationPath, "{{lng}}", "{{ns}}.json"),
            pathToSaveMissing: join(path, "{{lng}}-missing", "{{ns}}.json")
        }),
        path,
        cleanup
    };
}

function parsePos(posStr: string) {
    const matched = posStr.match(/^(.+)\((\d+),(\d+\))/);
    if (matched === null) {
        throw new Error("invalid position string");
    }
    return {
        resource: matched[1].replace("\\", "/"),
        line: parseInt(matched[2], 10),
        column: parseInt(matched[3], 10)
    };
}

async function runWebpack(this: Mocha.Context, config: webpack.Configuration) {
    const [path] = await tmpdir(this.test!.fullTitle());
    return new Promise<webpack.Stats>((resolve, reject) => {
        config.mode = 'development';
        config.output = {
            path,
        };
        config.devtool = 'source-map';
        console.log(`work_dir: ${path}`);
        webpack(config, (err, stats) => {
            if (err !== null) {
                return reject(err);
            } else {
                resolve(stats!);
            }
        })
    });
}

function stringify_errors(errors: typeof webpack.Compilation.prototype.warnings): string {
    return errors.map((warn) => `${warn.name} (${warn.file}): ${warn.message}`).join('\n');
}

describe('basic operation', function () {
    it('exists all', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "simple.js"),
            plugins: [plugin]
        });

        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        if (stats.hasWarnings()) {
            assert.fail(undefined, undefined, `There is no not translated messages. It should be having no warnings. - ${stringify_errors(stats.compilation.getWarnings())}`);
        }
        const missingPath = join(path, "en", "translation.json");
        assert.isFalse(await exists(missingPath), "missing key is not existed, file will not be generated");
    });

    it('not found', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["kr"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "simple.js"),
            plugins: [plugin]
        });
        
        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        const missingPath = join(path, "kr-missing", "translation.json");
        const missings = await readJSONFile(missingPath);
        assert.equal(_.size(missings), 1, "Only one missing text here.");
        assert.isNotNull(missings["translated key"]);
        const pos = parsePos(missings["translated key"][0]);
        assert.deepEqual(pos, { resource: "basic/simple.js", line: 3, column: 9 });
        if (!stats.hasWarnings()) {
            assert.fail(undefined, undefined, `not translated messages should occur warning`);
        }
    });

    it('complicated', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "complicated.js"),
            plugins: [plugin]
        });
        
        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        const missingPath = join(path, "en-missing", "translation.json");
        assert.isFalse(await exists(missingPath), "missing key is not existed, file will not be generated");
        if (!stats.hasWarnings()) {
            assert.fail(undefined, undefined, `not translated messages should occur warning`);
        }
        console.log(stringify_errors(stats.compilation.getWarnings()));
    });

    it('ternary', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "ternary.js"),
            plugins: [plugin]
        });
        
        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        const missingPath = join(path, "en-missing", "translation.json");
        const missings = await readJSONFile(missingPath);
        assert.equal(_.size(missings), 1, "Only one missing text here.");
        assert.isNotNull(missings["another key"]);
        if (!stats.hasWarnings()) {
            assert.fail(undefined, undefined, `not translated messages should occur warning`);
        }
    });

    it('namespaces', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "namespaces.js"),
            plugins: [plugin]
        });
        
        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        const missingPath = join(path, "en-missing", "other_ns.json");
        const missings = await readJSONFile(missingPath);
        assert.equal(_.size(missings), 1, "Only one missing text here.");
        assert.isNotNull(missings["translated key"]);
        const defaultNSMissingPath = join(path, "en", "translation.json");
        assert.isFalse(await exists(defaultNSMissingPath), "missing key is not existed, file will not be generated");
        if (!stats.hasWarnings()) {
            assert.fail(undefined, undefined, `not translated messages should occur warning`);
        }
    });

    it('string_concat', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "string_concat.js"),
            plugins: [plugin]
        });
        
        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        const missingPath = join(path, "en-missing", "translation.json");
        const missings = await readJSONFile(missingPath);
        assert.equal(_.size(missings), 1, "Only one missing text here.");
        assert.isNotNull(missings["another key"]);
        if (!stats.hasWarnings()) {
            assert.fail(undefined, undefined, `not translated messages should occur warning`);
        }
    });

    it('candidates', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "candidates.js"),
            plugins: [plugin]
        });
        
        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        if (stats.hasWarnings()) {
            assert.fail(undefined, undefined, `There is no not translated messages. It should be having no warnings. - ${stringify_errors(stats.compilation.getWarnings())}`);
        }
        const missingPath = join(path, "en-missing", "translation.json");
        assert.isFalse(await exists(missingPath), "missing key is not existed, file will not be generated");
    });

    it('template string', async function () {
        const { path, plugin } = await initplugin.call(this, "_t", "basic", ["en"]);
        const stats = await runWebpack.call(this, {
            context: __dirname,
            entry: join(__dirname, "basic", "template_string.js"),
            plugins: [plugin]
        });

        if (stats.hasErrors()) {
            assert.fail(undefined, undefined, `Webpack error - ${stringify_errors(stats.compilation.getErrors())}`)
        }

        if (stats.hasWarnings()) {
            assert.fail(undefined, undefined, `There is no not translated messages. It should be having no warnings. - ${stringify_errors(stats.compilation.getWarnings())}`);
        }
        const missingPath = join(path, "en", "translation.json");
        assert.isFalse(await exists(missingPath), "missing key is not existed, file will not be generated");
    });
});