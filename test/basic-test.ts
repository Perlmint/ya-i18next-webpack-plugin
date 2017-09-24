import { dir } from 'tmp';
import { readFile as readFileAsync, PathLike, stat as statAsync } from 'fs';
import { promisify } from 'util';
import { join } from 'path';
import 'mocha';
import * as webpack from 'webpack';
import { assert } from 'chai';
import * as _ from 'lodash';
import Plugin from '../src/index';

const tmpdir = () => new Promise<[string, () => void]>((resolve, reject) => dir((err, path, cleanup) => {
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

async function initplugin(functionName: string, transltationPath: string, languages: string[], namespaces?: string[]) {
    const [path, cleanup] = await tmpdir();
    return {
        plugin: new Plugin({
            defaultLanguage: languages[0],
            languages,
            defaultNamespace: namespaces === undefined ? undefined : namespaces[0],
            namespaces,
            functionName,
            resourcePath: join(__dirname, transltationPath, "{{lng}}", "{{ns}}.json"),
            pathToSaveMissing: join(path, "{{lng}}", "{{ns}}.json")
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

async function runWebpack(config: webpack.Configuration) {
    const [path] = await tmpdir();
    return new Promise<webpack.Stats>((resolve, reject) =>
        webpack(_.merge(config, {
            output: {
                path
            }
        }), (err: Error, stats: webpack.Stats) => {
            if (err !== null) {
                return reject(err);
            } else {
                resolve(stats);
            }
        })
    );
}

describe('basic operation', () => {
    it('exists all', async () => {
        const { path, plugin } = await initplugin("_t", "basic", ["en"]);
        const stats = await runWebpack({
            context: __dirname,
            entry: join(__dirname, "basic", "simple.js"),
            plugins: [plugin]
        });

        assert.isFalse(stats.hasWarnings(), "not translated messages should occur warning");
        const missingPath = join(path, "en", "translation.json");
        assert.isFalse(await exists(missingPath), "missing key is not existed, file will not be generated");
    });

    it('not found', async () => {
        const { path, plugin } = await initplugin("_t", "basic", ["kr"]);
        const stats = await runWebpack({
            context: __dirname,
            entry: join(__dirname, "basic", "simple.js"),
            plugins: [plugin]
        });

        assert.isTrue(stats.hasWarnings(), "not translated messages should occur warning");
        const missingPath = join(path, "kr", "translation.json");
        const missings = await readJSONFile(missingPath);
        assert.equal(_.size(missings), 1, "Only one missing text here.");
        assert.isNotNull(missings["translated key"]);
        const pos = parsePos(missings["translated key"][0]);
        assert.deepEqual(pos, { resource: "basic/simple.js", line: 3, column: 6 });
    });

    it('complicated', async () => {
        const { path, plugin } = await initplugin("_t", "basic", ["en"]);
        const stats = await runWebpack({
            context: __dirname,
            entry: join(__dirname, "basic", "complicated.js"),
            plugins: [plugin]
        });

        assert.isTrue(stats.hasWarnings(), "not translated messages should occur warning");
        const missingPath = join(path, "en", "translation.json");
        assert.isFalse(await exists(missingPath), "missing key is not existed, file will not be generated");
    });
});